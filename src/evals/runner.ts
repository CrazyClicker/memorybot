import type { LanguageModel } from 'ai';

import { runTurn, type RunTurnOptions, type TurnInput, type TurnResult } from '../agent/index.ts';
import {
  canRecall,
  cloneMemoryItem,
  createMem0MemoryEngine,
  createNaiveMemoryEngine,
  createNoneMemoryEngine,
  createNotesMemoryEngine,
  createXmemoryMemoryEngine,
  dateStatement,
  type MemoryEngine,
  type MemoryItem,
  type Mem0Client,
  type XmemoryClient,
  type ThreadEvent,
  type ThreadTranscript,
} from '../memory/index.ts';
import { loadWiki, Wiki } from '../wiki/index.ts';
import { checkProbePatterns, checkTurn, scoreOf } from './checks.ts';
import { createSkipJudge, type Judge } from './judge.ts';
import type {
  CheckResult,
  Config,
  ConsolidationError,
  ProbeResult,
  RunResult,
  Scenario,
  Step,
  StepResult,
} from './schema.ts';

export type RunAgent = (
  input: TurnInput,
  options?: RunTurnOptions,
) => Promise<TurnResult>;

export interface RunScenarioOptions {
  readonly engine: MemoryEngine;
  /**
   * Scores `uses`, `must_not_use`, `reply.rubric` and the knowledge side of the probes.
   * Without one every judged check is reported `skipped` with that reason: a run never
   * counts an unjudged check as a pass. `pnpm eval run` always supplies a real judge.
   */
  readonly judge?: Judge;
  /** Source snapshot. The runner clones it so `wiki_update` never escapes this run. */
  readonly wiki?: Wiki;
  readonly repeat?: number;
  readonly runAgent?: RunAgent;
  /** Wall clock used only for result metadata, never for scenario decisions. */
  readonly wallClock?: () => Date;
  /** Recorded in the result: a run made with the LLM disk cache on replays identical calls. */
  readonly cached?: boolean;
}

export type RepeatScenarioOptions = Omit<RunScenarioOptions, 'repeat'>;

interface RunState {
  now: string;
  readonly threads: Map<string, ThreadTranscript>;
  readonly consolidatedEventCounts: Map<string, number>;
  readonly steps: StepResult[];
  readonly consolidations: RunResult['consolidations'];
  readonly probes: ProbeResult[];
  costUsd: number;
}

export interface CreateMemoryEngineOptions {
  /** Direct model injection keeps factory-level notes tests offline. */
  readonly model?: LanguageModel;
  /** Direct client injection keeps factory-level mem0 tests offline. */
  readonly mem0Client?: Mem0Client;
  /** Direct client injection keeps factory-level xmemory tests offline. */
  readonly xmemoryClient?: XmemoryClient;
}

/** Build an engine from the complete config because structured extraction uses its agent model. */
export function createMemoryEngine(
  config: Config,
  options: CreateMemoryEngineOptions = {},
): MemoryEngine {
  switch (config.memory.engine) {
    case 'none':
      return createNoneMemoryEngine();
    case 'naive':
      return createNaiveMemoryEngine();
    case 'notes':
      return createNotesMemoryEngine({ modelSpec: config.agent, model: options.model });
    case 'mem0': {
      if (config.agent.provider !== 'openai') {
        throw new Error('mem0 comparison requires an OpenAI agent model for like-for-like extraction');
      }
      return createMem0MemoryEngine({
        client: options.mem0Client,
        llmModel: config.agent.model,
      });
    }
    case 'xmemory':
      return createXmemoryMemoryEngine({ client: options.xmemoryClient });
  }
}

/**
 * Execute one scenario × config × repeat. Runtime failures are returned in `error` together
 * with every completed result before the failure, which keeps expensive partial runs useful.
 */
