import {
  generateText,
  hasToolCall,
  isStepCount,
  type LanguageModel,
  type StepResult as AiStepResult,
  tool,
  type ToolSet,
} from 'ai';
import { z } from 'zod';

import {
  DateOrTimestampSchema,
  KindSchema,
  OutcomeSchema,
  type Outcome,
  type ToolCall,
  type TraceStep,
} from '../evals/schema.ts';
import {
  addUsage,
  costUsd as calculateCostUsd,
  type ModelRef,
  resolveModel,
  type TokenUsage,
  tokenUsage,
} from '../llm/index.ts';
import {
  canRecall,
  cloneMemoryItem,
  dateStatement,
  type MemoryItem,
  type ThreadTranscript,
} from '../memory/index.ts';
import { createWikiTools, type Wiki } from '../wiki/index.ts';
import { type AgentCustomer, buildSystemPrompt, renderThread } from './prompt.ts';

export const MAX_AGENT_STEPS = 8;

/**
 * The model occasionally answers in plain text and stops without calling `finish`. One nudge
 * turns that flake into a normal turn instead of a run that dies after the paid steps; the
 * extra steps stay in the trace, so the nudge is visible in the results.
 */
export const FINISH_NUDGE =
  'Ход не завершён: вызови инструмент `finish` с outcome и полным ответом клиенту. ' +
  'Если ответ уже написан выше, повтори его в `finish.reply`.';
const NUDGE_STEPS = 2;

export interface AgentModelRef extends ModelRef {
  readonly temperature?: number;
}

export interface TurnInput {
  readonly now: string;
  readonly customer: AgentCustomer;
  readonly thread: ThreadTranscript;
  /** Scoped recall results. They are put in the prompt and/or served by `recall_memory`. */
  readonly memory: readonly MemoryItem[];
  readonly tools: {
    readonly recallMemory: boolean;
    readonly remember: boolean;
  };
  readonly wiki: Wiki;
  readonly model: AgentModelRef;
}

export interface TurnResult {
  readonly outcome: Outcome;
  readonly reply: string;
  readonly escalationReason?: string;
  readonly memoryWrites: MemoryItem[];
  readonly trace: TraceStep[];
  readonly usage: TokenUsage;
  readonly costUsd?: number;
  readonly latencyMs: number;
}

export type RecallMemory = (
  customer: string,
  query: string,
  now: string,
) => Promise<readonly MemoryItem[]>;

export interface RunTurnOptions {
  /** Direct model injection keeps unit tests offline; normal runs resolve `input.model`. */
  readonly model?: LanguageModel;
  /** A live engine recall callback. Without it the tool returns the supplied scoped snapshot. */
  readonly recallMemory?: RecallMemory;
  /** Monotonic milliseconds, injectable for deterministic latency tests. */
  readonly nowMs?: () => number;
}

interface FinishValue {
  readonly outcome: Outcome;
  readonly reply: string;
  readonly escalation_reason?: string;
}

interface ToolState {
  finish?: FinishValue;
  readonly memoryWrites: MemoryItem[];
}

export class AgentDidNotFinishError extends Error {
  constructor(
    readonly steps: number,
    readonly finishReason: string,
  ) {
    super(`Agent did not call finish within ${steps} step(s); last finish reason: ${finishReason}`);
    this.name = 'AgentDidNotFinishError';
  }
}

export async function runTurn(input: TurnInput, options: RunTurnOptions = {}): Promise<TurnResult> {
  const state: ToolState = { memoryWrites: [] };
  const tools = createAgentTools(input, state, options.recallMemory);
  const nowMs = options.nowMs ?? (() => performance.now());
  const startedAt = nowMs();

  const model = options.model ?? resolveModel(input.model);
  const temperature = input.model.temperature === undefined ? {} : { temperature: input.model.temperature };
  const instructions = buildSystemPrompt({
    now: input.now,
    customer: input.customer,
    memory: input.memory,
    wiki: input.wiki,
    recallMemoryEnabled: input.tools.recallMemory,
    rememberEnabled: input.tools.remember,
  });
  const threadPrompt = renderThread(input.thread);

  const result = await generateText({
    model,
    ...temperature,
    instructions,
    prompt: threadPrompt,
    tools,
    stopWhen: [hasToolCall('finish'), isStepCount(MAX_AGENT_STEPS)],
  });
  const steps: AiStepResult<ToolSet>[] = [...result.steps];
  let usage = tokenUsage(result.usage);
  let finishReason: string = result.finalStep.finishReason;

  if (state.finish === undefined && finishReason === 'stop') {
    const nudged = await generateText({
      model,
      ...temperature,
      instructions,
      messages: [
        { role: 'user', content: threadPrompt },
        ...result.response.messages,
        { role: 'user', content: FINISH_NUDGE },
      ],
      tools,
      stopWhen: [hasToolCall('finish'), isStepCount(NUDGE_STEPS)],
    });
    steps.push(...nudged.steps);
    usage = addUsage(usage, tokenUsage(nudged.usage));
    finishReason = nudged.finalStep.finishReason;
  }
  const latencyMs = Math.max(0, nowMs() - startedAt);

  if (state.finish === undefined) {
    throw new AgentDidNotFinishError(steps.length, finishReason);
  }

  const costUsd = calculateCostUsd(input.model, usage);
  return {
    outcome: state.finish.outcome,
    reply: state.finish.reply,
    ...(state.finish.escalation_reason === undefined
      ? {}
      : { escalationReason: state.finish.escalation_reason }),
    memoryWrites: state.memoryWrites.map(cloneMemoryItem),
    trace: steps.map((step, index) => traceStep(step, index + 1)),
    usage,
    ...(costUsd === undefined ? {} : { costUsd }),
    latencyMs,
  };
}

