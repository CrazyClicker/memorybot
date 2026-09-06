/**
 * Durable state of the live loop (ROADMAP §6, T4.2): one SQLite file, `live/state.db`.
 *
 * What lives here and why:
 * - threads and their events with the GitHub ids they came from (issue number, comment id), so
 *   a restart continues the transcripts the agent has already seen and a re-run of the same
 *   GitHub event appends nothing twice (`appendEvent` returns the existing row);
 * - each agent turn (outcome, trace, recalls, writes, cost) as JSON on its `agent_reply` event,
 *   so a reply computed before a crash can be posted without paying for it again and
 *   `pnpm live status` can show what happened;
 * - processed GitHub event ids, which the loop marks in the same transaction as the comment
 *   they produced (§8: one transaction per event, never two posts);
 * - the scenario clock offset (D14) and the loop's cursor, in `meta`;
 * - proposal item ↔ pull request (T4.5).
 *
 * Memory is not here: the `notes` engine keeps `live/memory.db`. Both are cleared only by
 * `pnpm live reset`. Timestamps named `at` are the scenario clock; `recordedAt` and
 * `processedAt` are the wall clock, for debugging only.
 */
import { DatabaseSync } from 'node:sqlite';

import { THREAD_EVENT_TYPES, type ThreadEvent, type ThreadTranscript } from '../memory/index.ts';

export const DEFAULT_STATE_PATH = 'live/state.db';
const CLOCK_OFFSET_KEY = 'clock_offset_ms';

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export interface ThreadRecord {
  readonly id: string;
  readonly customer: string;
  /** The GitHub issue the thread mirrors; absent for threads the runner drives (T4.7). */
  readonly issueNumber?: number;
  readonly openedAt: string;
  readonly closedAt?: string;
  /** Events already handed to `engine.consolidate`; the next consolidation starts after them. */
  readonly consolidatedEvents: number;
}

export interface OpenThreadInput {
  readonly id: string;
  readonly customer: string;
  readonly issueNumber?: number;
  readonly openedAt: string;
}

export interface EventRecord extends ThreadEvent {
  /** Insertion order within the whole state. */
  readonly id: number;
  readonly thread: string;
  /** The GitHub object that produced or carries the event: `issue:5`, `comment:123`. */
  readonly githubId?: string;
  /** Set on `agent_reply` events; the turn record is the `payload`. */
  readonly turnId?: string;
  readonly payload?: unknown;
  readonly recordedAt: string;
}

export interface AppendEventOptions {
  readonly githubId?: string;
  readonly turnId?: string;
  readonly payload?: unknown;
}

export interface ProcessedRecord {
  readonly githubId: string;
  readonly issueNumber?: number;
  /** What the loop did with it, e.g. `{ comment: 456 }`. */
  readonly result?: unknown;
  readonly processedAt: string;
}

export interface MarkProcessedOptions {
  readonly issueNumber?: number;
  readonly result?: unknown;
}