export async function runScenario(
  scenario: Scenario,
  config: Config,
  options: RunScenarioOptions,
): Promise<RunResult> {
  const repeat = options.repeat ?? 1;
  assertRepeat(repeat);

  const wallClock = options.wallClock ?? (() => new Date());
  const startedAt = wallTime(wallClock);
  const state: RunState = {
    now: scenario.world.clock,
    threads: new Map(),
    consolidatedEventCounts: new Map(),
    steps: [],
    consolidations: [],
    probes: [],
    costUsd: 0,
  };

  const judge = options.judge ?? createSkipJudge('no judge configured for this run');
  try {
    await options.engine.reset();
    const wiki = await wikiForRun(scenario, options.wiki);
    for (const step of scenario.steps) {
      if (step.at !== undefined) state.now = step.at;
      await executeStep(
        step,
        scenario,
        config,
        options.engine,
        wiki,
        state,
        options.runAgent ?? runTurn,
        judge,
      );
    }
    await executeProbes(scenario, options.engine, state, judge);
  } catch (error) {
    return result(
      state,
      scenario,
      config,
      repeat,
      startedAt,
      wallTime(wallClock),
      judge,
      options.engine,
      options.cached,
      errorMessage(error),
    );
  }

  return result(
    state,
    scenario,
    config,
    repeat,
    startedAt,
    wallTime(wallClock),
    judge,
    options.engine,
    options.cached,
  );
}

/** Sequential repeats deliberately reuse the adapter: `reset()` must prove each run is fresh. */
export async function runScenarioRepeats(
  scenario: Scenario,
  config: Config,
  repeats: number,
  options: RepeatScenarioOptions,
): Promise<RunResult[]> {
  assertRepeat(repeats);
  const results: RunResult[] = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    results.push(await runScenario(scenario, config, { ...options, repeat }));
  }
  return results;
}

