/**
 * T3.1 structured notes engine.
 *
 * The eval knowledge vocabulary is the storage vocabulary: each fact is dated, typed, scoped
 * and stored once. SQLite is intentionally only the durable store; the expected working set is
 * tens of rows, so deterministic TypeScript ranking and deduplication stay easy to inspect.
 * Shared scope is never inferred from product wording: only a product-scoped coach note can open
 * that gate. Product documentation candidates are anonymised by extraction, not by a post-filter.
 *
 * Decisions that are easy to undo by accident:
 * - A consolidated note is dated by its latest source event, not by the consolidation clock;
 *   `createdAt` keeps the clock. The runner hands a thread over again whenever it has new
 *   events, so the "known notes" list in the prompt and the Jaccard dedup (same kind, same
 *   about and learnedFrom, or both shared about the same subject) are what keep re-consolidation
 *   idempotent.
 * - `documentationCandidate` is derived (`undocumented` about the product), the same rule the
 *   agent's `remember` tool applies; `proposals()` serves exactly those rows.
 * - `recall` ranks by token overlap with the query but keeps zero-overlap and expired rows: the
 *   agent's prompt flags expiry, and a background fact is often what the next ticket needs.
 * - `usage()` reports the extraction spend so the report can charge this engine for its own
 *   LLM calls; hosted engines cannot be charged the same way.
 * - The extraction instructions are general rules of note-taking and name no scenario's objects
 *   (a test enforces it), so the scenarios the extractor never saw stay a valid check.
 */
import { DatabaseSync } from 'node:sqlite';

import { generateText, type LanguageModel, NoObjectGeneratedError, Output } from 'ai';
import { z } from 'zod';

import {
  addUsage,
  costUsd as calculateCostUsd,
  resolveModel,
  type TokenUsage,
  tokenUsage,
  ZERO_USAGE,
} from '../llm/index.ts';
import {
  DateOrTimestampSchema,
  KindSchema,
  type ModelSpec,
} from '../evals/schema.ts';
import {
  canRecall,
  cloneMemoryItem,
  dateStatement,
  type MemoryEngine,
  type MemoryEngineUsage,
  type MemoryItem,
  type ThreadEvent,
  type ThreadTranscript,
} from './engine.ts';
import {
  estimateTokens,
  factTokens,
  jaccardSimilarity,
  tokenOverlap,
} from './text.ts';

export const DEFAULT_NOTES_RECALL_TOKENS = 4_000;
export const DEFAULT_NOTES_DEDUP_THRESHOLD = 0.6;

export interface NotesMemoryOptions {
  readonly path?: string;
  readonly modelSpec: ModelSpec;
  /** Direct injection keeps unit tests offline. */
  readonly model?: LanguageModel;
  readonly maxRecallTokens?: number;
  readonly countTokens?: (text: string) => number;
  readonly dedupThreshold?: number;
}

