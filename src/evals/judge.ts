/**
 * The LLM judge: the checks a regex cannot decide — does this text *convey* a knowledge
 * statement, and does a free-text rubric hold.
 *
 * One question shape does most of the work: «FACT + TEXT → does the text convey the fact?».
 * `uses`, `must_not_use`, `recalls`, `must_not_recall` and `proposes` are all that question;
 * the negative ones invert the verdict afterwards, so a single prompt template stays the
 * single place where "conveys" is defined. `reply.rubric` is the one other shape.
 *
 * Every call records its full prompt in `CheckResult.judgePrompt` (evals/README §4), so a
 * disputed verdict can be audited without re-running the scenario.
 *
 * Judged text is the customer-facing reply, never the internal escalation reason: the README
 * defines `uses` over the reply, and scoring internal text would let an agent pass a fact
 * check with something the merchant never sees.
 */
import { generateText, type LanguageModel, Output } from 'ai';
import { z } from 'zod';

import {
  addUsage,
  API_KEY_ENV,
  costUsd as calculateCostUsd,
  type Env,
  hasApiKey,
  modelKey,
  resolveModel,
  type TokenUsage,
  tokenUsage,
  ZERO_USAGE,
} from '../llm/index.ts';
import { memoryText } from './checks.ts';
import {
  type CheckResult,
  type Expect,
  type KnowledgeItem,
  type MemoryItem,
  type ModelSpec,
  type Probe,
  type Verdict,
} from './schema.ts';
import type { TurnObservation } from './checks.ts';

/** The scenario's `knowledge` map: `K1` → the item whose statement is the fact being judged. */
export type KnowledgeMap = Readonly<Record<string, KnowledgeItem>>;

/** Checks plus what they cost; the runner adds the cost to the run total. */
export interface JudgedChecks {
  readonly checks: CheckResult[];
  readonly usage: TokenUsage;
  /** 0 when the judge made no call or the model has no price entry. */
  readonly costUsd: number;
}

export interface Judge {
  /** The model actually judging, recorded in the run result. Absent when nothing judges. */
  readonly spec?: ModelSpec;
  /** `uses`, `must_not_use` and `reply.rubric` for one `agent_turn`. */
  turn(
    expect: Expect | undefined,
    turn: TurnObservation,
    knowledge: KnowledgeMap,
  ): Promise<JudgedChecks>;
  /** `recalls` / `must_not_recall` for a memory probe, `proposes` for a proposals probe. */
  probe(
    probe: Probe,
    returned: readonly MemoryItem[] | undefined,
    knowledge: KnowledgeMap,
  ): Promise<JudgedChecks>;
}

export interface JudgeOptions {
  /** Direct model injection keeps unit tests offline; normal runs resolve the config's spec. */
  readonly model?: LanguageModel;
}

const EMPTY: JudgedChecks = { checks: [], usage: ZERO_USAGE, costUsd: 0 };

const JudgeVerdictSchema = z.strictObject({
  verdict: z.enum(['pass', 'partial', 'fail']),
  why: z.string().min(1).describe('One line, English, why this verdict'),
});
type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

const INSTRUCTIONS = [
  'You grade one output of a customer-support agent for an evaluation suite.',
  'The text may be Russian or English, and so may the fact: judge meaning, not wording,',
  'and never reward a mere keyword match. A fact is written out in full for the record; a',
  'support reply is short and is not expected to repeat it clause by clause, so grade whether',
  'the substance reached the reader, not how many details were restated. Answer with a',
  'verdict and one line of English justification. Be strict but literal: grade only what is',
  'asked, nothing else about the text.',
].join(' ');

/**
 * Fallback judge when the configured vendor has no key (ROADMAP D9). The strongest OpenAI
 * model in `MODEL_PRICES`; update it when a stronger one is priced there.
 */
export const JUDGE_FALLBACK_MODEL = 'gpt-5.6-sol';

export interface JudgeChoice {
  readonly spec: ModelSpec;
  /** Set when the configured judge was unavailable; the caller should surface it. */
  readonly warning?: string;
}

/**
 * D9 wants the judge on a different vendor than the agent, to avoid self-preference, but a
 * missing second key should degrade rather than block a run. Falling back means judge and
 * agent share a vendor, which §8 says to watch for — so the fallback is announced, and the
 * model that actually judged is recorded in the run result, not just in a console line.
 */
export function resolveJudgeSpec(configured: ModelSpec, env: Env = process.env): JudgeChoice {
  if (hasApiKey(configured.provider, env)) return { spec: configured };
  if (configured.provider !== 'openai' && hasApiKey('openai', env)) {
    const spec: ModelSpec = {
      provider: 'openai',
      model: JUDGE_FALLBACK_MODEL,
      ...(configured.temperature === undefined ? {} : { temperature: configured.temperature }),
    };
    return {
      spec,
      warning:
        `${API_KEY_ENV[configured.provider]} is not set: judging with ${modelKey(spec)} ` +
        `instead of ${modelKey(configured)}. Judge and agent now share a vendor; ` +
        'read the verdicts with self-preference in mind (ROADMAP §8).',
    };
  }
  // No usable key anywhere: let `createJudge` fail naming the configured model.
  return { spec: configured };
}