async function executeStep(
  step: Step,
  scenario: Scenario,
  config: Config,
  engine: MemoryEngine,
  wiki: Wiki,
  state: RunState,
  runAgent: RunAgent,
  judge: Judge,
): Promise<void> {
  switch (step.type) {
    case 'customer_message': {
      let thread = state.threads.get(step.thread);
      if (thread === undefined) {
        thread = { id: step.thread, customer: step.customer, events: [] };
        state.threads.set(step.thread, thread);
      } else if (thread.customer !== step.customer) {
        throw new Error(`Thread "${step.thread}" belongs to "${thread.customer}", not "${step.customer}"`);
      } else if (thread.closedAt !== undefined) {
        throw new Error(`Thread "${step.thread}" is already closed`);
      }
      thread.events.push({ type: 'customer_message', at: step.at, content: step.content });
      return;
    }

    case 'agent_turn': {
      const thread = requireOpenThread(state, step.thread);
      const query = latestCustomerMessage(thread);
      const recall = async (customer: string, queryText: string, now: string): Promise<MemoryItem[]> =>
        scopedRecall(engine, customer, queryText, now);
      const memory = config.memory.read === 'tool'
        ? []
        : await recall(thread.customer, query, state.now);
      const customer = scenario.world.customers[thread.customer];
      if (customer === undefined) throw new Error(`Unknown customer "${thread.customer}"`);

      const turn = await runAgent(
        {
          now: state.now,
          customer: { id: thread.customer, ...customer },
          thread: cloneThread(thread),
          memory,
          tools: {
            recallMemory: config.memory.read !== 'hydrate',
            remember: config.memory.write !== 'consolidate',
          },
          wiki,
          model: config.agent,
        },
        { recallMemory: recall },
      );

      thread.events.push({ type: 'agent_reply', at: state.now, content: turn.reply });
      const memoryWrites = turn.memoryWrites.map((item, index) =>
        agentWrite(item, thread, step.id, index, state.now),
      );
      // Deterministic checks first (free), then the judged ones: that is also the order the
      // report reads them in. Every expectation gets a verdict; neither gates the other.
      const checks = checkTurn(step.expect, turn);
      const judged = await judge.turn(step.expect, turn, scenario.knowledge);
      state.steps.push({
        id: step.id,
        thread: step.thread,
        at: state.now,
        outcome: turn.outcome,
        reply: turn.reply,
        ...(turn.escalationReason === undefined ? {} : { escalationReason: turn.escalationReason }),
        trace: turn.trace,
        memoryWrites,
        checks: [...checks, ...judged.checks],
        usage: turn.usage,
        ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
        latencyMs: turn.latencyMs,
      });
      state.costUsd += (turn.costUsd ?? 0) + judged.costUsd;
      if (memoryWrites.length > 0) await engine.write(memoryWrites, state.now);
      return;
    }

    case 'human_reply': {
      const thread = requireOpenThread(state, step.thread);
      thread.events.push({
        type: 'human_reply',
        at: step.at,
        author: step.author,
        content: step.content,
      });
      return;
    }

    case 'coach_note': {
      const thread = requireThread(state, step.thread);
      thread.events.push({
        type: 'coach_note',
        at: step.at,
        author: step.author,
        scope: step.scope,
        content: step.content,
      });
      return;
    }

    case 'close_ticket': {
      requireOpenThread(state, step.thread).closedAt = step.at;
      return;
    }

    case 'wiki_update': {
      const statements = step.knowledge.map((id) => {
        const item = scenario.knowledge[id];
        if (item === undefined) throw new Error(`Unknown knowledge item "${id}"`);
        return item.statement;
      });
      wiki.update(step.page, statements.join('\n\n'), state.now);
      return;
    }

    case 'consolidate': {
      const wrote: MemoryItem[] = [];
      const errors: ConsolidationError[] = [];
      const costBefore = engine.usage?.().costUsd;
      for (const thread of state.threads.values()) {
        const previousCount = state.consolidatedEventCounts.get(thread.id) ?? 0;
        if (thread.events.length === previousCount) continue;

        const transcript = config.memory.write === 'agent'
          ? coachNotesSince(thread, previousCount)
          : cloneThread(thread);
        try {
          const items = await engine.consolidate(transcript, state.now);
          wrote.push(...items.map(cloneMemoryItem));
          state.consolidatedEventCounts.set(thread.id, thread.events.length);
        } catch (error) {
          // The engine wrote nothing for this thread: a memory gap the later checks measure,
          // not a reason to abandon the paid turns around it. The thread stays pending, so the
          // next consolidate step offers it again.
          errors.push({ thread: thread.id, error: errorMessage(error) });
        }
      }
      const costAfter = engine.usage?.().costUsd;
      const engineCost = costBefore === undefined || costAfter === undefined
        ? undefined
        : Math.max(0, costAfter - costBefore);
      state.consolidations.push({
        id: step.id,
        at: state.now,
        wrote,
        ...(engineCost === undefined ? {} : { costUsd: engineCost }),
        ...(errors.length === 0 ? {} : { errors }),
      });
      state.costUsd += engineCost ?? 0;
      return;
    }
  }
}

async function executeProbes(
  scenario: Scenario,
  engine: MemoryEngine,
  state: RunState,
  judge: Judge,
): Promise<void> {
  for (const probe of scenario.probes ?? []) {
    // `undefined` is "the engine cannot serve this", which checks and judge report as skipped.
    const returned = probe.type === 'memory_recall'
      ? await scopedRecall(engine, probe.customer, probe.query, state.now)
      : engine.proposals === undefined
        ? undefined
        : (await engine.proposals()).map(cloneMemoryItem);

    const judged = await judge.probe(probe, returned, scenario.knowledge);
    state.costUsd += judged.costUsd;
    state.probes.push({
      id: probe.id,
      checks: [...checkProbePatterns(probe, returned), ...judged.checks],
      ...(returned === undefined ? {} : { returned }),
    });
  }
}

