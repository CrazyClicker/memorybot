import type { MemoryItem } from '../evals/schema.ts';
import type { TokenUsage } from '../llm/index.ts';

/** Keep one canonical knowledge/memory vocabulary: the eval schema owns these types. */
export type { Kind, MemoryItem } from '../evals/schema.ts';

export const THREAD_EVENT_TYPES = [
  'customer_message',
  'agent_reply',
  'human_reply',
  'coach_note',
] as const;

export type ThreadEventType = (typeof THREAD_EVENT_TYPES)[number];

export interface ThreadEvent {
  type: ThreadEventType;
  at: string;
  author?: string;
  /** Meaningful only for coach notes; only `product` may create shared memory. */
  scope?: 'customer' | 'product';
  content: string;
}

export interface ThreadTranscript {
  id: string;
  customer: string;
  events: ThreadEvent[];
  closedAt?: string;
}

export interface MemoryEngine {
  readonly id: string;
  /** Clear all state before a scenario run. */
  reset(): Promise<void>;
  /** Return shared items plus items belonging to or learned from this customer. */
  recall(customer: string, query: string, now: string): Promise<MemoryItem[]>;
  /** Store explicit items produced by the agent's `remember` tool. */
  write(items: MemoryItem[], now: string): Promise<void>;
  /** Extract or append memory from a transcript and return the items written. */
  consolidate(thread: ThreadTranscript, now: string): Promise<MemoryItem[]>;
  /** Engines that cannot serve documentation proposals leave this undefined. */
  proposals?(): Promise<MemoryItem[]>;
  /** Cumulative observable engine-side LLM use since reset; hosted adapters may omit this. */
  usage?(): MemoryEngineUsage;
  /** Hosted adapters expose operation counts and trace links instead of token usage. */
  diagnostics?(): MemoryEngineDiagnostics;
  /** Release per-run remote resources; unlike reset, this targets only resources this object owns. */
  cleanup?(): Promise<void>;
}

export interface MemoryEngineUsage {
  readonly usage: TokenUsage;
  /** Absent when the extraction model has no catalogue price. */
  readonly costUsd?: number;
}

export interface MemoryEngineTrace {
  readonly operation: 'create' | 'read' | 'write' | 'delete';
  readonly scope?: string;
  readonly instanceId?: string;
  readonly traceId?: string;
  readonly consoleUrl?: string;
}

export interface MemoryEngineDiagnostics {
  readonly calls: {
    readonly creates: number;
    readonly reads: number;
    readonly writes: number;
    readonly deletes: number;
  };
  readonly traces: readonly MemoryEngineTrace[];
}

/** Runtime check used by engine implementations and later by the runner. */
export function canRecall(item: MemoryItem, customer: string): boolean {
  return item.scope === 'shared' || item.about === customer || item.learnedFrom === customer;
}

/** A writer's own date prefix, with or without the colon the canonical form uses. */
const WRITER_DATE_PREFIX = /^По состоянию на (\d{4}-\d{2}-\d{2})(?:T[0-9:.Z+-]*)?:?\s*/u;

/**
 * Prefix a write with the scenario date. A statement the writer already dated keeps its own
 * date and is normalised to the canonical `По состоянию на YYYY-MM-DD: …` form: the agent's
 * `remember` tool sometimes writes the prefix itself, and without the colon it used to be
 * dated twice.
 */
export function dateStatement(statement: string, now: string): string {
  const trimmed = statement.trim();
  const dated = WRITER_DATE_PREFIX.exec(trimmed);
  if (dated?.[1] !== undefined) {
    return `По состоянию на ${dated[1]}: ${trimmed.slice(dated[0].length)}`;
  }
  return `По состоянию на ${scenarioDate(now)}: ${trimmed}`;
}

export function scenarioDate(now: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(now);
  if (match?.[1] === undefined || !Number.isFinite(Date.parse(now))) {
    throw new Error(`Scenario clock must be an ISO date or timestamp, got "${now}"`);
  }
  return match[1];
}

/** Copy the small, JSON-shaped value so callers cannot mutate engine state through results. */
export function cloneMemoryItem(item: MemoryItem): MemoryItem {
  return { ...item, source: { ...item.source } };
}