/**
 * The model is resolved eagerly so a missing judge key fails before any agent call is paid
 * for, rather than half-way through a matrix run.
 */
export function createJudge(spec: ModelSpec, options: JudgeOptions = {}): Judge {
  const model = options.model ?? resolveModel(spec);
  const ask = async (prompt: string): Promise<AskResult> => {
    const result = await generateText({
      model,
      ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
      instructions: INSTRUCTIONS,
      prompt,
      output: Output.object({ schema: JudgeVerdictSchema }),
    });
    const usage = tokenUsage(result.usage);
    return { value: result.output, usage, costUsd: calculateCostUsd(spec, usage) ?? 0 };
  };
  return { spec, ...judgeWith(ask) };
}

/**
 * A judge for configurations that cannot run one (no key for the judge provider): every
 * judged check is reported `skipped` with the reason, so the report shows the gap instead of
 * counting unjudged checks as passes.
 */
export function createSkipJudge(why: string): Judge {
  return judgeWith(async () => {
    throw new JudgeUnavailableError(why);
  });
}

export class JudgeUnavailableError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'JudgeUnavailableError';
  }
}

interface AskResult {
  readonly value: JudgeVerdict;
  readonly usage: TokenUsage;
  readonly costUsd: number;
}

type Ask = (prompt: string) => Promise<AskResult>;

function judgeWith(ask: Ask): Judge {
  const run = async (questions: readonly Question[]): Promise<JudgedChecks> => {
    if (questions.length === 0) return EMPTY;
    const checks: CheckResult[] = [];
    let usage = ZERO_USAGE;
    let costUsd = 0;

    for (const question of questions) {
      // Nothing to read: the answer is already known and a call would only cost money.
      if (question.text.trim() === '') {
        checks.push({
          key: question.key,
          verdict: question.negated ? 'pass' : 'fail',
          why: question.emptyWhy,
        });
        continue;
      }

      const prompt = buildPrompt(question);
      try {
        const answer = await ask(prompt);
        usage = addUsage(usage, answer.usage);
        costUsd += answer.costUsd;
        checks.push({
          key: question.key,
          verdict: question.negated ? invert(answer.value.verdict) : answer.value.verdict,
          why: answer.value.why,
          judgePrompt: prompt,
        });
      } catch (error) {
        // A judge outage is not a scenario failure: keep the expensive agent output and say so.
        checks.push({
          key: question.key,
          verdict: 'skipped',
          why: `judge unavailable: ${errorMessage(error)}`,
          judgePrompt: prompt,
        });
      }
    }
    return { checks, usage, costUsd };
  };

  return {
    async turn(expect, turn, knowledge) {
      if (expect === undefined) return EMPTY;
      const onTurn = { text: turn.reply, subject: 'the agent reply', temporalAsCurrent: true };
      const questions: Question[] = [
        ...factQuestions(expect.uses, knowledge, { ...onTurn, prefix: 'uses', negated: false }),
        ...factQuestions(expect.must_not_use, knowledge, {
          ...onTurn,
          prefix: 'must_not_use',
          negated: true,
        }),
      ];
      if (expect.reply?.rubric !== undefined) {
        questions.push({
          key: 'reply.rubric',
          negated: false,
          subject: 'the agent reply',
          text: turn.reply,
          criterion: { type: 'rubric', rubric: expect.reply.rubric },
          emptyWhy: 'the agent reply is empty',
        });
      }
      return run(questions);
    },

    async probe(probe, returned, knowledge) {
      if (probe.type === 'memory_recall') {
        const subject = 'what recall returned';
        const emptyWhy = 'recall returned nothing';
        if (returned === undefined) {
          return unserved('recall()', [
            ...keysFor(probe.expect.recalls, 'recalls'),
            ...keysFor(probe.expect.must_not_recall, 'must_not_recall'),
          ]);
        }
        const inMemory = { text: memoryText(returned), subject, emptyWhy };
        return run([
          ...factQuestions(probe.expect.recalls, knowledge, {
            ...inMemory,
            prefix: 'recalls',
            negated: false,
          }),
          ...factQuestions(probe.expect.must_not_recall, knowledge, {
            ...inMemory,
            prefix: 'must_not_recall',
            negated: true,
          }),
        ]);
      }

      const subject = 'the documentation proposals';
      if (returned === undefined) {
        return unserved('proposals()', keysFor(probe.expect.proposes, 'proposes'));
      }
      return run(
        factQuestions(probe.expect.proposes, knowledge, {
          prefix: 'proposes',
          negated: false,
          text: memoryText(returned),
          subject,
          emptyWhy: 'there are no proposals',
        }),
      );
    },
  };
}

