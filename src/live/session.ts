/**
 * The runner's glue as a reusable object (ROADMAP §6, T4.2).
 *
 * The eval runner (`src/evals/runner.ts`) turns scenario steps into thread events, agent turns
 * and consolidations; the live loop (T4.3) turns GitHub events into the same things. `Session`
 * is that middle layer with the transcripts, the clock and the consolidation bookkeeping in
 * `LiveState` (SQLite) instead of a per-run object, so a restarted process carries on where it
 * stopped. `agentTurn` and `consolidate` follow the runner's `agent_turn` and `consolidate`
 * steps line by line, helpers included; T4.7 folds the runner onto this object and removes the
 * duplicate. Until then, a change to one belongs in the other too.
 *
 * Decisions:
 * - The clock is `wall clock + offset` (D14). `setClock` moves the offset forward only, and
 *   every event, recall, write and note is stamped with it, never with GitHub's timestamps: a
 *   comment posted after `/clock` jumped a week would otherwise carry a date from the past.
 * - A turn is stored as JSON on its `agent_reply` event. The loop can then post a reply it
 *   computed before a crash instead of paying for it twice, and `pnpm live status` can show
 *   outcomes and costs without the eval result files.
 * - Nothing here resets the engine. The runner resets per scenario; a live session must keep
 *   its memory across restarts, so `reset()` exists for `pnpm live reset` only.
 * - The config is an eval config file, `evals/configs/notes-both.yaml` by default (D15). Only
 *   `agent` and `memory` are read; `judge` is the eval's business.
 */
import type { LanguageModel } from 'ai';
import { z } from 'zod';

import { runTurn, type TurnInput } from '../agent/index.ts';
import { formatMemory } from '../agent/prompt.ts';
import { loadConfig } from '../evals/load.ts';
import {
  type Config,
  type Customer,
  RecallObservationSchema,
  StepResultSchema,
} from '../evals/schema.ts';
import { createMemoryEngine, type RunAgent } from '../evals/runner.ts';
import {
  canRecall,
  cloneMemoryItem,
  createNotesMemoryEngine,
  dateStatement,
  estimateTokens,
  type MemoryEngine,
  type MemoryItem,
  type ThreadEvent,
  type ThreadTranscript,
} from '../memory/index.ts';
import { loadWiki, parseWikiPage, Wiki, type WikiPage } from '../wiki/index.ts';
import {
  DEFAULT_STATE_PATH,
  type EventRecord,
  LiveState,
  type ThreadRecord,
} from './state.ts';

export const DEFAULT_SESSION_CONFIG = 'evals/configs/notes-both.yaml';
export const DEFAULT_MEMORY_PATH = 'live/memory.db';

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

/**
 * One agent turn as the loop, the renderer (T4.4) and `pnpm live status` see it: the runner's
 * `StepResult` without the eval-only checks and judge cost. Stored as the `agent_reply`
 * event's payload and validated on the way back out, so a corrupt row fails loudly.
 */
export const SessionTurnSchema = StepResultSchema.omit({ checks: true, judgeCostUsd: true }).extend({
  recalls: z.array(RecallObservationSchema),
  responseLatencyMs: z.number().min(0),
});
export type SessionTurn = z.infer<typeof SessionTurnSchema>;

export interface SessionConsolidation {
  readonly thread: string;
  readonly at: string;
  /** Events handed to the engine this time; 0 means nothing new, and the engine was not called. */
  readonly events: number;
  readonly wrote: MemoryItem[];
  /** Observable engine-side extraction cost; absent for engines that cannot report it. */
  readonly costUsd?: number;
}

export interface CustomerMessageInput {
  readonly thread: string;
  readonly customer: string;
  readonly content: string;
  /** Scenario clock; defaults to `now()`. */
  readonly at?: string;
  /** The GitHub object this event mirrors; a second call with the same id appends nothing. */
  readonly githubId?: string;
  /** Recorded on the thread when this message opens it. */
  readonly issueNumber?: number;
}