export const PROPOSAL_STATUSES = ['open', 'merged', 'closed'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface ProposalRecord {
  /** The memory item `engine.proposals()` served. */
  readonly itemId: string;
  readonly pullNumber: number;
  readonly branch: string;
  /** Wiki page slug the proposal appends to. */
  readonly page: string;
  readonly sourceThread: string;
  readonly status: ProposalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecordProposalInput {
  readonly itemId: string;
  readonly pullNumber: number;
  readonly branch: string;
  readonly page: string;
  readonly sourceThread: string;
}

export interface LiveStateOptions {
  /** `:memory:` for tests. */
  readonly path?: string;
  /** Wall clock for `recordedAt`/`processedAt`; injectable for deterministic tests. */
  readonly clock?: () => Date;
}

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    customer TEXT NOT NULL,
    issue_number INTEGER UNIQUE,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    consolidated_events INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    author TEXT,
    scope TEXT,
    content TEXT NOT NULL,
    github_id TEXT UNIQUE,
    turn_id TEXT,
    payload TEXT,
    recorded_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id, id);
  CREATE TABLE IF NOT EXISTS processed (
    github_id TEXT PRIMARY KEY,
    issue_number INTEGER,
    result TEXT,
    processed_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS proposals (
    item_id TEXT PRIMARY KEY,
    pull_number INTEGER NOT NULL,
    branch TEXT NOT NULL,
    page TEXT NOT NULL,
    source_thread TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
`;

interface ThreadRow {
  id: string;
  customer: string;
  issue_number: number | null;
  opened_at: string;
  closed_at: string | null;
  consolidated_events: number;
}

interface EventRow {
  id: number;
  thread_id: string;
  type: string;
  at: string;
  author: string | null;
  scope: string | null;
  content: string;
  github_id: string | null;
  turn_id: string | null;
  payload: string | null;
  recorded_at: string;
}

interface ProcessedRow {
  github_id: string;
  issue_number: number | null;
  result: string | null;
  processed_at: string;
}

interface ProposalRow {
  item_id: string;
  pull_number: number;
  branch: string;
  page: string;
  source_thread: string;
  status: string;
  created_at: string;
  updated_at: string;
}

const THREAD_COLUMNS = 'id, customer, issue_number, opened_at, closed_at, consolidated_events';
const EVENT_COLUMNS =
  'id, thread_id, type, at, author, scope, content, github_id, turn_id, payload, recorded_at';
const PROPOSAL_COLUMNS =
  'item_id, pull_number, branch, page, source_thread, status, created_at, updated_at';

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export class LiveState {
  readonly path: string;

  private readonly database: DatabaseSync;
  private readonly clock: () => Date;
  private transactionDepth = 0;

  constructor(options: LiveStateOptions = {}) {
    this.path = options.path ?? DEFAULT_STATE_PATH;
    this.clock = options.clock ?? (() => new Date());
    this.database = new DatabaseSync(this.path);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(SCHEMA);
  }

  close(): void {
    this.database.close();
  }

  /** Forget everything. `pnpm live reset` is the only caller (ROADMAP T4.2). */
  reset(): void {
    this.transaction(() => {
      this.database.exec('DELETE FROM events');
      this.database.exec('DELETE FROM threads');
      this.database.exec('DELETE FROM processed');
      this.database.exec('DELETE FROM proposals');
      this.database.exec('DELETE FROM meta');
      this.database.exec("DELETE FROM sqlite_sequence WHERE name = 'events'");
    });
  }

  /**
   * Run `fn` atomically: everything it writes lands together or not at all. Nested calls
   * become savepoints, so a helper that wraps its own writes composes with a caller that
   * groups several helpers into one unit (the loop's "event + comment id" rule, §8).
   */
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth;
    const begin = depth === 0 ? 'BEGIN' : `SAVEPOINT sp${depth}`;
    const commit = depth === 0 ? 'COMMIT' : `RELEASE sp${depth}`;
    const rollback = depth === 0 ? 'ROLLBACK' : `ROLLBACK TO sp${depth}; RELEASE sp${depth}`;
    this.database.exec(begin);
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.database.exec(commit);
      return result;
    } catch (error) {
      this.database.exec(rollback);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  // -- meta and clock ------------------------------------------------------------------------

  get(key: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.database
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  delete(key: string): void {
    this.database.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  /** Scenario clock minus wall clock (D14); zero until `/clock` moves it. */
  clockOffsetMs(): number {
    const raw = this.get(CLOCK_OFFSET_KEY);
    if (raw === undefined) return 0;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Corrupt clock offset in ${this.path}: "${raw}"`);
    return value;
  }

  setClockOffsetMs(offsetMs: number): void {
    if (!Number.isFinite(offsetMs)) throw new Error(`Clock offset must be finite, got ${offsetMs}`);
    this.set(CLOCK_OFFSET_KEY, String(offsetMs));
  }

  // -- threads -------------------------------------------------------------------------------

  threads(): ThreadRecord[] {
    return (
      this.database
        .prepare(`SELECT ${THREAD_COLUMNS} FROM threads ORDER BY opened_at, rowid`)
        .all() as unknown as ThreadRow[]
    ).map(toThread);
  }

  thread(id: string): ThreadRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?`)
      .get(id) as unknown as ThreadRow | undefined;
    return row === undefined ? undefined : toThread(row);
  }

  threadByIssue(issueNumber: number): ThreadRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${THREAD_COLUMNS} FROM threads WHERE issue_number = ?`)
      .get(issueNumber) as unknown as ThreadRow | undefined;
    return row === undefined ? undefined : toThread(row);
  }

  openThread(input: OpenThreadInput): ThreadRecord {
    if (this.thread(input.id) !== undefined) throw new Error(`Thread "${input.id}" already exists`);
    if (input.issueNumber !== undefined && this.threadByIssue(input.issueNumber) !== undefined) {
      throw new Error(`Issue #${input.issueNumber} already has a thread`);
    }
    this.database
      .prepare('INSERT INTO threads (id, customer, issue_number, opened_at) VALUES (?, ?, ?, ?)')
      .run(input.id, input.customer, input.issueNumber ?? null, input.openedAt);
    return this.requireThread(input.id);
  }

  closeThread(id: string, closedAt: string): ThreadRecord {
    this.requireThread(id);
    this.database.prepare('UPDATE threads SET closed_at = ? WHERE id = ?').run(closedAt, id);
    return this.requireThread(id);
  }

  setConsolidatedEvents(id: string, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Consolidated event count must be a non-negative integer, got ${count}`);
    }
    this.requireThread(id);
    this.database.prepare('UPDATE threads SET consolidated_events = ? WHERE id = ?').run(count, id);
  }

  // -- events --------------------------------------------------------------------------------

  /** In insertion order, which is the transcript order the agent and the engines see. */
  events(threadId: string): EventRecord[] {
    return (
      this.database
        .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE thread_id = ? ORDER BY id`)
        .all(threadId) as unknown as EventRow[]
    ).map(toEvent);
  }

  event(id: number): EventRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`)
      .get(id) as unknown as EventRow | undefined;
    return row === undefined ? undefined : toEvent(row);
  }

  eventByGithubId(githubId: string): EventRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE github_id = ?`)
      .get(githubId) as unknown as EventRow | undefined;
    return row === undefined ? undefined : toEvent(row);
  }

  /**
   * Append an event; when its `githubId` is already recorded, return that row untouched. The
   * loop can therefore replay a poll after a crash and the transcript stays as it was.
   */
  appendEvent(threadId: string, event: ThreadEvent, options: AppendEventOptions = {}): EventRecord {
    return this.transaction(() => {
      if (options.githubId !== undefined) {
        const existing = this.eventByGithubId(options.githubId);
        if (existing !== undefined) {
          if (existing.thread !== threadId) {
            throw new Error(
              `GitHub event "${options.githubId}" already belongs to thread "${existing.thread}", not "${threadId}"`,
            );
          }
          return existing;
        }
      }
      this.requireThread(threadId);
      const result = this.database
        .prepare(
          `INSERT INTO events (thread_id, type, at, author, scope, content, github_id, turn_id, payload, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          event.type,
          event.at,
          event.author ?? null,
          event.scope ?? null,
          event.content,
          options.githubId ?? null,
          options.turnId ?? null,
          options.payload === undefined ? null : JSON.stringify(options.payload),
          this.wallTime(),
        );
      const inserted = this.event(Number(result.lastInsertRowid));
      if (inserted === undefined) throw new Error('Event insert returned no row');
      return inserted;
    });
  }

  /** Link an event the session produced (an `agent_reply`) to the comment the loop posted. */
  setEventGithubId(eventId: number, githubId: string): void {
    const result = this.database
      .prepare('UPDATE events SET github_id = ? WHERE id = ?')
      .run(githubId, eventId);
    if (Number(result.changes) === 0) throw new Error(`Unknown event ${eventId}`);
  }

  transcript(threadId: string): ThreadTranscript {
    const thread = this.requireThread(threadId);
    return {
      id: thread.id,
      customer: thread.customer,
      events: this.events(threadId).map(toThreadEvent),
      ...(thread.closedAt === undefined ? {} : { closedAt: thread.closedAt }),
    };
  }

  // -- processed GitHub events ---------------------------------------------------------------

  isProcessed(githubId: string): boolean {
    return this.processed(githubId) !== undefined;
  }

  processed(githubId: string): ProcessedRecord | undefined {
    const row = this.database
      .prepare('SELECT github_id, issue_number, result, processed_at FROM processed WHERE github_id = ?')
      .get(githubId) as unknown as ProcessedRow | undefined;
    if (row === undefined) return undefined;
    return {
      githubId: row.github_id,
      ...(row.issue_number === null ? {} : { issueNumber: row.issue_number }),
      ...(row.result === null ? {} : { result: JSON.parse(row.result) as unknown }),
      processedAt: row.processed_at,
    };
  }

  markProcessed(githubId: string, options: MarkProcessedOptions = {}): ProcessedRecord {
    this.database
      .prepare(
        `INSERT INTO processed (github_id, issue_number, result, processed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET
           issue_number = excluded.issue_number, result = excluded.result, processed_at = excluded.processed_at`,
      )
      .run(
        githubId,
        options.issueNumber ?? null,
        options.result === undefined ? null : JSON.stringify(options.result),
        this.wallTime(),
      );
    const record = this.processed(githubId);
    if (record === undefined) throw new Error('Processed insert returned no row');
    return record;
  }

  // -- proposals -----------------------------------------------------------------------------

  proposals(): ProposalRecord[] {
    return (
      this.database
        .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals ORDER BY created_at, pull_number`)
        .all() as unknown as ProposalRow[]
    ).map(toProposal);
  }

  proposal(itemId: string): ProposalRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE item_id = ?`)
      .get(itemId) as unknown as ProposalRow | undefined;
    return row === undefined ? undefined : toProposal(row);
  }

  proposalByPull(pullNumber: number): ProposalRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE pull_number = ?`)
      .get(pullNumber) as unknown as ProposalRow | undefined;
    return row === undefined ? undefined : toProposal(row);
  }

  recordProposal(input: RecordProposalInput): ProposalRecord {
    if (this.proposal(input.itemId) !== undefined) {
      throw new Error(`Proposal for item "${input.itemId}" already exists`);
    }
    const now = this.wallTime();
    this.database
      .prepare(
        `INSERT INTO proposals (${PROPOSAL_COLUMNS}) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(input.itemId, input.pullNumber, input.branch, input.page, input.sourceThread, now, now);
    return this.requireProposal(input.itemId);
  }

  setProposalStatus(itemId: string, status: ProposalStatus): ProposalRecord {
    this.requireProposal(itemId);
    this.database
      .prepare('UPDATE proposals SET status = ?, updated_at = ? WHERE item_id = ?')
      .run(status, this.wallTime(), itemId);
    return this.requireProposal(itemId);
  }

  // -- internals -----------------------------------------------------------------------------

  private requireThread(id: string): ThreadRecord {
    const thread = this.thread(id);
    if (thread === undefined) throw new Error(`Unknown thread "${id}"`);
    return thread;
  }

  private requireProposal(itemId: string): ProposalRecord {
    const proposal = this.proposal(itemId);
    if (proposal === undefined) throw new Error(`Unknown proposal "${itemId}"`);
    return proposal;
  }

  private wallTime(): string {
    return this.clock().toISOString();
  }
}

// ---------------------------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------------------------

function toThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    customer: row.customer,
    ...(row.issue_number === null ? {} : { issueNumber: row.issue_number }),
    openedAt: row.opened_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
    consolidatedEvents: row.consolidated_events,
  };
}

function toEvent(row: EventRow): EventRecord {
  if (!isEventType(row.type)) throw new Error(`Corrupt event ${row.id}: unknown type "${row.type}"`);
  if (row.scope !== null && row.scope !== 'customer' && row.scope !== 'product') {
    throw new Error(`Corrupt event ${row.id}: unknown scope "${row.scope}"`);
  }
  return {
    id: row.id,
    thread: row.thread_id,
    type: row.type,
    at: row.at,
    ...(row.author === null ? {} : { author: row.author }),
    ...(row.scope === null ? {} : { scope: row.scope }),
    content: row.content,
    ...(row.github_id === null ? {} : { githubId: row.github_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.payload === null ? {} : { payload: JSON.parse(row.payload) as unknown }),
    recordedAt: row.recorded_at,
  };
}

/** The `ThreadEvent` an engine or the agent sees: no storage or GitHub fields. */
export function toThreadEvent(event: EventRecord): ThreadEvent {
  return {
    type: event.type,
    at: event.at,
    ...(event.author === undefined ? {} : { author: event.author }),
    ...(event.scope === undefined ? {} : { scope: event.scope }),
    content: event.content,
  };
}

function toProposal(row: ProposalRow): ProposalRecord {
  if (!isProposalStatus(row.status)) {
    throw new Error(`Corrupt proposal "${row.item_id}": unknown status "${row.status}"`);
  }
  return {
    itemId: row.item_id,
    pullNumber: row.pull_number,
    branch: row.branch,
    page: row.page,
    sourceThread: row.source_thread,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isEventType(value: string): value is ThreadEvent['type'] {
  return (THREAD_EVENT_TYPES as readonly string[]).includes(value);
}

function isProposalStatus(value: string): value is ProposalStatus {
  return (PROPOSAL_STATUSES as readonly string[]).includes(value);
}
