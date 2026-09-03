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
  'and never reward a mere keyword match. Answer with a verdict and one line of English',
  'justification. Be strict but literal: grade only what is asked, nothing else about the text.',
].join(' ');

/**
 * Fallback judge when the configured vendor has no key (ROADMAP D9). The strongest OpenAI
 * model in `MODEL_PRICES`; update it when a stronger one is priced there.
 */
export const JUDGE_FALLBACK_MODEL = 'gpt-5.4';

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
      temperature: spec.temperature ?? 0,
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
      const questions: Question[] = [
        ...factQuestions(expect.uses, 'uses', false, turn.reply, knowledge, 'the agent reply'),
        ...factQuestions(
          expect.must_not_use,
          'must_not_use',
          true,
          turn.reply,
          knowledge,
          'the agent reply',
        ),
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
        const text = memoryText(returned);
        return run([
          ...factQuestions(probe.expect.recalls, 'recalls', false, text, knowledge, subject, emptyWhy),
          ...factQuestions(
            probe.expect.must_not_recall,
            'must_not_recall',
            true,
            text,
            knowledge,
            subject,
            emptyWhy,
          ),
        ]);
      }

      const subject = 'the documentation proposals';
      if (returned === undefined) {
        return unserved('proposals()', keysFor(probe.expect.proposes, 'proposes'));
      }
      return run(
        factQuestions(
          probe.expect.proposes,
          'proposes',
          false,
          memoryText(returned),
          knowledge,
          subject,
          'there are no proposals',
        ),
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
  readonly criterion: { type: 'fact'; fact: string } | { type: 'rubric'; rubric: string };
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

function factQuestions(
  ids: readonly string[] | undefined,
  prefix: string,
  negated: boolean,
  text: string,
  knowledge: KnowledgeMap,
  subject: string,
  emptyWhy = 'the agent reply is empty',
): Question[] {
  return (ids ?? []).map((id) => {
    const item = knowledge[id];
    if (item === undefined) throw new Error(`Unknown knowledge item "${id}"`);
    return {
      key: `${prefix}:${id}`,
      negated,
      subject,
      text,
      criterion: { type: 'fact', fact: item.statement },
      emptyWhy,
    };
  });
}

/**
 * One template for both shapes. The judge is never told whether the expectation is positive
 * or negative, so `uses` and `must_not_use` on the same fact are graded by the same question.
 */
function buildPrompt(question: Question): string {
  const scale =
    question.criterion.type === 'fact'
      ? [
          'pass — the text conveys the fact, in any wording or language',
          'partial — the text gestures at the fact but is vague, hedged or incomplete',
          'fail — the text does not convey the fact, or contradicts it',
        ]
      : [
          'pass — the text satisfies the criteria',
          'partial — the text satisfies the criteria only in part',
          'fail — the text does not satisfy the criteria',
        ];
  const ask =
    question.criterion.type === 'fact'
      ? 'Does the TEXT convey this FACT?'
      : 'Does the TEXT satisfy these CRITERIA?';
  const criterion =
    question.criterion.type === 'fact'
      ? `FACT:\n${question.criterion.fact}`
      : `CRITERIA:\n${question.criterion.rubric}`;

  return [
    ask,
    '',
    criterion,
    '',
    `TEXT (${question.subject}):`,
    question.text,
    '',
    'Verdicts:',
    ...scale.map((line) => `- ${line}`),
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