export interface HumanReplyInput {
  readonly thread: string;
  readonly author: string;
  readonly content: string;
  readonly at?: string;
  readonly githubId?: string;
}

export interface CoachNoteInput {
  readonly thread: string;
  readonly author: string;
  readonly content: string;
  /** `product` is the human broadcast gate (D7); defaults to `customer`. */
  readonly scope?: 'customer' | 'product';
  readonly at?: string;
  readonly githubId?: string;
}

export interface SessionOptions {
  readonly config: Config;
  readonly engine: MemoryEngine;
  readonly wiki: Wiki;
  readonly state: LiveState;
  /** The CRM records the agent sees, by customer id (`live/config.yaml` or a scenario's world). */
  readonly customers: Readonly<Record<string, Customer>>;
  /** Wall clock; the scenario clock is this plus the offset stored in `state` (D14). */
  readonly clock?: () => Date;
  /** Injectable for offline tests; normal sessions call the agent. */
  readonly runAgent?: RunAgent;
}

export class ClockMovesForwardOnlyError extends Error {
  constructor(
    readonly current: string,
    readonly requested: string,
  ) {
    super(`The scenario clock moves forward only: it is ${current}, cannot move to ${requested}`);
    this.name = 'ClockMovesForwardOnlyError';
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export class Session {
  readonly config: Config;
  readonly engine: MemoryEngine;
  readonly state: LiveState;

  private currentWiki: Wiki;
  private readonly customers: Readonly<Record<string, Customer>>;
  private readonly clock: () => Date;
  private readonly runAgent: RunAgent;

  constructor(options: SessionOptions) {
    this.config = options.config;
    this.engine = options.engine;
    this.currentWiki = options.wiki;
    this.state = options.state;
    this.customers = options.customers;
    this.clock = options.clock ?? (() => new Date());
    this.runAgent = options.runAgent ?? runTurn;
  }

  get wiki(): Wiki {
    return this.currentWiki;
  }

  // -- clock (D14) ---------------------------------------------------------------------------

  /** The scenario clock: wall clock plus the stored offset, as an ISO timestamp. */
  now(): string {
    return new Date(this.clock().getTime() + this.state.clockOffsetMs()).toISOString();
  }

  /** Move the scenario clock to `target` (`/clock <ISO>`); returns the new `now()`. */
  setClock(target: string): string {
    const targetMs = Date.parse(target);
    if (!Number.isFinite(targetMs)) throw new Error(`Clock target must be an ISO timestamp, got "${target}"`);
    const current = this.now();
    if (targetMs < Date.parse(current)) throw new ClockMovesForwardOnlyError(current, target);
    this.state.setClockOffsetMs(targetMs - this.clock().getTime());
    return this.now();
  }

  // -- reading -------------------------------------------------------------------------------

  threads(): ThreadRecord[] {
    return this.state.threads();
  }

  thread(id: string): ThreadRecord | undefined {
    return this.state.thread(id);
  }

  transcript(id: string): ThreadTranscript {
    return this.state.transcript(id);
  }

  /** The thread's agent turns in order, read back from their `agent_reply` events. */
  turns(id: string): SessionTurn[] {
    return this.state
      .events(id)
      .filter((event) => event.turnId !== undefined)
      .map((event) => SessionTurnSchema.parse(event.payload));
  }

  // -- events --------------------------------------------------------------------------------

  /** Opens the thread on its first message; later messages must keep the same customer. */
  customerMessage(input: CustomerMessageInput): EventRecord {
    return this.state.transaction(() => {
      const existing = this.existingEvent(input.githubId);
      if (existing !== undefined) return existing;
      const at = input.at ?? this.now();
      let thread = this.state.thread(input.thread);
      if (thread === undefined) {
        thread = this.state.openThread({
          id: input.thread,
          customer: input.customer,
          ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
          openedAt: at,
        });
      } else if (thread.customer !== input.customer) {
        throw new Error(`Thread "${input.thread}" belongs to "${thread.customer}", not "${input.customer}"`);
      } else if (thread.closedAt !== undefined) {
        throw new Error(`Thread "${input.thread}" is already closed`);
      }
      return this.state.appendEvent(
        thread.id,
        { type: 'customer_message', at, content: input.content },
        githubOptions(input.githubId),
      );
    });
  }

  humanReply(input: HumanReplyInput): EventRecord {
    return this.state.transaction(() => {
      const existing = this.existingEvent(input.githubId);
      if (existing !== undefined) return existing;
      const thread = this.requireOpenThread(input.thread);
      return this.state.appendEvent(
        thread.id,
        { type: 'human_reply', at: input.at ?? this.now(), author: input.author, content: input.content },
        githubOptions(input.githubId),
      );
    });
  }

  /** Allowed on a closed thread, as in the runner: the coach writes after the ticket is done. */
  coachNote(input: CoachNoteInput): EventRecord {
    return this.state.transaction(() => {
      const existing = this.existingEvent(input.githubId);
      if (existing !== undefined) return existing;
      const thread = this.requireThread(input.thread);
      return this.state.appendEvent(
        thread.id,
        {
          type: 'coach_note',
          at: input.at ?? this.now(),
          author: input.author,
          scope: input.scope ?? 'customer',
          content: input.content,
        },
        githubOptions(input.githubId),
      );
    });
  }

  close(threadId: string, at?: string): ThreadRecord {
    this.requireOpenThread(threadId);
    return this.state.closeThread(threadId, at ?? this.now());
  }

  // -- the agent turn (the runner's `agent_turn` step) ---------------------------------------

  /**
   * Hydrate through `engine.recall`, run the agent with the live recall callback, record the
   * `agent_reply`, then hand the agent's `remember` writes to the engine dated and scoped to
   * this customer. An agent that throws (`AgentDidNotFinishError`) leaves the thread as it
   * was, so the loop can retry the same turn.
   */
  async agentTurn(threadId: string): Promise<SessionTurn> {
    const thread = this.requireOpenThread(threadId);
    const transcript = this.state.transcript(threadId);
    const now = this.now();
    const turnId = `turn-${this.turns(threadId).length + 1}`;
    const query = latestCustomerMessage(transcript);
    const customer = this.customers[thread.customer];
    if (customer === undefined) throw new Error(`Unknown customer "${thread.customer}"`);

    const recalls: SessionTurn['recalls'] = [];
    const recall = async (
      customerId: string, queryText: string, at: string, via: 'hydrate' | 'tool' = 'tool',
    ): Promise<MemoryItem[]> => {
      const started = performance.now();
      const returned = await scopedRecall(this.engine, customerId, queryText, at);
      recalls.push({
        via, query: queryText, returned: returned.map(cloneMemoryItem),
        latencyMs: Math.max(0, performance.now() - started),
        estimatedTokens: returned.length === 0 ? 0 : estimateTokens(formatMemory(returned, at)),
      });
      return returned;
    };
    const memory = this.config.memory.read === 'tool'
      ? []
      : await recall(thread.customer, query, now, 'hydrate');

    const input: TurnInput = {
      now,
      customer: { id: thread.customer, ...customer },
      thread: transcript,
      memory,
      tools: {
        recallMemory: this.config.memory.read !== 'hydrate',
        remember: this.config.memory.write !== 'consolidate',
      },
      wiki: this.currentWiki,
      model: this.config.agent,
    };
    const result = await this.runAgent(input, { recallMemory: recall });

    const memoryWrites = result.memoryWrites.map((item, index) =>
      agentWrite(item, transcript, turnId, index, now),
    );
    const turn: SessionTurn = {
      id: turnId,
      thread: threadId,
      at: now,
      outcome: result.outcome,
      reply: result.reply,
      ...(result.escalationReason === undefined ? {} : { escalationReason: result.escalationReason }),
      trace: result.trace,
      memoryWrites,
      usage: result.usage,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      latencyMs: result.latencyMs,
      recalls,
      responseLatencyMs: result.latencyMs + recalls
        .filter((observation) => observation.via === 'hydrate')
        .reduce((total, observation) => total + observation.latencyMs, 0),
    };
    this.state.appendEvent(
      threadId,
      { type: 'agent_reply', at: now, content: result.reply },
      { turnId, payload: turn },
    );
    if (memoryWrites.length > 0) await this.engine.write(memoryWrites, now);
    return turn;
  }

  // -- consolidation (the runner's `consolidate` step, one thread at a time) -----------------

  /**
   * Hand the thread's events since the last consolidation to the engine. Under `write: agent`
   * only the coach notes go, as in the runner: the agent already wrote what it learned. An
   * engine failure propagates and the thread stays pending, so the next call offers the same
   * events again.
   */
  async consolidate(threadId: string): Promise<SessionConsolidation> {
    const thread = this.requireThread(threadId);
    const transcript = this.state.transcript(threadId);
    const at = this.now();
    const previousCount = thread.consolidatedEvents;
    const pending = transcript.events.length - previousCount;
    if (pending <= 0) return { thread: threadId, at, events: 0, wrote: [] };

    const input = this.config.memory.write === 'agent'
      ? coachNotesSince(transcript, previousCount)
      : transcript;
    const costBefore = this.engine.usage?.().costUsd;
    const items = await this.engine.consolidate(input, at);
    const costAfter = this.engine.usage?.().costUsd;
    const costUsd = costBefore === undefined || costAfter === undefined
      ? undefined
      : Math.max(0, costAfter - costBefore);
    this.state.setConsolidatedEvents(threadId, transcript.events.length);
    return {
      thread: threadId,
      at,
      events: pending,
      wrote: items.map(cloneMemoryItem),
      ...(costUsd === undefined ? {} : { costUsd }),
    };
  }

  // -- wiki and proposals --------------------------------------------------------------------

  /** Replace the snapshot, e.g. with `wiki/*.md` from `main` after a proposal PR merged. */
  wikiReload(pages: readonly WikiPage[]): Wiki {
    this.currentWiki = new Wiki(pages, { search: this.currentWiki.searchEnabled });
    return this.currentWiki;
  }

  /** Documentation candidates the engine serves that have no pull request yet (T4.5). */
  async newProposals(): Promise<MemoryItem[]> {
    if (this.engine.proposals === undefined) return [];
    return (await this.engine.proposals())
      .filter((item) => this.state.proposal(item.id) === undefined)
      .map(cloneMemoryItem);
  }

  // -- lifecycle -----------------------------------------------------------------------------

  /** Clear the state and the memory. `pnpm live reset` is the only caller. */
  async reset(): Promise<void> {
    this.state.reset();
    await this.engine.reset();
  }

  /** Close the database handles; the engine's remote resources, if any, stay (D15 xmemory). */
  dispose(): void {
    this.state.close();
    if (hasClose(this.engine)) this.engine.close();
  }

  // -- internals -----------------------------------------------------------------------------

  private existingEvent(githubId: string | undefined): EventRecord | undefined {
    return githubId === undefined ? undefined : this.state.eventByGithubId(githubId);
  }

  private requireThread(id: string): ThreadRecord {
    const thread = this.state.thread(id);
    if (thread === undefined) throw new Error(`Unknown thread "${id}"`);
    return thread;
  }

  private requireOpenThread(id: string): ThreadRecord {
    const thread = this.requireThread(id);
    if (thread.closedAt !== undefined) throw new Error(`Thread "${id}" is already closed`);
    return thread;
  }
}

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

export interface SessionEngineOptions {
  /** Where the `notes` engine keeps its rows; ignored by the other engines. */
  readonly memoryPath?: string;
  /** Direct model injection keeps tests offline. */
  readonly model?: LanguageModel;
}

/**
 * The engine an eval config names, persistent where the engine allows it: `notes` opens
 * `live/memory.db`; the others come from the runner's factory unchanged (naive and none are
 * in-memory, mem0 and xmemory keep their own stores).
 */
export function createSessionEngine(config: Config, options: SessionEngineOptions = {}): MemoryEngine {
  if (config.memory.engine === 'notes') {
    return createNotesMemoryEngine({
      modelSpec: config.agent,
      path: options.memoryPath ?? DEFAULT_MEMORY_PATH,
      ...(options.model === undefined ? {} : { model: options.model }),
    });
  }
  return createMemoryEngine(config, options.model === undefined ? {} : { model: options.model });
}

export interface OpenSessionOptions extends SessionEngineOptions {
  readonly configPath?: string;
  readonly statePath?: string;
  /** Local wiki directory for the first snapshot; the loop reloads from GitHub afterwards. */
  readonly wikiDir?: string;
  readonly customers: Readonly<Record<string, Customer>>;
  readonly clock?: () => Date;
  readonly runAgent?: RunAgent;
}

/** A session over the eval config file and the two `live/*.db` files (T4.6). */
export async function openSession(options: OpenSessionOptions): Promise<Session> {
  const loaded = await loadConfig(options.configPath ?? DEFAULT_SESSION_CONFIG);
  const errors = loaded.issues.filter((issue) => issue.severity === 'error');
  if (loaded.value === undefined || errors.length > 0) {
    const detail = errors.map((issue) => `${issue.path || '<file>'}: ${issue.message}`).join('; ');
    throw new Error(`Invalid session config ${loaded.path}: ${detail}`);
  }
  const state = new LiveState({
    path: options.statePath ?? DEFAULT_STATE_PATH,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return new Session({
    config: loaded.value,
    engine: createSessionEngine(loaded.value, options),
    wiki: await loadWiki(options.wikiDir === undefined ? {} : { directory: options.wikiDir }),
    state,
    customers: options.customers,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.runAgent === undefined ? {} : { runAgent: options.runAgent }),
  });
}

/**
 * Wiki pages from `wiki/*.md` as `GithubClient.readWiki` returns them: the same rules as the
 * local loader (README is documentation, not a page; slugs are unique).
 */
export function wikiPagesFromFiles(
  files: readonly { readonly name: string; readonly content: string }[],
): WikiPage[] {
  const pages: WikiPage[] = [];
  const filesBySlug = new Map<string, string>();
  for (const file of files) {
    if (!file.name.endsWith('.md') || file.name.toLowerCase() === 'readme.md') continue;
    const page = parseWikiPage(file.content, file.name);
    const previous = filesBySlug.get(page.slug);
    if (previous !== undefined) {
      throw new Error(`${file.name}: duplicate wiki slug "${page.slug}" (already declared in ${previous})`);
    }
    filesBySlug.set(page.slug, file.name);
    pages.push(page);
  }
  return pages;
}

// ---------------------------------------------------------------------------------------------
// Helpers shared with the runner in spirit; T4.7 makes them one implementation
// ---------------------------------------------------------------------------------------------

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

function cloneEvent(event: ThreadEvent): ThreadEvent {
  return { ...event };
}

function latestCustomerMessage(thread: ThreadTranscript): string {
  for (let index = thread.events.length - 1; index >= 0; index -= 1) {
    const event = thread.events[index];
    if (event?.type === 'customer_message') return event.content;
  }
  throw new Error(`Thread "${thread.id}" has no customer message`);
}

function githubOptions(githubId: string | undefined): { githubId?: string } {
  return githubId === undefined ? {} : { githubId };
}

function hasClose(engine: MemoryEngine): engine is MemoryEngine & { close(): void } {
  return typeof (engine as { close?: unknown }).close === 'function';
}