interface Question {
  readonly key: string;
  /** The judge is always asked the positive question; `must_not_*` inverts the verdict. */
  readonly negated: boolean;
  readonly subject: string;
  readonly text: string;
  readonly criterion:
    /** `current`: ask whether the text asserts the fact as in force now, not merely mentions it. */
    | { type: 'fact'; fact: string; current: boolean }
    | { type: 'rubric'; rubric: string };
  /** Recorded instead of a verdict's `why` when the text is empty and no call is made. */
  readonly emptyWhy: string;
}

function keysFor(ids: readonly string[] | undefined, prefix: string): string[] {
  return (ids ?? []).map((id) => `${prefix}:${id}`);
}

/** The engine leaves `proposals()` (or a probe's data) unimplemented: `skipped`, never `fail`. */
function unserved(served: string, keys: readonly string[]): JudgedChecks {
  return {
    checks: keys.map((key) => ({
      key,
      verdict: 'skipped' as const,
      why: `${served} is not served by this engine`,
    })),
    usage: ZERO_USAGE,
    costUsd: 0,
  };
}

interface FactQuestionOptions {
  readonly prefix: string;
  readonly negated: boolean;
  readonly text: string;
  readonly subject: string;
  readonly emptyWhy?: string;
  /**
   * On an agent turn a temporal fact counts as used only when the reply asserts it as in
   * force now: a past-tense mention after `valid_until` is exactly what `must_not_use` allows.
   * Probes leave this off: they ask whether memory holds the statement, whatever its date.
   */
  readonly temporalAsCurrent?: boolean;
}

function factQuestions(
  ids: readonly string[] | undefined,
  knowledge: KnowledgeMap,
  options: FactQuestionOptions,
): Question[] {
  return (ids ?? []).map((id) => {
    const item = knowledge[id];
    if (item === undefined) throw new Error(`Unknown knowledge item "${id}"`);
    return {
      key: `${options.prefix}:${id}`,
      negated: options.negated,
      subject: options.subject,
      text: options.text,
      criterion: {
        type: 'fact',
        fact: item.statement,
        current: options.temporalAsCurrent === true && item.kind === 'temporal',
      },
      emptyWhy: options.emptyWhy ?? 'the agent reply is empty',
    };
  });
}

interface PromptShape {
  readonly ask: string;
  readonly heading: string;
  readonly body: string;
  readonly scale: readonly string[];
}

/**
 * The fact scales were calibrated on the 2026-09-04 smoke run of scenarios 2 and 3. Before it
 * the judge docked a complete reply for clauses it did not restate, counted a both-cases
 * answer («если у вас двухстадийная оплата…») as partly conveying a merchant's personal fact,
 * and read a past-tense mention of an expired incident as still conveying it. The M1-lite run
 * the same day added the mirror case: a durable fact that a later change superseded (the cause
 * of a bug, told next to the shipped fix) was graded as contradicted because the reply put it
 * in the past. Only a temporal fact has to hold now; any other fact told as former behaviour
 * is still conveyed, and only stating the opposite contradicts it.
 */
function promptShape(criterion: Question['criterion']): PromptShape {
  if (criterion.type === 'rubric') {
    return {
      ask: 'Does the TEXT satisfy these CRITERIA?',
      heading: 'CRITERIA',
      body: criterion.rubric,
      scale: [
        'pass — the text satisfies the criteria',
        'partial — the text satisfies the criteria only in part',
        'fail — the text does not satisfy the criteria',
      ],
    };
  }
  if (criterion.current) {
    return {
      ask: 'Does the TEXT assert this FACT as currently in force?',
      heading: 'FACT',
      body: criterion.fact,
      scale: [
        'pass — the text asserts the substance of the fact as true at the time of writing, in any wording or language; incidental details left out do not lower the verdict',
        'partial — the text asserts it as true now but hedged, or asserts only a fragment of it',
        'fail — the text does not convey the fact, contradicts it, or refers to it only as past, planned or no longer in effect',
      ],
    };
  }
  return {
    ask: 'Does the TEXT convey this FACT?',
    heading: 'FACT',
    body: criterion.fact,
    scale: [
      'pass — the text asserts the substance of the fact about its subject, in any wording or language, either as current or as how things were before a later change; incidental details left out do not lower the verdict',
      'partial — the text asserts the substance but hedged or conditionally, or asserts only a fragment of it',
      'fail — the text does not convey the fact or states the opposite; describing the fact as former behaviour is not the opposite. Text that would read the same without knowing the fact — a rule from the documentation, an answer covering every possible case, a mention of the topic — does not convey it',
    ],
  };
}

/**
 * One template for every shape. The judge is never told whether the expectation is positive
 * or negative, so `uses` and `must_not_use` on the same fact are graded by the same question.
 */
function buildPrompt(question: Question): string {
  const shape = promptShape(question.criterion);
  return [
    shape.ask,
    '',
    `${shape.heading}:`,
    shape.body,
    '',
    `TEXT (${question.subject}):`,
    question.text,
    '',
    'Verdicts:',
    ...shape.scale.map((line) => `- ${line}`),
  ].join('\n');
}

function invert(verdict: Exclude<Verdict, 'skipped'>): Verdict {
  if (verdict === 'pass') return 'fail';
  if (verdict === 'fail') return 'pass';
  return 'partial';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
