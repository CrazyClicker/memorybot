import {
  cloneMemoryItem,
  dateStatement,
  type MemoryEngine,
  type MemoryItem,
  type ThreadEvent,
  type ThreadTranscript,
} from './engine.ts';

export const MEM0_SHARED_USER_ID = '_shared';
export const DEFAULT_MEM0_LLM_MODEL = 'gpt-5.6-terra';
export const DEFAULT_MEM0_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_MEM0_RECALL_LIMIT = 20;

const OPENAI_EMBEDDING_DIMENSION = 1_536;
const COLLECTION_NAME = 'prilavok_memories';

interface Mem0Message {
  readonly role: string;
  readonly content: string;
}

interface Mem0ResultItem {
  readonly id: string;
  readonly memory: string;
  readonly createdAt?: string;
  readonly metadata?: Record<string, unknown>;
}

interface Mem0Result {
  readonly results: readonly Mem0ResultItem[];
}

/** The small part of the OSS SDK used by the adapter. Kept injectable for offline tests. */
export interface Mem0Client {
  add(
    messages: string | Mem0Message[],
    options: {
      readonly userId: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<Mem0Result>;
  search(
    query: string,
    options: {
      readonly filters: { readonly user_id: string };
      readonly topK: number;
    },
  ): Promise<Mem0Result>;
  reset(): Promise<void>;
}

export interface Mem0MemoryOptions {
  readonly client?: Mem0Client;
  readonly apiKey?: string;
  readonly llmModel?: string;
  readonly embeddingModel?: string;
  readonly recallLimit?: number;
}

interface ItemDefaults {
  readonly kind: MemoryItem['kind'];
  readonly about: string;
  readonly learnedFrom: string;
  readonly scope: MemoryItem['scope'];
  readonly source: MemoryItem['source'];
  readonly createdAt: string;
}

const META = {
  kind: 'prilavok_kind',
  about: 'prilavok_about',
  learnedFrom: 'prilavok_learned_from',
  scope: 'prilavok_scope',
  validUntil: 'prilavok_valid_until',
  documentationCandidate: 'prilavok_documentation_candidate',
  sourceThread: 'prilavok_source_thread',
  sourceStep: 'prilavok_source_step',
  sourceVia: 'prilavok_source_via',
  createdAt: 'prilavok_created_at',
} as const;

/** OSS Mem0 with a process-local vector store and OpenAI extraction + embeddings. */
export class Mem0MemoryEngine implements MemoryEngine {
  readonly id = 'mem0';
  readonly llmModel: string;

  private readonly client: Mem0Client;
  private readonly recallLimit: number;

  constructor(options: Mem0MemoryOptions = {}) {
    const recallLimit = options.recallLimit ?? DEFAULT_MEM0_RECALL_LIMIT;
    if (!Number.isSafeInteger(recallLimit) || recallLimit < 0) {
      throw new Error(`recallLimit must be a non-negative safe integer, got ${recallLimit}`);
    }
    this.recallLimit = recallLimit;
    this.llmModel = options.llmModel ?? DEFAULT_MEM0_LLM_MODEL;
    this.client = options.client ?? createSdkClient({ ...options, llmModel: this.llmModel });
  }

  async reset(): Promise<void> {
    await this.client.reset();
  }

  async recall(customer: string, query: string, now: string): Promise<MemoryItem[]> {
    const [customerResult, sharedResult] = await Promise.all([
      this.search(query, customer),
      this.search(query, MEM0_SHARED_USER_ID),
    ]);
    const seen = new Set<string>();
    const recalled: MemoryItem[] = [];

    for (const [result, defaults] of [
      [customerResult, itemDefaults(customer, customer, 'customer', now)],
      [sharedResult, itemDefaults('product', customer, 'shared', now)],
    ] as const) {
      for (const raw of result.results) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        recalled.push(fromMem0(raw, defaults));
      }
    }
    return recalled.map(cloneMemoryItem);
  }

  async write(items: MemoryItem[], now: string): Promise<void> {
    for (const raw of items) {
      const item = {
        ...cloneMemoryItem(raw),
        statement: dateStatement(raw.statement, now),
      };
      await this.client.add(item.statement, {
        userId: item.scope === 'shared' ? MEM0_SHARED_USER_ID : item.learnedFrom,
        metadata: itemMetadata(item),
      });
    }
  }

  async consolidate(thread: ThreadTranscript, now: string): Promise<MemoryItem[]> {
    if (thread.events.length === 0) return [];

    const written: MemoryItem[] = [];
    const productNotes = thread.events.filter(isSharedProductNote);
    const customerEvents = thread.events.filter((event) => !isSharedProductNote(event));

    if (customerEvents.length > 0) {
      const defaults = itemDefaults(thread.customer, thread.customer, 'customer', now, thread.id);
      const result = await this.client.add(customerEvents.map(toMem0Message), {
        userId: thread.customer,
        metadata: defaultsMetadata(defaults),
      });
      written.push(...result.results.map((item) => fromMem0(item, defaults)));
    }

    for (const note of productNotes) {
      const defaults = itemDefaults('product', thread.customer, 'shared', now, thread.id);
      const result = await this.client.add([toMem0Message(note)], {
        userId: MEM0_SHARED_USER_ID,
        metadata: defaultsMetadata(defaults),
      });
      written.push(...result.results.map((item) => fromMem0(item, defaults)));
    }

    return written.map(cloneMemoryItem);
  }

  private search(query: string, userId: string): Promise<Mem0Result> {
    return this.client.search(query, {
      filters: { user_id: userId },
      topK: this.recallLimit,
    });
  }
}

export function createMem0MemoryEngine(options: Mem0MemoryOptions = {}): Mem0MemoryEngine {
  return new Mem0MemoryEngine(options);
}

function createSdkClient(options: Mem0MemoryOptions): Mem0Client {
  const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new Error('OPENAI_API_KEY is required by mem0 for its LLM and embedder');
  }

