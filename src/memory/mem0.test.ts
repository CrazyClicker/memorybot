import { describe, expect, it } from 'vitest';

import { createMemoryEngine } from '../evals/runner.ts';
import { MemoryItemSchema, type Config } from '../evals/schema.ts';
import type { MemoryItem, ThreadTranscript } from './engine.ts';
import {
  Mem0MemoryEngine,
  MEM0_SHARED_USER_ID,
  type Mem0Client,
} from './mem0.ts';

const NOW = '2026-09-03T12:00:00Z';

type AddMessages = Parameters<Mem0Client['add']>[0];
type AddOptions = Parameters<Mem0Client['add']>[1];
type SearchOptions = Parameters<Mem0Client['search']>[1];
type Mem0Result = Awaited<ReturnType<Mem0Client['add']>>;

class FakeMem0 implements Mem0Client {
  readonly adds: Array<{ messages: AddMessages; options: AddOptions }> = [];
  readonly searches: Array<{ query: string; options: SearchOptions }> = [];
  readonly addResults: Mem0Result[] = [];
  readonly searchResults = new Map<string, Mem0Result>();
  resets = 0;

  async add(messages: AddMessages, options: AddOptions): Promise<Mem0Result> {
    this.adds.push({ messages, options });
    return this.addResults.shift() ?? { results: [] };
  }

  async search(query: string, options: SearchOptions): Promise<Mem0Result> {
    this.searches.push({ query, options });
    return this.searchResults.get(options.filters.user_id) ?? { results: [] };
  }

  async reset(): Promise<void> {
    this.resets += 1;
  }
}

function item(id: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    kind: 'personal',
    about: 'alpha',
    learnedFrom: 'alpha',
    scope: 'customer',
    statement: 'Магазин использует разделитель «;».',
    source: { thread: 'alpha-thread', step: 'remember-1', via: 'agent' },
    createdAt: NOW,
    ...overrides,
  };
}

