import {
  canRecall,
  cloneMemoryItem,
  dateStatement,
  type MemoryEngine,
  type MemoryItem,
  type ThreadEvent,
  type ThreadTranscript,
} from './engine.ts';
import { estimateTokens } from './text.ts';

// Compatibility export; the implementation is shared with structured engines in text.ts.
export { estimateTokens } from './text.ts';

export const DEFAULT_NAIVE_RECALL_TOKENS = 4_000;

export interface NaiveMemoryOptions {
  readonly maxRecallTokens?: number;
  /** Injectable because exact tokenization depends on the model used by a later agent turn. */
  readonly countTokens?: (text: string) => number;
}

interface LogEntry {
  readonly item: MemoryItem;
}

/** Whole transcripts in, newest matching log entries out. No extraction and no query ranking. */
export class NaiveMemoryEngine implements MemoryEngine {
  readonly id = 'naive';

  private readonly maxRecallTokens: number;
  private readonly countTokens: (text: string) => number;
  private entries: LogEntry[] = [];
  private nextConsolidationId = 1;

  constructor(options: NaiveMemoryOptions = {}) {
    const maxRecallTokens = options.maxRecallTokens ?? DEFAULT_NAIVE_RECALL_TOKENS;
    if (!Number.isSafeInteger(maxRecallTokens) || maxRecallTokens < 0) {
      throw new Error(`maxRecallTokens must be a non-negative safe integer, got ${maxRecallTokens}`);
    }
    this.maxRecallTokens = maxRecallTokens;
    this.countTokens = options.countTokens ?? estimateTokens;
  }

  async reset(): Promise<void> {
    this.entries = [];
    this.nextConsolidationId = 1;
  }

  async recall(customer: string, _query: string, _now: string): Promise<MemoryItem[]> {
    const recalled: MemoryItem[] = [];
    let usedTokens = 0;

    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry === undefined || !canRecall(entry.item, customer)) continue;

      const tokens = normalizedTokenCount(this.countTokens(entry.item.statement));
      if (usedTokens + tokens > this.maxRecallTokens) break;
      recalled.push(cloneMemoryItem(entry.item));
      usedTokens += tokens;
    }
    return recalled;
  }

  async write(items: MemoryItem[], now: string): Promise<void> {
    for (const item of items) {
      this.append({
        ...cloneMemoryItem(item),
        statement: dateStatement(item.statement, now),
      });
    }
  }

  async consolidate(thread: ThreadTranscript, now: string): Promise<MemoryItem[]> {
    if (thread.events.length === 0) return [];

    const consolidationId = this.nextConsolidationId;
    const transcriptItem: MemoryItem = {
      id: `naive-${thread.id}-${consolidationId}`,
      kind: 'other',
      about: thread.customer,
      learnedFrom: thread.customer,
      scope: 'customer',
      statement: renderTranscript(thread, now),
      source: { thread: thread.id, via: 'consolidate' },
      createdAt: now,
    };
    this.nextConsolidationId += 1;

    const sharedItems = thread.events
      .filter((event) => event.type === 'coach_note' && event.scope === 'product')
      .map<MemoryItem>((event, index) => ({
        id: `naive-${thread.id}-${consolidationId}-shared-${index + 1}`,
        kind: 'other',
        about: 'product',
        learnedFrom: thread.customer,
        scope: 'shared',
        statement: dateStatement(event.content, now),
        source: { thread: thread.id, via: 'consolidate' },
        createdAt: now,
      }));

    const written = [transcriptItem, ...sharedItems];
    written.forEach((item) => this.append(item));
    return written.map(cloneMemoryItem);
  }

  private append(item: MemoryItem): void {
    this.entries.push({ item: cloneMemoryItem(item) });
  }
}

export function createNaiveMemoryEngine(options: NaiveMemoryOptions = {}): NaiveMemoryEngine {
  return new NaiveMemoryEngine(options);
}

export function renderTranscript(thread: ThreadTranscript, now: string): string {
  const lines = thread.events.map(renderEvent);
  if (thread.closedAt !== undefined) lines.push(`[${thread.closedAt}] Обращение закрыто.`);
  return dateStatement(`История обращения ${thread.id}:\n${lines.join('\n')}`, now);
}

function renderEvent(event: ThreadEvent): string {
  const author = event.author === undefined ? '' : ` (${event.author})`;
  return `[${event.at}] ${eventLabel(event.type)}${author}: ${event.content}`;
}

function eventLabel(type: ThreadEvent['type']): string {
  switch (type) {
    case 'customer_message':
      return 'Клиент';
    case 'agent_reply':
      return 'Агент';
    case 'human_reply':
      return 'Сотрудник поддержки';
    case 'coach_note':
      return 'Заметка наставника';
  }
}

function normalizedTokenCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`countTokens must return a finite non-negative number, got ${value}`);
  }
  return Math.ceil(value);
}
