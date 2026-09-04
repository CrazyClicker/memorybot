import { afterEach, describe, expect, it } from 'vitest';

import { MemoryItemSchema, RunResultSchema, type Config } from '../evals/schema.ts';
import type { MemoryItem, ThreadTranscript } from './engine.ts';
import {
  MissingCredentialError,
  XMEMORY_DUMP_QUERY,
  XMEMORY_SCHEMA_YML,
  XMEMORY_SHARED_SCOPE,
  XmemoryMemoryEngine,
  fromXmemoryObject,
  type XmemoryClient,
  type XmemoryInstanceHandle,
  type XmemoryReadResult,
  type XmemoryWriteResult,
} from './xmemory.ts';

const NOW = '2026-09-05T14:00:00Z';
const originalApiKey = process.env['XMEMORY_API_KEY'];

interface CreatedInstance {
  readonly clusterId: string;
  readonly name: string;
  readonly schema: string;
  readonly options: { readonly description: string; readonly timeoutMs: number };
}

class FakeXmemory implements XmemoryClient {
  clusters = [{ id: 'cluster-one' }];
  instances: Array<{ id: string; name: string }> = [];
  readonly creates: CreatedInstance[] = [];
  readonly deletes: string[] = [];
  readonly writes: Array<{ instanceId: string; text: string; options: unknown }> = [];
  readonly reads: Array<{ instanceId: string; query: string; options: unknown }> = [];
  readonly writeResults: XmemoryWriteResult[] = [];
  readonly readResults = new Map<string, XmemoryReadResult>();
  createHandle: XmemoryInstanceHandle | undefined;
  writeErrors: unknown[] = [];

  async listClusters() {
    return this.clusters;
  }

  async listInstances() {
    return this.instances;
  }

  async createInstance(
    clusterId: string,
    name: string,
    schema: string,
    options: { readonly description: string; readonly timeoutMs: number },
  ) {
    this.creates.push({ clusterId, name, schema, options });
    const id = `instance-${this.creates.length}`;
    this.instances.push({ id, name });
    return this.createHandle ?? { id };
  }

  async deleteInstance(instanceId: string) {
    this.deletes.push(instanceId);
    this.instances = this.instances.filter(({ id }) => id !== instanceId);
    return [];
  }

  async write(instanceId: string, text: string, options: unknown): Promise<XmemoryWriteResult> {
    this.writes.push({ instanceId, text, options });
    const error = this.writeErrors.shift();
    if (error !== undefined) throw error;
    return this.writeResults.shift() ?? {
      write_id: `write-${this.writes.length}`,
      trace_id: `write-trace-${this.writes.length}`,
      console_url: `https://console.test/write/${this.writes.length}`,
      changes: { created: { objects: [] } },
    };
  }

  async read(instanceId: string, query: string, options: unknown): Promise<XmemoryReadResult> {
    this.reads.push({ instanceId, query, options });
    return this.readResults.get(instanceId) ?? {
      trace_id: `read-trace-${this.reads.length}`,
      console_url: `https://console.test/read/${this.reads.length}`,
      reader_result: { objects: [] },
    };
  }
}

function field(name: string, value: unknown) {
  const wrapped = typeof value === 'boolean' ? { boolean_value: value } : { string_value: value };
  return { name, value: wrapped };
}

function fact(id: string, statement: string, overrides: Record<string, unknown> = {}) {
  return {
    xuid: id,
    name: 'Fact',
    identifier: {},
    fields: [
      field('statement', statement),
      field('kind', 'other'),
      field('about', 'merchant'),
      field('stated_at', NOW),
      ...Object.entries(overrides).map(([name, value]) => field(name, value)),
    ],
  };
}

function item(id: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    kind: 'personal',
    about: 'alpha',
    learnedFrom: 'alpha',
    scope: 'customer',
    statement: 'Магазин использует двухстадийную оплату.',
    source: { thread: 'alpha-thread', step: 'remember', via: 'agent' },
    createdAt: NOW,
    ...overrides,
  };
}