  return new LazySdkMem0Client({
    apiKey,
    llmModel: options.llmModel ?? DEFAULT_MEM0_LLM_MODEL,
    embeddingModel: options.embeddingModel ?? DEFAULT_MEM0_EMBEDDING_MODEL,
  });
}

interface SdkConfig {
  readonly apiKey: string;
  readonly llmModel: string;
  readonly embeddingModel: string;
}

/** Avoid loading Mem0 and its native vector-store dependency for configs that do not use it. */
class LazySdkMem0Client implements Mem0Client {
  private instance?: Promise<Mem0Client>;

  constructor(private readonly config: SdkConfig) {}

  async add(
    messages: Parameters<Mem0Client['add']>[0],
    options: Parameters<Mem0Client['add']>[1],
  ): ReturnType<Mem0Client['add']> {
    return (await this.get()).add(messages, options);
  }

  async search(
    query: string,
    options: Parameters<Mem0Client['search']>[1],
  ): ReturnType<Mem0Client['search']> {
    return (await this.get()).search(query, options);
  }

  async reset(): Promise<void> {
    await (await this.get()).reset();
  }

  private get(): Promise<Mem0Client> {
    if (this.instance === undefined) this.instance = this.load();
    return this.instance;
  }

  private async load(): Promise<Mem0Client> {
    // OSS Mem0 sends operational telemetry by default. Evals stay local unless explicitly opted in.
    if (process.env['MEM0_TELEMETRY'] === undefined) process.env['MEM0_TELEMETRY'] = 'false';
    const { Memory } = await import('mem0ai/oss');
    const memory = new Memory({
      llm: {
        provider: 'openai',
        config: { apiKey: this.config.apiKey, model: this.config.llmModel },
      },
      embedder: {
        provider: 'openai',
        config: { apiKey: this.config.apiKey, model: this.config.embeddingModel },
      },
      vectorStore: {
        provider: 'memory',
        // mem0ai 3.x otherwise persists this provider under ~/.mem0 despite its "memory" name.
        config: {
          collectionName: COLLECTION_NAME,
          dimension: OPENAI_EMBEDDING_DIMENSION,
          dbPath: ':memory:',
        },
      },
      // Eval runs reset all state and do not use Mem0's wall-clock SQLite history.
      disableHistory: true,
    });
    if (process.env['MEM0_TELEMETRY']?.toLowerCase() === 'false') {
      // Prevent the disabled telemetry initializer from creating ~/.mem0/config.json for an id.
      memory.telemetryId = 'prilavok-local';
    }
    return memory;
  }
}

