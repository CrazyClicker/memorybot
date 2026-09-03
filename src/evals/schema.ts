/**
 * Eval format v2 as zod schemas: scenario, config and results.
 *
 * The shape lives here. Cross-field rules (a monotonic clock, references that resolve,
 * `valid_until` on temporal items only, …) live in validate.ts: they need context the shape
 * does not have (the wiki page list, the file name) and they should report every problem at
 * once rather than stop at the first.
 *
 * ROADMAP principle 3: the engine's note schema is the eval's knowledge schema.
 * `MemoryItemSchema` is the one definition of a memory item; `src/memory/engine.ts`, the
 * `remember` tool and the `notes` engine's structured-output call derive their types from it.
 */
import { z } from 'zod';

import { type ModelRef, PROVIDERS, type TokenUsage } from '../llm/index.ts';

// ---- Vocabulary --------------------------------------------------------------------------

export const OUTCOMES = ['answer', 'ask', 'escalate'] as const;
export const OutcomeSchema = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof OutcomeSchema>;

/** Kinds a scenario declares. Memory items add `other` for whatever an engine extracts on its own. */
export const KNOWLEDGE_KINDS = ['personal', 'temporal', 'undocumented'] as const;
export const KnowledgeKindSchema = z.enum(KNOWLEDGE_KINDS);
export type KnowledgeKind = z.infer<typeof KnowledgeKindSchema>;

export const KindSchema = z.enum([...KNOWLEDGE_KINDS, 'other']);
export type Kind = z.infer<typeof KindSchema>;

export const ScopeSchema = z.enum(['customer', 'shared']);
export type Scope = z.infer<typeof ScopeSchema>;

export const VerdictSchema = z.enum(['pass', 'partial', 'fail', 'skipped']);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Ids of scenarios, steps, threads, customers, probes, configs and wiki pages. */
export const IdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'ids use lowercase letters, digits, "-" and "_"');

export const KnowledgeIdSchema = z.string().regex(/^K[1-9]\d*$/, 'knowledge ids are K1, K2, …');

/** An ISO 8601 timestamp with a timezone: `2026-08-26T09:00:00Z`. */
export const TimestampSchema = z.iso.datetime({ offset: true });

/** A bare date (`2026-09-10`, read as 00:00 UTC of that day) or a timestamp. */
export const DateOrTimestampSchema = z.union([z.iso.date(), TimestampSchema]);

/** Milliseconds since the epoch for anything `DateOrTimestampSchema` accepts. */
export function clockMs(value: string): number {
  return Date.parse(value);
}

// ---- Check patterns ----------------------------------------------------------------------

/**
 * A pattern in `reply.must`, `reply.must_not`, `escalation.reason_must` or a probe's
 * `must_not`: either `"/regex/flags"` or a plain substring matched case-insensitively.
 * `g` and `y` make a RegExp stateful across `.test()` calls, so they are rejected.
 */
const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/s;

export function patternProblem(pattern: string): string | undefined {
  const match = REGEX_LITERAL.exec(pattern);
  if (match === null) return undefined;
  const [, body = '', flags = ''] = match;
  const stateful = [...flags].filter((flag) => flag === 'g' || flag === 'y').join('');
  if (stateful !== '') return `flag "${stateful}" is not allowed (it makes the pattern stateful)`;
  try {
    new RegExp(body, flags);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

export const PatternSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const problem = patternProblem(value);
    if (problem !== undefined) {
      ctx.addIssue({ code: 'custom', message: `invalid pattern ${value}: ${problem}` });
    }
  });
export type Pattern = z.infer<typeof PatternSchema>;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The RegExp a pattern denotes; checks.ts tests replies with this, so both agree on the meaning. */
export function compilePattern(pattern: string): RegExp {
  const match = REGEX_LITERAL.exec(pattern);
  if (match !== null) {
    const [, body = '', flags = ''] = match;
    return new RegExp(body, flags);
  }
  return new RegExp(escapeRegExp(pattern), 'i');
}