function thread(): ThreadTranscript {
  return {
    id: 'alpha-thread',
    customer: 'alpha',
    events: [
      { type: 'customer_message', at: NOW, content: 'Карты не проходят.' },
      { type: 'agent_reply', at: NOW, content: 'Передаю специалисту.' },
      {
        type: 'coach_note',
        at: NOW,
        author: 'anna',
        scope: 'product',
        content: 'У Оплатим сбой до 18:00, QR работает.',
      },
      { type: 'human_reply', at: NOW, author: 'anna', content: 'Заказ 1153 проверяем.' },
    ],
  };
}

afterEach(() => {
  if (originalApiKey === undefined) delete process.env['XMEMORY_API_KEY'];
  else process.env['XMEMORY_API_KEY'] = originalApiKey;
});

describe('XmemoryMemoryEngine', () => {
  it('deletes prilavok orphans, creates customer/shared instances lazily and maps writes', async () => {
    const client = new FakeXmemory();
    client.instances.push(
      { id: 'orphan', name: 'prilavok-old-alpha' },
      { id: 'unrelated', name: 'keep-me' },
    );
    client.writeResults.push(
      {
        trace_id: 'personal-trace',
        console_url: 'https://console.test/personal',
        changes: {
          created: { objects: [fact('personal-xuid', 'Проверяется заказ 1153.', { kind: 'personal' })] },
        },
      },
      {
        trace_id: 'shared-trace',
        console_url: 'https://console.test/shared',
        changes: {
          created: {
            objects: [fact('shared-xuid', 'У Оплатим сбой, QR работает.', {
              kind: 'temporal',
              about: 'product',
              valid_until: '2026-09-05T18:00:00Z',
              documentation_candidate: false,
            })],
          },
        },
      },
    );
    const engine = new XmemoryMemoryEngine({ client, clusterId: 'cluster-one', tag: 'abc123' });

    await engine.reset();
    const written = await engine.consolidate(thread(), NOW);

    expect(client.deletes).toEqual(['orphan']);
    expect(client.instances).toContainEqual({ id: 'unrelated', name: 'keep-me' });
    expect(client.creates.map(({ name }) => name).sort()).toEqual([
      'prilavok-abc123-_shared',
      'prilavok-abc123-alpha',
    ]);
    expect(client.creates.every(({ schema }) => schema === XMEMORY_SCHEMA_YML)).toBe(true);
    expect(client.writes).toHaveLength(2);
    const customerWrite = client.writes.find(({ instanceId }) => instanceId === 'instance-1');
    const sharedWrite = client.writes.find(({ instanceId }) => instanceId === 'instance-2');
    expect(customerWrite?.text).toContain('Карты не проходят.');
    expect(customerWrite?.text).not.toContain('У Оплатим сбой');
    expect(sharedWrite?.text).toContain('У Оплатим сбой');
    expect(sharedWrite?.text).not.toContain('Карты не проходят.');
    expect(written).toMatchObject([
      {
        id: 'personal-xuid',
        learnedFrom: 'alpha',
        scope: 'customer',
        source: { thread: 'alpha-thread', via: 'consolidate' },
      },
      {
        id: 'shared-xuid',
        kind: 'temporal',
        about: 'product',
        learnedFrom: 'alpha',
        scope: 'shared',
        validUntil: '2026-09-05T18:00:00Z',
      },
    ]);
    written.forEach((memory) => expect(MemoryItemSchema.safeParse(memory).success).toBe(true));
    expect(engine.diagnostics()).toEqual({
      calls: { creates: 2, reads: 0, writes: 2, deletes: 1 },
      traces: expect.arrayContaining([
        { operation: 'delete', scope: 'alpha' },
        {
          operation: 'write',
          scope: XMEMORY_SHARED_SCOPE,
          traceId: 'shared-trace',
          consoleUrl: 'https://console.test/shared',
        },
      ]),
    });

    await engine.cleanup();
    expect(client.deletes).toEqual(expect.arrayContaining(['orphan', 'instance-1', 'instance-2']));
  });

  it('uses handle-id fallback, synchronous dated explicit writes and the configured extraction mode', async () => {
    const client = new FakeXmemory();
    client.createHandle = {};
    const engine = new XmemoryMemoryEngine({
      client,
      clusterId: 'cluster-one',
      extractionLogic: 'deep',
      timeoutMs: 500,
      tag: 'fallback',
    });
    await engine.reset();

    await engine.write([item('one')], NOW);

    expect(client.writes[0]).toMatchObject({
      instanceId: 'instance-1',
      options: { extractionLogic: 'deep', timeoutMs: 500 },
    });
    expect(client.writes[0]?.text).toContain(
      'По состоянию на 2026-09-05: Магазин использует двухстадийную оплату.',
    );
  });

  it('reads only the requested customer plus shared scope, then ranks and token-caps locally', async () => {
    const client = new FakeXmemory();
    const engine = new XmemoryMemoryEngine({
      client,
      clusterId: 'cluster-one',
      tag: 'isolate',
      maxRecallTokens: 1,
      countTokens: () => 1,
    });
    await engine.reset();
    await engine.write([item('alpha'), item('shared', {
      about: 'product',
      scope: 'shared',
      statement: 'Оплатим: карты не работают, QR работает.',
    })], NOW);
    await engine.write([item('beta', { about: 'beta', learnedFrom: 'beta' })], NOW);
    const alphaId = client.instances.find(({ name }) => name.endsWith('-alpha'))?.id ?? '';
    const betaId = client.instances.find(({ name }) => name.endsWith('-beta'))?.id ?? '';
    const sharedId = client.instances.find(({ name }) => name.endsWith('-_shared'))?.id ?? '';
    client.readResults.set(alphaId, { reader_result: { objects: [fact('alpha-fact', 'Заказ 1153 проверяется.')] } });
    client.readResults.set(betaId, { reader_result: { objects: [fact('beta-fact', 'Только beta.')] } });
    client.readResults.set(sharedId, {
      reader_result: { objects: [fact('shared-fact', 'Оплатим: карты не работают, QR работает.', { about: 'product' })] },
    });

    const recalled = await engine.recall('alpha', 'Почему Оплатим не принимает карты?', NOW);

    expect(client.reads.slice(-2).map(({ instanceId }) => instanceId).sort()).toEqual(
      [alphaId, sharedId].sort(),
    );
    expect(client.reads.slice(-2).every(({ query }) => query === XMEMORY_DUMP_QUERY)).toBe(true);
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({ id: 'shared-fact', about: 'product', scope: 'shared' });
    expect(recalled.some(({ id }) => id === 'beta-fact')).toBe(false);
  });

  it('maps missing fields safely and keeps expired or zero-overlap facts available', async () => {
    const defaults = {
      kind: 'other' as const,
      about: 'alpha',
      learnedFrom: 'alpha',
      scope: 'customer' as const,
      source: { thread: 'alpha-thread', via: 'consolidate' as const },
      createdAt: NOW,
    };
    const mapped = fromXmemoryObject(
      fact('temporal', 'Сбой ещё был.', { kind: 'temporal', valid_until: '2026-09-04' }),
      defaults,
      NOW,
    );
    const sparse = fromXmemoryObject({ fields: { statement: 'Редкий фоновый факт.' } }, defaults, NOW);
    const synthetic = fromXmemoryObject({
      identifier: '#1',
      fields: { statement: 'Другой редкий факт.' },
    }, defaults, NOW);

    expect(mapped).toMatchObject({
      id: 'temporal',
      statement: 'По состоянию на 2026-09-05: Сбой ещё был.',
      validUntil: '2026-09-04',
    });
    expect(sparse?.id).toMatch(/^xmemory-[0-9a-f]{8}$/);
    expect(synthetic?.id).toMatch(/^xmemory-[0-9a-f]{8}$/);
    expect(synthetic?.id).not.toBe('#1');
    expect(sparse).toMatchObject({ kind: 'other', about: 'alpha', scope: 'customer' });
    expect(fromXmemoryObject({ fields: [] }, defaults, NOW)).toBeUndefined();
  });

  it('serves only product documentation candidates as proposals', async () => {
    const client = new FakeXmemory();
    const engine = new XmemoryMemoryEngine({ client, clusterId: 'cluster-one', tag: 'propose' });
    await engine.reset();
    await engine.write([item('seed')], NOW);
    const instanceId = client.instances[0]?.id ?? '';
    client.readResults.set(instanceId, {
      reader_result: {
        objects: [
          fact('candidate', 'CSV с BOM пропускает строки.', {
            kind: 'undocumented', about: 'product', documentation_candidate: true,
          }),
          fact('private', 'У клиента заказ 1153.', { documentation_candidate: true }),
          fact('not-candidate', 'Временный сбой.', { about: 'product', documentation_candidate: false }),
        ],
      },
    });

    expect(await engine.proposals()).toMatchObject([{ id: 'candidate', about: 'product' }]);
  });

  it('retries RATE_LIMITED three times and does not retry QUOTA_EXCEEDED', async () => {
    const rateClient = new FakeXmemory();
    rateClient.writeErrors = [
      { code: 'RATE_LIMITED', retryAfter: 0 },
      { code: 'RATE_LIMITED', retryAfter: 0 },
      { code: 'RATE_LIMITED', retryAfter: 0 },
    ];
    const delays: number[] = [];
    const retrying = new XmemoryMemoryEngine({
      client: rateClient,
      clusterId: 'cluster-one',
      tag: 'retry',
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });
    await retrying.reset();
    await retrying.write([item('retry')], NOW);
    expect(rateClient.writes).toHaveLength(4);
    expect(delays).toEqual([0, 0, 0]);

    const quotaClient = new FakeXmemory();
    quotaClient.writeErrors = [{
      code: 'QUOTA_EXCEEDED',
      message: 'Daily allowance used',
      details: { kind: 'daily_quota_exceeded', retry_after_seconds: 3600 },
    }];
    const quota = new XmemoryMemoryEngine({ client: quotaClient, clusterId: 'cluster-one', tag: 'quota' });
    await quota.reset();
    await expect(quota.write([item('quota')], NOW)).rejects.toThrow(
      /daily_quota_exceeded.*retry_after=3600s/,
    );
    expect(quotaClient.writes).toHaveLength(1);
  });

  it('requires a key for the real client', () => {
    delete process.env['XMEMORY_API_KEY'];
    expect(() => new XmemoryMemoryEngine()).toThrow(MissingCredentialError);
  });

  it.skipIf(Number(process.versions.node.split('.')[0]) < 22)(
    'is available through the runner factory',
    async () => {
    const { createMemoryEngine } = await import('../evals/runner.ts');
    const client = new FakeXmemory();
    const config: Config = {
      id: 'xmemory-test',
      agent: { provider: 'openai', model: 'gpt-5.6-terra' },
      memory: { engine: 'xmemory', read: 'hydrate', write: 'consolidate' },
      judge: { provider: 'anthropic', model: 'claude-sonnet-5' },
    };
    const engine = createMemoryEngine(config, { xmemoryClient: client });
    expect(engine).toBeInstanceOf(XmemoryMemoryEngine);
    expect(engine.id).toBe('xmemory');
    },
  );

  it('allows run results to persist hosted-engine diagnostics', () => {
    const parsed = RunResultSchema.safeParse({
      scenario: 'scenario', config: 'config', repeat: 1, startedAt: NOW, finishedAt: NOW,
      steps: [], consolidations: [], probes: [],
      score: { pass: 0, partial: 0, fail: 0, skipped: 0 }, costUsd: 0,
      memoryDiagnostics: {
        calls: { creates: 1, reads: 2, writes: 3, deletes: 0 },
        traces: [{ operation: 'read', scope: 'alpha', traceId: 'trace', consoleUrl: 'https://console.test' }],
      },
    });
    expect(parsed.success).toBe(true);
  });
});