describe('Mem0MemoryEngine', () => {
  it('dates explicit writes, preserves their metadata and routes shared items separately', async () => {
    const client = new FakeMem0();
    const engine = new Mem0MemoryEngine({ client });
    await engine.write([
      item('private'),
      item('shared', {
        kind: 'temporal',
        about: 'product',
        scope: 'shared',
        validUntil: '2026-09-05T18:00:00Z',
        documentationCandidate: true,
      }),
    ], NOW);

    expect(client.adds).toHaveLength(2);
    expect(client.adds[0]).toMatchObject({
      messages: 'По состоянию на 2026-09-03: Магазин использует разделитель «;».',
      options: {
        userId: 'alpha',
        metadata: {
          prilavok_kind: 'personal',
          prilavok_about: 'alpha',
          prilavok_learned_from: 'alpha',
          prilavok_scope: 'customer',
          prilavok_source_thread: 'alpha-thread',
          prilavok_source_step: 'remember-1',
          prilavok_source_via: 'agent',
          prilavok_created_at: NOW,
        },
      },
    });
    expect(client.adds[1]?.options).toMatchObject({
      userId: MEM0_SHARED_USER_ID,
      metadata: {
        prilavok_valid_until: '2026-09-05T18:00:00Z',
        prilavok_documentation_candidate: true,
      },
    });
  });

  it('searches the current customer and shared scope with the v3 filter API', async () => {
    const client = new FakeMem0();
    client.searchResults.set('alpha', {
      results: [{
        id: 'customer-memory',
        memory: 'Нужен BOM.',
        metadata: {
          prilavok_kind: 'undocumented',
          prilavok_about: 'product',
          prilavok_learned_from: 'alpha',
          prilavok_scope: 'customer',
          prilavok_source_thread: 'alpha-thread',
          prilavok_source_via: 'consolidate',
          prilavok_created_at: '2026-09-01T09:00:00Z',
        },
      }],
    });
    client.searchResults.set(MEM0_SHARED_USER_ID, {
      results: [{ id: 'shared-memory', memory: 'Карточные платежи не работают.' }],
    });
    const engine = new Mem0MemoryEngine({ client, recallLimit: 7 });

    const recalled = await engine.recall('alpha', 'платежи и BOM', NOW);

    expect(client.searches).toEqual([
      { query: 'платежи и BOM', options: { filters: { user_id: 'alpha' }, topK: 7 } },
      { query: 'платежи и BOM', options: { filters: { user_id: MEM0_SHARED_USER_ID }, topK: 7 } },
    ]);
    expect(recalled).toEqual([
      {
        id: 'customer-memory',
        kind: 'undocumented',
        about: 'product',
        learnedFrom: 'alpha',
        scope: 'customer',
        statement: 'По состоянию на 2026-09-01: Нужен BOM.',
        source: { thread: 'alpha-thread', via: 'consolidate' },
        createdAt: '2026-09-01T09:00:00Z',
      },
      {
        id: 'shared-memory',
        kind: 'other',
        about: 'product',
        learnedFrom: 'alpha',
        scope: 'shared',
        statement: 'По состоянию на 2026-09-03: Карточные платежи не работают.',
        source: { thread: 'mem0', via: 'consolidate' },
        createdAt: NOW,
      },
    ]);
    recalled.forEach((memory) => expect(MemoryItemSchema.safeParse(memory).success).toBe(true));
  });

  it('consolidates dialogue under the customer and product coach notes under shared memory', async () => {
    const client = new FakeMem0();
    client.addResults.push(
      { results: [{ id: 'personal', memory: 'Клиент импортирует CSV.' }] },
      { results: [{ id: 'incident', memory: 'Импортёр пропускает BOM.' }] },
    );
    const engine = new Mem0MemoryEngine({ client });
    const thread: ThreadTranscript = {
      id: 'alpha-thread',
      customer: 'alpha',
      events: [
        { type: 'customer_message', at: NOW, content: 'Импортируем CSV.' },
        {
          type: 'coach_note',
          at: NOW,
          author: 'anna',
          scope: 'product',
          content: 'Импортёр пропускает строки из-за BOM.',
        },
        { type: 'human_reply', at: NOW, author: 'anna', content: 'Проверяем файл.' },
      ],
    };

    const written = await engine.consolidate(thread, NOW);

    expect(client.adds).toHaveLength(2);
    expect(client.adds[0]?.options.userId).toBe('alpha');
    expect(client.adds[0]?.messages).toEqual([
      { role: 'user', content: `[${NOW}] Клиент: Импортируем CSV.` },
      { role: 'assistant', content: `[${NOW}] Сотрудник поддержки (anna): Проверяем файл.` },
    ]);
    expect(client.adds[1]).toMatchObject({
      messages: [{ role: 'user', content: `[${NOW}] Заметка наставника (anna): Импортёр пропускает строки из-за BOM.` }],
      options: { userId: MEM0_SHARED_USER_ID },
    });
    expect(written).toMatchObject([
      { id: 'personal', about: 'alpha', learnedFrom: 'alpha', scope: 'customer' },
      { id: 'incident', about: 'product', learnedFrom: 'alpha', scope: 'shared' },
    ]);
    expect(written.every(({ statement }) => statement.startsWith('По состоянию на 2026-09-03:'))).toBe(true);
  });

  it('is empty for an empty transcript and delegates reset without exposing proposals', async () => {
    const client = new FakeMem0();
    const engine = new Mem0MemoryEngine({ client });

    expect(await engine.consolidate({ id: 'empty', customer: 'alpha', events: [] }, NOW)).toEqual([]);
    expect(client.adds).toEqual([]);
    expect('proposals' in engine).toBe(false);
    await engine.reset();
    expect(client.resets).toBe(1);
  });

  it('is available through the runner factory with an injected offline client', () => {
    const client = new FakeMem0();
    const config: Config = {
      id: 'mem0-test',
      agent: { provider: 'openai', model: 'gpt-5.6-terra' },
      memory: { engine: 'mem0', read: 'hydrate', write: 'consolidate' },
      judge: { provider: 'anthropic', model: 'claude-sonnet-5' },
    };

    const engine = createMemoryEngine(config, { mem0Client: client });

    expect(engine).toBeInstanceOf(Mem0MemoryEngine);
    expect(engine.id).toBe('mem0');
    expect((engine as Mem0MemoryEngine).llmModel).toBe(config.agent.model);
  });

  it('validates the recall limit before constructing a real client', () => {
    expect(() => new Mem0MemoryEngine({ client: new FakeMem0(), recallLimit: -1 })).toThrow(
      'recallLimit must be a non-negative safe integer',
    );
  });
});