// ---- Scenario ----------------------------------------------------------------------------

export const CustomerSchema = z.strictObject({
  name: z.string().min(1),
  /** Free text shown to the agent as the CRM record. */
  profile: z.string().optional(),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const WorldSchema = z.strictObject({
  knowledge_base: z.enum(['wiki', 'none']),
  clock: TimestampSchema,
  customers: z.record(IdSchema, CustomerSchema),
});
export type World = z.infer<typeof WorldSchema>;

export const KnowledgeItemSchema = z.strictObject({
  kind: KnowledgeKindSchema,
  /** A customer id or `product`. */
  about: IdSchema,
  scope: ScopeSchema.default('customer'),
  statement: z.string().min(1),
  /** Steps where the fact first becomes available: customer messages, human replies, coach notes. */
  source: z.array(IdSchema).min(1),
  /** Temporal items only, and required for them. */
  valid_until: DateOrTimestampSchema.optional(),
  /** Undocumented items only. */
  documentation_candidate: z.boolean().optional(),
});
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;

export const ReplyExpectSchema = z.strictObject({
  must: z.array(PatternSchema).optional(),
  must_not: z.array(PatternSchema).optional(),
  /** Free-text pass/partial/fail criteria for the judge, in English. */
  rubric: z.string().min(1).optional(),
});

export const ExpectSchema = z.strictObject({
  outcome: OutcomeSchema.optional(),
  /** Outcomes scored partial instead of fail. */
  tolerated: z.array(OutcomeSchema).optional(),
  escalation: z.strictObject({ reason_must: z.array(PatternSchema).optional() }).optional(),
  reply: ReplyExpectSchema.optional(),
  uses: z.array(KnowledgeIdSchema).optional(),
  must_not_use: z.array(KnowledgeIdSchema).optional(),
});
export type Expect = z.infer<typeof ExpectSchema>;

const stepBase = {
  id: IdSchema,
  /** Commentary for the human reader; the runner ignores it. */
  note: z.string().optional(),
};

export const CustomerMessageStepSchema = z.strictObject({
  ...stepBase,
  type: z.literal('customer_message'),
  thread: IdSchema,
  customer: IdSchema,
  at: TimestampSchema,
  content: z.string().min(1),
});

export const AgentTurnStepSchema = z.strictObject({
  ...stepBase,
  type: z.literal('agent_turn'),
  thread: IdSchema,
  /** Optional: the turn runs at the clock of the preceding step unless it says otherwise. */
  at: TimestampSchema.optional(),
  expect: ExpectSchema.optional(),
});

export const HumanReplyStepSchema = z.strictObject({
  ...stepBase,
  type: z.literal('human_reply'),
  thread: IdSchema,
  author: z.string().min(1),
  at: TimestampSchema,
  content: z.string().min(1),
});

export const CoachNoteStepSchema = z.strictObject({
  ...stepBase,
  type: z.literal('coach_note'),
  thread: IdSchema,
  author: z.string().min(1),
  at: TimestampSchema,
  /** `product` broadcasts the note to every customer: the runner stores it as memory scope `shared`. */
  scope: z.enum(['customer', 'product']).default('customer'),
  content: z.string().min(1),
});

export const WikiUpdateStepSchema = z.strictObject({
  ...stepBase,
  type: z.literal('wiki_update'),
  page: IdSchema,
  knowledge: z.array(KnowledgeIdSchema).min(1),
  at: TimestampSchema,
});

export const CloseTicketStepSchema = z.strictObject({
  ...stepBase,
  type: z.literal('close_ticket'),
  thread: IdSchema,
  at: TimestampSchema,
});

export const ConsolidateStepSchema = z.strictObject({
  ...stepBase,
  type: z.literal('consolidate'),
  at: TimestampSchema,
});

export const StepSchema = z.discriminatedUnion('type', [
  CustomerMessageStepSchema,
  AgentTurnStepSchema,
  HumanReplyStepSchema,
  CoachNoteStepSchema,
  WikiUpdateStepSchema,
  CloseTicketStepSchema,
  ConsolidateStepSchema,
]);
export type Step = z.infer<typeof StepSchema>;
export type StepType = Step['type'];
export type StepOf<T extends StepType> = Extract<Step, { type: T }>;
export type AgentTurnStep = StepOf<'agent_turn'>;
export type CustomerMessageStep = StepOf<'customer_message'>;
export type CoachNoteStep = StepOf<'coach_note'>;
export type WikiUpdateStep = StepOf<'wiki_update'>;

export const MemoryRecallProbeSchema = z.strictObject({
  id: IdSchema,
  type: z.literal('memory_recall'),
  note: z.string().optional(),
  customer: IdSchema,
  query: z.string().min(1),
  expect: z.strictObject({
    recalls: z.array(KnowledgeIdSchema).optional(),
    must_not_recall: z.array(KnowledgeIdSchema).optional(),
    must_not: z.array(PatternSchema).optional(),
  }),
});

export const DocumentationProposalsProbeSchema = z.strictObject({
  id: IdSchema,
  type: z.literal('documentation_proposals'),
  note: z.string().optional(),
  expect: z.strictObject({
    proposes: z.array(KnowledgeIdSchema).optional(),
    must_not: z.array(PatternSchema).optional(),
  }),
});

export const ProbeSchema = z.discriminatedUnion('type', [
  MemoryRecallProbeSchema,
  DocumentationProposalsProbeSchema,
]);
export type Probe = z.infer<typeof ProbeSchema>;
export type ProbeType = Probe['type'];
export type ProbeOf<T extends ProbeType> = Extract<Probe, { type: T }>;

export const ScenarioSchema = z.strictObject({
  /** Matches the file name. */
  id: IdSchema,
  title: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  world: WorldSchema,
  knowledge: z.record(KnowledgeIdSchema, KnowledgeItemSchema),
  steps: z.array(StepSchema).min(1),
  probes: z.array(ProbeSchema).optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

// ---- Config ------------------------------------------------------------------------------

export const ProviderSchema = z.enum(PROVIDERS);

export const MEMORY_ENGINES = ['none', 'naive', 'notes', 'mem0', 'xmemory'] as const;
export const MemoryEngineIdSchema = z.enum(MEMORY_ENGINES);
export type MemoryEngineId = z.infer<typeof MemoryEngineIdSchema>;

export const MemoryReadSchema = z.enum(['hydrate', 'tool', 'both']);
export type MemoryRead = z.infer<typeof MemoryReadSchema>;
export const MemoryWriteSchema = z.enum(['consolidate', 'agent', 'both']);
export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;

/** A `ModelRef` as a config names it, plus sampling settings. */
export const ModelSpecSchema = z.strictObject({
  provider: ProviderSchema,
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
}) satisfies z.ZodType<ModelRef>;
export type ModelSpec = z.infer<typeof ModelSpecSchema>;

export const ConfigSchema = z.strictObject({
  /** Matches the file name. */
  id: IdSchema,
  agent: ModelSpecSchema,
  memory: z.strictObject({
    engine: MemoryEngineIdSchema,
    read: MemoryReadSchema,
    write: MemoryWriteSchema,
  }),
  judge: ModelSpecSchema,
});
export type Config = z.infer<typeof ConfigSchema>;

// ---- Results -----------------------------------------------------------------------------

const count = z.number().int().min(0);

export const TokenUsageSchema = z.strictObject({
  inputTokens: count,
  uncachedInputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  outputTokens: count,
}) satisfies z.ZodType<TokenUsage>;

/** One memory item, as engines store it and results record it (ROADMAP §4). */
export const MemoryItemSchema = z.strictObject({
  id: z.string().min(1),
  kind: KindSchema,
  /** Customer id or `product`. */
  about: z.string().min(1),
  /** Customer whose thread produced it; the recall scope (ROADMAP principle 4). */
  learnedFrom: z.string().min(1),
  /** `shared` only from a coach note with `scope: product`. */
  scope: ScopeSchema,
  /** Russian, starts with the scenario date: «По состоянию на 2026-08-27: …». */
  statement: z.string().min(1),
  /** Temporal items only. */
  validUntil: DateOrTimestampSchema.optional(),
  documentationCandidate: z.boolean().optional(),
  source: z.strictObject({
    thread: z.string().min(1),
    step: z.string().optional(),
    via: z.enum(['agent', 'consolidate']),
  }),
  /** Scenario clock, not wall clock. */
  createdAt: TimestampSchema,
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const CheckResultSchema = z.strictObject({
  /** `outcome`, `reply.must[0]`, `escalation.reason_must[1]`, `uses:K3`, `recalls:K1`, … */
  key: z.string().min(1),
  verdict: VerdictSchema,
  why: z.string().optional(),
  /** Present when a judge produced the verdict, so a disputed one can be audited. */
  judgePrompt: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const ToolCallSchema = z.strictObject({
  tool: z.string().min(1),
  input: z.unknown(),
  output: z.unknown().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** One AI SDK step of an agent turn: what the model said, what it called, what it cost. */
export const TraceStepSchema = z.strictObject({
  step: z.number().int().min(1),
  text: z.string().optional(),
  toolCalls: z.array(ToolCallSchema),
  usage: TokenUsageSchema,
});
export type TraceStep = z.infer<typeof TraceStepSchema>;

export const StepResultSchema = z.strictObject({
  /** The `agent_turn` step id. */
  id: IdSchema,
  thread: IdSchema,
  /** Scenario clock at the turn. */
  at: TimestampSchema,
  outcome: OutcomeSchema,
  /** Customer-facing, Russian. */
  reply: z.string(),
  /** Internal. */
  escalationReason: z.string().optional(),
  trace: z.array(TraceStepSchema),
  /** Written through the `remember` tool during this turn. */
  memoryWrites: z.array(MemoryItemSchema),
  checks: z.array(CheckResultSchema),
  usage: TokenUsageSchema,
  /** Undefined when the model has no price entry. */
  costUsd: z.number().min(0).optional(),
  latencyMs: z.number().min(0),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const ConsolidationResultSchema = z.strictObject({
  id: IdSchema,
  at: TimestampSchema,
  wrote: z.array(MemoryItemSchema),
});
export type ConsolidationResult = z.infer<typeof ConsolidationResultSchema>;

export const ProbeResultSchema = z.strictObject({
  id: IdSchema,
  checks: z.array(CheckResultSchema),
  /** What `recall` or `proposals` returned; absent when the engine could not serve the probe. */
  returned: z.array(MemoryItemSchema).optional(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

/** Counts, not a single number: which step failed is the finding. */
export const ScoreSchema = z.strictObject({
  pass: count,
  partial: count,
  fail: count,
  skipped: count,
});
export type Score = z.infer<typeof ScoreSchema>;

/** One scenario × one config × one repeat: `evals/results/<run-id>/<scenario>.<config>.<repeat>.json`. */
export const RunResultSchema = z.strictObject({
  scenario: IdSchema,
  config: IdSchema,
  repeat: z.number().int().min(1),
  /** Wall clock. */
  startedAt: TimestampSchema,
  /** The model that actually judged; absent when nothing did (D9 fallback makes these differ). */
  judge: ModelSpecSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  steps: z.array(StepResultSchema),
  consolidations: z.array(ConsolidationResultSchema),
  probes: z.array(ProbeResultSchema),
  score: ScoreSchema,
  /** Agent and judge calls only; what a hosted engine spends inside its own API is not visible here. */
  costUsd: z.number().min(0),
  /** Set when the run stopped early; the steps before the failure are still recorded. */
  error: z.string().optional(),
});
export type RunResult = z.infer<typeof RunResultSchema>;