function createAgentTools(
  input: TurnInput,
  state: ToolState,
  recallMemory: RecallMemory | undefined,
): ToolSet {
  const finish = tool({
    description: 'Завершить ход агента и вернуть единственный клиентский ответ и outcome.',
    inputSchema: z.strictObject({
      outcome: OutcomeSchema,
      reply: z.string().min(1).describe('Полный текст ответа клиенту на языке его обращения'),
      escalation_reason: z.string().min(1).optional().describe('Внутренняя причина эскалации'),
    }),
    execute: async (value) => {
      if (state.finish !== undefined) return { accepted: false, reason: 'finish уже был вызван' };
      state.finish = value;
      return { accepted: true };
    },
  });

  const optionalTools: ToolSet = {};
  if (input.tools.recallMemory) {
    optionalTools['recall_memory'] = tool({
      description: 'Найти релевантные заметки памяти для текущего клиента.',
      inputSchema: z.strictObject({ query: z.string().min(1).describe('Что нужно вспомнить') }),
      execute: async ({ query }) => {
        const items = recallMemory === undefined
          ? input.memory
          : await recallMemory(input.customer.id, query, input.now);
        const nowMs = Date.parse(input.now);
        return items
          .filter((item) => canRecall(item, input.customer.id))
          .map((item) => ({
            ...cloneMemoryItem(item),
            status: item.validUntil === undefined
              ? 'not_applicable'
              : Date.parse(item.validUntil) < nowMs
                ? 'expired'
                : 'active',
          }));
      },
    });
  }

  if (input.tools.remember) {
    optionalTools['remember'] = tool({
      description: 'Подготовить к сохранению новый факт из текущего обращения. Scope всегда customer.',
      inputSchema: z.strictObject({
        kind: KindSchema,
        about: z
          .union([z.literal(input.customer.id), z.literal('product')])
          .describe('ID текущего клиента или product'),
        statement: z.string().min(1).describe('Факт без добавленного префикса даты'),
        valid_until: DateOrTimestampSchema.optional().describe('ISO-дата или timestamp для временного факта'),
      }),
      execute: async ({ kind, about, statement, valid_until }) => {
        const memoryItem: MemoryItem = {
          id: `agent-${input.thread.id}-${state.memoryWrites.length + 1}`,
          kind,
          about,
          learnedFrom: input.customer.id,
          scope: 'customer',
          statement: dateStatement(statement, input.now),
          ...(valid_until === undefined ? {} : { validUntil: valid_until }),
          ...(kind === 'undocumented' && about === 'product'
            ? { documentationCandidate: true }
            : {}),
          source: { thread: input.thread.id, via: 'agent' },
          createdAt: input.now,
        };
        state.memoryWrites.push(memoryItem);
        return cloneMemoryItem(memoryItem);
      },
    });
  }

  return { ...createWikiTools(input.wiki), ...optionalTools, finish };
}

/** `number` is the position in the whole turn: a nudged continuation restarts the SDK's count. */
function traceStep(step: AiStepResult<ToolSet>, number: number): TraceStep {
  return {
    step: number,
    ...(step.text === '' ? {} : { text: step.text }),
    toolCalls: traceToolCalls(step),
    usage: tokenUsage(step.usage),
  };
}

function traceToolCalls(
  step: Pick<AiStepResult<ToolSet>, 'content' | 'toolCalls' | 'toolResults'>,
): ToolCall[] {
  const results = new Map(step.toolResults.map((result) => [result.toolCallId, result.output]));
  const errors = new Map(
    step.content
      .filter((part) => part.type === 'tool-error')
      .map((part) => [part.toolCallId, { error: errorMessage(part.error) }]),
  );
  return step.toolCalls.map((call) => {
    const hasResult = results.has(call.toolCallId);
    const error = errors.get(call.toolCallId);
    return {
      tool: call.toolName,
      input: call.input,
      ...(hasResult ? { output: results.get(call.toolCallId) } : error === undefined ? {} : { output: error }),
    };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