interface NoteRow {
  id: string;
  kind: MemoryItem['kind'];
  about: string;
  learned_from: string;
  scope: MemoryItem['scope'];
  statement: string;
  valid_until: string | null;
  documentation_candidate: number | null;
  source_thread: string;
  source_step: string | null;
  source_via: MemoryItem['source']['via'];
  created_at: string;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    about TEXT NOT NULL,
    learned_from TEXT NOT NULL,
    scope TEXT NOT NULL,
    statement TEXT NOT NULL,
    valid_until TEXT,
    documentation_candidate INTEGER,
    source_thread TEXT NOT NULL,
    source_step TEXT,
    source_via TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT
`;

const SELECT_COLUMNS = `
  id, kind, about, learned_from, scope, statement, valid_until,
  documentation_candidate, source_thread, source_step, source_via, created_at
`;

const INSERT_NOTE = `
  INSERT OR IGNORE INTO notes (
    id, kind, about, learned_from, scope, statement, valid_until,
    documentation_candidate, source_thread, source_step, source_via, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Structured, scoped memory backed by one SQLite table. */
export class NotesMemoryEngine implements MemoryEngine {
  readonly id = 'notes';

  private readonly database: DatabaseSync;
  private readonly modelSpec: ModelSpec;
  private readonly model: LanguageModel;
  private readonly maxRecallTokens: number;
  private readonly countTokens: (text: string) => number;
  private readonly dedupThreshold: number;
  private nextId = 1;
  private cumulativeUsage: TokenUsage = ZERO_USAGE;
  private cumulativeCostUsd = 0;
  private costKnown = true;

  constructor(options: NotesMemoryOptions) {
    assertNonNegativeInteger('maxRecallTokens', options.maxRecallTokens ?? DEFAULT_NOTES_RECALL_TOKENS);
    const dedupThreshold = options.dedupThreshold ?? DEFAULT_NOTES_DEDUP_THRESHOLD;
    if (!Number.isFinite(dedupThreshold) || dedupThreshold < 0 || dedupThreshold > 1) {
      throw new Error(`dedupThreshold must be between 0 and 1, got ${dedupThreshold}`);
    }

    this.database = new DatabaseSync(options.path ?? ':memory:');
    this.database.exec(CREATE_TABLE);
    this.nextId = nextGeneratedId(this.allItems());
    this.modelSpec = options.modelSpec;
    this.model = options.model ?? resolveModel(options.modelSpec);
    this.maxRecallTokens = options.maxRecallTokens ?? DEFAULT_NOTES_RECALL_TOKENS;
    this.countTokens = options.countTokens ?? estimateTokens;
    this.dedupThreshold = dedupThreshold;
  }

  async reset(): Promise<void> {
    this.database.exec('DELETE FROM notes');
    this.nextId = 1;
    this.cumulativeUsage = ZERO_USAGE;
    this.cumulativeCostUsd = 0;
    this.costKnown = true;
  }

  async recall(customer: string, query: string, _now: string): Promise<MemoryItem[]> {
    const queryTokens = factTokens(query);
    const ranked = this.allItems()
      .filter((item) => canRecall(item, customer))
      .map((item) => ({ item, overlap: tokenOverlap(queryTokens, factTokens(item.statement)) }))
      .sort((left, right) =>
        right.overlap - left.overlap ||
        Date.parse(right.item.createdAt) - Date.parse(left.item.createdAt) ||
        right.item.id.localeCompare(left.item.id),
      );

    const recalled: MemoryItem[] = [];
    let usedTokens = 0;
    for (const { item } of ranked) {
      const tokens = normalizedTokenCount(this.countTokens(item.statement));
      if (usedTokens + tokens > this.maxRecallTokens) break;
      recalled.push(cloneMemoryItem(item));
      usedTokens += tokens;
    }
    return recalled;
  }

  async write(items: MemoryItem[], now: string): Promise<void> {
    for (const raw of items) {
      const item = { ...cloneMemoryItem(raw), statement: dateStatement(raw.statement, now) };
      this.insertUnlessDuplicate(item);
    }
  }

  async consolidate(thread: ThreadTranscript, now: string): Promise<MemoryItem[]> {
    if (thread.events.length === 0) return [];

    const { notes, usage } = await this.extract(thread);
    this.recordUsage(usage);

    const written: MemoryItem[] = [];
    for (const extracted of notes) {
      const accepted = acceptNote(extracted, thread);
      if (accepted === undefined) continue;
      const latestSource = latestEvent(accepted.sourceEvents);
      const shared =
        extracted.about === 'product' &&
        accepted.sourceEvents.some((event) => event.type === 'coach_note' && event.scope === 'product');
      const item: MemoryItem = {
        id: `notes-${this.nextId}`,
        kind: accepted.kind,
        about: extracted.about,
        learnedFrom: thread.customer,
        scope: shared ? 'shared' : 'customer',
        statement: dateStatement(extracted.statement, latestSource.at),
        ...(accepted.validUntil === undefined ? {} : { validUntil: accepted.validUntil }),
        ...(accepted.kind === 'undocumented' && extracted.about === 'product'
          ? { documentationCandidate: true }
          : {}),
        source: { thread: thread.id, via: 'consolidate' },
        createdAt: now,
      };
      if (this.insertUnlessDuplicate(item)) {
        written.push(cloneMemoryItem(item));
      }
    }
    return written;
  }

  /**
   * One structured-output call, retried once when the object does not parse: the model is
   * stochastic and a malformed object is a flake, not a verdict on the transcript. A second
   * failure propagates; the runner records it against this consolidation and carries on.
   */
  private async extract(thread: ThreadTranscript): Promise<{ notes: ExtractedNote[]; usage: TokenUsage }> {
    const call = async () => {
      const result = await generateText({
        model: this.model,
        ...(this.modelSpec.temperature === undefined ? {} : { temperature: this.modelSpec.temperature }),
        instructions: EXTRACTION_INSTRUCTIONS,
        prompt: extractionPrompt(thread, this.visibleItems(thread.customer)),
        output: Output.object({ schema: extractionSchema(thread) }),
      });
      return { notes: result.output.notes, usage: tokenUsage(result.usage) };
    };
    try {
      return await call();
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw error;
      return await call();
    }
  }

  async proposals(): Promise<MemoryItem[]> {
    return this.queryItems(
      `SELECT ${SELECT_COLUMNS} FROM notes
       WHERE about = 'product' AND documentation_candidate = 1
       ORDER BY created_at DESC, id DESC`,
    );
  }

  usage(): MemoryEngineUsage {
    return {
      usage: { ...this.cumulativeUsage },
      ...(this.costKnown ? { costUsd: this.cumulativeCostUsd } : {}),
    };
  }

  /** Useful for a persistent M2 session and tests; not needed by the eval runner. */
  close(): void {
    this.database.close();
  }

  private visibleItems(customer: string): MemoryItem[] {
    return this.allItems().filter((item) => canRecall(item, customer));
  }

  private allItems(): MemoryItem[] {
    return this.queryItems(`SELECT ${SELECT_COLUMNS} FROM notes`);
  }

  private queryItems(sql: string): MemoryItem[] {
    return (this.database.prepare(sql).all() as unknown as NoteRow[]).map(rowToItem);
  }

  private insertUnlessDuplicate(item: MemoryItem): boolean {
    const duplicate = this.allItems().some((existing) =>
      sameDedupDomain(existing, item) &&
      jaccardSimilarity(factTokens(existing.statement), factTokens(item.statement)) >= this.dedupThreshold,
    );
    if (duplicate) return false;

    const inserted = this.database.prepare(INSERT_NOTE).run(
      item.id,
      item.kind,
      item.about,
      item.learnedFrom,
      item.scope,
      item.statement,
      item.validUntil ?? null,
      item.documentationCandidate === undefined ? null : Number(item.documentationCandidate),
      item.source.thread,
      item.source.step ?? null,
      item.source.via,
      item.createdAt,
    );
    const generated = /^notes-(\d+)$/.exec(item.id);
    if (inserted.changes > 0 && generated?.[1] !== undefined) {
      this.nextId = Math.max(this.nextId, Number(generated[1]) + 1);
    }
    return inserted.changes > 0;
  }

  private recordUsage(callUsage: TokenUsage): void {
    this.cumulativeUsage = addUsage(this.cumulativeUsage, callUsage);
    const callCost = calculateCostUsd(this.modelSpec, callUsage);
    if (callCost === undefined) {
      this.costKnown = false;
    } else {
      this.cumulativeCostUsd += callCost;
    }
  }
}

export function createNotesMemoryEngine(options: NotesMemoryOptions): NotesMemoryEngine {
  return new NotesMemoryEngine(options);
}

/**
 * General rules of note-taking, on purpose: nothing here names a scenario's objects, so a
 * scenario the engine never saw stays a valid check of the extractor. Add a rule only if it
 * reads naturally to someone who has not seen the eval that motivated it.
 */
const EXTRACTION_INSTRUCTIONS = [
  'You extract reusable memory notes from a Russian customer-support transcript, for a support',
  'agent that will read them on this merchant\'s future tickets. Write statements in Russian,',
  'without the "По состоянию на" date prefix. Cite the numbered source events of every note in',
  'source_events and extract nothing they do not support.',
  'Evidence: a customer message is evidence about that customer; human replies and coach notes',
  'are trusted; agent replies are context, not evidence. Do not extract guesses, or general',
  'documentation rules rather than something learned here.',
  'One note per fact. Facts with different lifecycles — a durable behaviour, a temporary',
  'obligation, a planned event, its later confirmation — are separate notes even when one message',
  'states them together. A plan or expectation and the later confirmation that it happened are',
  'two facts: extract the confirmation even when the plan is already known.',
  'Compact means free of conversation, not free of content. Keep the qualifiers that change what',
  'a reader would do: which cases are affected and which are not, what the merchant does and does',
  'not see, exact values, formats, setting names, schedules and limits. A merchant\'s setup is one',
  'note that keeps all of its parameters together. State as fact what a trusted source stated as',
  'fact; hedge only what the source itself hedged.',
  'kind=personal: this merchant\'s setup, constraints and history. kind=temporal: a condition whose',
  'own truth expires — an incident, a deadline, a temporary workaround or obligation — with',
  'valid_until. kind=undocumented: durable product behaviour absent from the documentation, stated',
  'with the period it applies to when the evidence gives one. kind=other only as a fallback.',
  'Product behaviour stays kind=undocumented even when a change to it is planned or has shipped:',
  'give the period it applied to and keep the change itself as a separate note. kind=temporal is',
  'for conditions that are temporary by nature — an incident, a deadline, an obligation that ends',
  '— not for behaviour that a later change replaces. Dates mentioned near a fact do not make it',
  'temporal; only its own expiry does.',
  'Every temporal note has valid_until, an ISO date (2026-09-10) or a UTC timestamp',
  '(2026-09-05T18:00:00Z); every other note has valid_until null.',
  'For about=product never name a merchant, a person or merchant-specific software: keep only the',
  'reusable product fact. The application, not you, decides whether a note becomes shared.',
  'Known notes are listed below. Do not repeat or lightly rephrase them. If a known note is',
  'incomplete, extract the missing details as a new note rather than skipping them.',
].join(' ');

/**
 * The boundary with the model is deliberately loose. OpenAI's strict structured outputs enforce
 * types, enums and required keys, not numeric ranges, string lengths or refinements, and a zod
 * rejection here fails the whole call (m1-lite-5 lost a run that way). Ranges, dates and the
 * temporal/valid_until rule are checked note by note in `acceptNote` instead.
 */
function extractionSchema(thread: ThreadTranscript) {
  const aboutSchema = thread.customer === 'product'
    ? z.literal('product')
    : z.union([z.literal(thread.customer), z.literal('product')]);
  return z.strictObject({
    notes: z.array(
      z.strictObject({
        kind: KindSchema,
        about: aboutSchema,
        statement: z.string(),
        // Every property must be listed in `required` for strict mode; null stands for "none".
        valid_until: z.string().nullable(),
        source_events: z.array(z.number().int()),
      }),
    ),
  });
}

type ExtractedNote = z.infer<ReturnType<typeof extractionSchema>>['notes'][number];

interface AcceptedNote {
  readonly kind: MemoryItem['kind'];
  readonly validUntil?: string;
  readonly sourceEvents: readonly ThreadEvent[];
}

/** The checks the model boundary leaves out; `undefined` drops the note. */
function acceptNote(note: ExtractedNote, thread: ThreadTranscript): AcceptedNote | undefined {
  if (note.statement.trim() === '') return undefined;
  const sourceEvents = note.source_events
    .filter((number) => number >= 1 && number <= thread.events.length)
    .map((number) => thread.events[number - 1]!);
  // A note the model cannot tie to any event is a guess, not a memory.
  if (sourceEvents.length === 0) return undefined;
  const validUntil = note.valid_until === null ? undefined : normalizeDate(note.valid_until);
  if (note.kind === 'temporal' && validUntil === undefined) {
    // "Temporal" without an expiry cannot expire: keep the fact, drop the lifecycle claim.
    return { kind: 'other', sourceEvents };
  }
  return {
    kind: note.kind,
    ...(note.kind === 'temporal' ? { validUntil } : {}),
    sourceEvents,
  };
}

function extractionPrompt(thread: ThreadTranscript, known: readonly MemoryItem[]): string {
  const events = thread.events.map((event, index) =>
    `${index + 1}. [${event.at}] ${eventTrust(event)}: ${event.content}`,
  );
  const knownLines = known.length === 0
    ? ['- none']
    : known.map((item) =>
      `- [kind=${item.kind}; about=${item.about}; scope=${item.scope}; ` +
      `valid_until=${item.validUntil ?? 'none'}] ${item.statement}`,
    );
  return [
    `Thread: ${thread.id}`,
    `Customer id: ${thread.customer}`,
    '',
    'Numbered events and evidence trust:',
    ...events,
    '',
    'Known notes for this customer and shared scope (do not repeat):',
    ...knownLines,
  ].join('\n');
}

/**
 * The eval clock is UTC and the schema wants an offset; the model often writes a bare local
 * timestamp («2026-09-05T18:00» or «2026-09-05 18:00»). Read those as UTC rather than dropping
 * the expiry; anything else that the schema rejects is treated as no date.
 */
function normalizeDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (DateOrTimestampSchema.safeParse(trimmed).success) return trimmed;
  const bare = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (bare === null) return undefined;
  const candidate = `${bare[1]}T${bare[2]}:${bare[3] ?? '00'}Z`;
  return DateOrTimestampSchema.safeParse(candidate).success ? candidate : undefined;
}

function eventTrust(event: ThreadEvent): string {
  switch (event.type) {
    case 'customer_message':
      return 'customer claim (evidence about this customer)';
    case 'agent_reply':
      return 'agent reply (context only, not independent evidence)';
    case 'human_reply':
      return `human support reply${event.author === undefined ? '' : ` by ${event.author}`} (trusted)`;
    case 'coach_note':
      return `coach note scope=${event.scope ?? 'customer'}` +
        `${event.author === undefined ? '' : ` by ${event.author}`} (trusted)`;
  }
}

function latestEvent(events: readonly ThreadEvent[]): ThreadEvent {
  return events.reduce((latest, event) => Date.parse(event.at) >= Date.parse(latest.at) ? event : latest);
}

function sameDedupDomain(left: MemoryItem, right: MemoryItem): boolean {
  if (left.kind !== right.kind) return false;
  if (left.scope === 'shared' || right.scope === 'shared') {
    return left.scope === 'shared' && right.scope === 'shared' && left.about === right.about;
  }
  return left.about === right.about && left.learnedFrom === right.learnedFrom;
}

function rowToItem(row: NoteRow): MemoryItem {
  return {
    id: row.id,
    kind: row.kind,
    about: row.about,
    learnedFrom: row.learned_from,
    scope: row.scope,
    statement: row.statement,
    ...(row.valid_until === null ? {} : { validUntil: row.valid_until }),
    ...(row.documentation_candidate === null
      ? {}
      : { documentationCandidate: row.documentation_candidate === 1 }),
    source: {
      thread: row.source_thread,
      ...(row.source_step === null ? {} : { step: row.source_step }),
      via: row.source_via,
    },
    createdAt: row.created_at,
  };
}

function normalizedTokenCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`countTokens must return a finite non-negative number, got ${value}`);
  }
  return Math.ceil(value);
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer, got ${value}`);
  }
}

function nextGeneratedId(items: readonly MemoryItem[]): number {
  let next = 1;
  for (const item of items) {
    const match = /^notes-(\d+)$/.exec(item.id);
    if (match?.[1] !== undefined) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}