function isSharedProductNote(event: ThreadEvent): boolean {
  return event.type === 'coach_note' && event.scope === 'product';
}

function toMem0Message(event: ThreadEvent): Mem0Message {
  const author = event.author === undefined ? '' : ` (${event.author})`;
  switch (event.type) {
    case 'customer_message':
      return { role: 'user', content: `[${event.at}] Клиент${author}: ${event.content}` };
    case 'agent_reply':
      return { role: 'assistant', content: `[${event.at}] Агент${author}: ${event.content}` };
    case 'human_reply':
      return { role: 'assistant', content: `[${event.at}] Сотрудник поддержки${author}: ${event.content}` };
    case 'coach_note':
      return { role: 'user', content: `[${event.at}] Заметка наставника${author}: ${event.content}` };
  }
}

function itemDefaults(
  about: string,
  learnedFrom: string,
  scope: MemoryItem['scope'],
  createdAt: string,
  thread = 'mem0',
): ItemDefaults {
  return {
    kind: 'other',
    about,
    learnedFrom,
    scope,
    source: { thread, via: 'consolidate' },
    createdAt,
  };
}

function defaultsMetadata(defaults: ItemDefaults): Record<string, unknown> {
  return {
    [META.kind]: defaults.kind,
    [META.about]: defaults.about,
    [META.learnedFrom]: defaults.learnedFrom,
    [META.scope]: defaults.scope,
    [META.sourceThread]: defaults.source.thread,
    [META.sourceVia]: defaults.source.via,
    [META.createdAt]: defaults.createdAt,
  };
}

function itemMetadata(item: MemoryItem): Record<string, unknown> {
  return {
    [META.kind]: item.kind,
    [META.about]: item.about,
    [META.learnedFrom]: item.learnedFrom,
    [META.scope]: item.scope,
    ...(item.validUntil === undefined ? {} : { [META.validUntil]: item.validUntil }),
    ...(item.documentationCandidate === undefined
      ? {}
      : { [META.documentationCandidate]: item.documentationCandidate }),
    [META.sourceThread]: item.source.thread,
    ...(item.source.step === undefined ? {} : { [META.sourceStep]: item.source.step }),
    [META.sourceVia]: item.source.via,
    [META.createdAt]: item.createdAt,
  };
}

function fromMem0(raw: Mem0ResultItem, defaults: ItemDefaults): MemoryItem {
  const metadata = raw.metadata ?? {};
  const createdAt = timestamp(metadata[META.createdAt]) ?? timestamp(raw.createdAt) ?? defaults.createdAt;
  const validUntil = dateOrTimestamp(metadata[META.validUntil]);
  const documentationCandidate = metadata[META.documentationCandidate];
  const step = nonEmptyString(metadata[META.sourceStep]);

  return {
    id: raw.id,
    kind: kind(metadata[META.kind]) ?? defaults.kind,
    about: nonEmptyString(metadata[META.about]) ?? defaults.about,
    learnedFrom: nonEmptyString(metadata[META.learnedFrom]) ?? defaults.learnedFrom,
    scope: scope(metadata[META.scope]) ?? defaults.scope,
    statement: dateStatement(raw.memory, createdAt),
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(typeof documentationCandidate === 'boolean' ? { documentationCandidate } : {}),
    source: {
      thread: nonEmptyString(metadata[META.sourceThread]) ?? defaults.source.thread,
      ...(step === undefined ? {} : { step }),
      via: writePath(metadata[META.sourceVia]) ?? defaults.source.via,
    },
    createdAt,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function kind(value: unknown): MemoryItem['kind'] | undefined {
  return value === 'personal' || value === 'temporal' || value === 'undocumented' || value === 'other'
    ? value
    : undefined;
}

function scope(value: unknown): MemoryItem['scope'] | undefined {
  return value === 'customer' || value === 'shared' ? value : undefined;
}

function writePath(value: unknown): MemoryItem['source']['via'] | undefined {
  return value === 'agent' || value === 'consolidate' ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function dateOrTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return /^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(value) ? value : undefined;
}