async function scopedRecall(
  engine: MemoryEngine,
  customer: string,
  query: string,
  now: string,
): Promise<MemoryItem[]> {
  return (await engine.recall(customer, query, now))
    .filter((item) => canRecall(item, customer))
    .map(cloneMemoryItem);
}

function agentWrite(
  item: MemoryItem,
  thread: ThreadTranscript,
  step: string,
  index: number,
  now: string,
): MemoryItem {
  return {
    ...cloneMemoryItem(item),
    id: `agent-${thread.id}-${step}-${index + 1}`,
    learnedFrom: thread.customer,
    scope: 'customer',
    statement: dateStatement(item.statement, now),
    source: { thread: thread.id, step, via: 'agent' },
    createdAt: now,
  };
}

function coachNotesSince(thread: ThreadTranscript, eventIndex: number): ThreadTranscript {
  return {
    id: thread.id,
    customer: thread.customer,
    events: thread.events.slice(eventIndex).filter((event) => event.type === 'coach_note').map(cloneEvent),
    ...(thread.closedAt === undefined ? {} : { closedAt: thread.closedAt }),
  };
}

function cloneThread(thread: ThreadTranscript): ThreadTranscript {
  return {
    id: thread.id,
    customer: thread.customer,
    events: thread.events.map(cloneEvent),
    ...(thread.closedAt === undefined ? {} : { closedAt: thread.closedAt }),
  };
}

function cloneEvent(event: ThreadEvent): ThreadEvent {
  return { ...event };
}

function requireThread(state: RunState, id: string): ThreadTranscript {
  const thread = state.threads.get(id);
  if (thread === undefined) throw new Error(`Unknown thread "${id}"`);
  return thread;
}

function requireOpenThread(state: RunState, id: string): ThreadTranscript {
  const thread = requireThread(state, id);
  if (thread.closedAt !== undefined) throw new Error(`Thread "${id}" is already closed`);
  return thread;
}

function latestCustomerMessage(thread: ThreadTranscript): string {
  for (let index = thread.events.length - 1; index >= 0; index -= 1) {
    const event = thread.events[index];
    if (event?.type === 'customer_message') return event.content;
  }
  throw new Error(`Thread "${thread.id}" has no customer message`);
}

async function wikiForRun(scenario: Scenario, source: Wiki | undefined): Promise<Wiki> {
  if (scenario.world.knowledge_base === 'none') return new Wiki([]);
  const canonical = source ?? await loadWiki();
  return new Wiki(canonical.pages, { search: canonical.searchEnabled });
}

function result(
  state: RunState,
  scenario: Scenario,
  config: Config,
  repeat: number,
  startedAt: string,
  finishedAt: string,
  judge: Judge,
  engine: MemoryEngine,
  cached?: boolean,
  error?: string,
): RunResult {
  const memoryDiagnostics = engine.diagnostics?.();
  return {
    scenario: scenario.id,
    config: config.id,
    repeat,
    startedAt,
    ...(judge.spec === undefined ? {} : { judge: judge.spec }),
    finishedAt,
    steps: state.steps,
    consolidations: state.consolidations,
    probes: state.probes,
    score: scoreOf(allChecks(state)),
    costUsd: state.costUsd,
    ...(cached === undefined ? {} : { cached }),
    ...(memoryDiagnostics === undefined
      ? {}
      : {
          memoryDiagnostics: {
            calls: { ...memoryDiagnostics.calls },
            traces: memoryDiagnostics.traces.map((trace) => ({ ...trace })),
          },
        }),
    ...(error === undefined ? {} : { error }),
  };
}

function allChecks(state: RunState): CheckResult[] {
  return [
    ...state.steps.flatMap((step) => step.checks),
    ...state.probes.flatMap((probe) => probe.checks),
  ];
}

function assertRepeat(repeat: number): void {
  if (!Number.isSafeInteger(repeat) || repeat < 1) {
    throw new Error(`Repeat must be a positive safe integer, got ${repeat}`);
  }
}

function wallTime(clock: () => Date): string {
  return clock().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
