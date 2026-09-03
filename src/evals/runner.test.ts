import { describe, expect, it } from 'vitest';

import type { RunTurnOptions, TurnInput, TurnResult } from '../agent/index.ts';
import { ZERO_USAGE } from '../llm/index.ts';
import {
  cloneMemoryItem,
  type MemoryEngine,
  type MemoryItem,
  type ThreadTranscript,
} from '../memory/index.ts';
import { Wiki } from '../wiki/index.ts';
import type { Judge } from './judge.ts';
import { RunResultSchema, type Config, type Scenario } from './schema.ts';
import { runScenario, runScenarioRepeats, type RunAgent } from './runner.ts';

const DAY = '2026-09-01';
const START = `${DAY}T09:00:00Z`;

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'shared-memory',
    kind: 'temporal',
    about: 'product',
    learnedFrom: 'alpha',
    scope: 'shared',
    statement: `По состоянию на ${DAY}: Общий факт.`,
    validUntil: '2026-09-02',
    source: { thread: 'old-thread', via: 'consolidate' },
    createdAt: START,
    ...overrides,
  };
}

function config(overrides: Partial<Config['memory']> = {}): Config {
  return {
    id: 'test-config',
    agent: { provider: 'openai', model: 'gpt-4o-mini', temperature: 0 },
    memory: { engine: 'naive', read: 'both', write: 'both', ...overrides },
    judge: { provider: 'anthropic', model: 'claude-sonnet-5' },
  };
}

function wiki(): Wiki {
  return new Wiki([
    {
      slug: 'help',
      title: 'Помощь',
      summary: 'Основная справка.',
      content: 'Исходный текст.',
    },
  ]);
}

class RecordingEngine implements MemoryEngine {
  readonly id = 'recording';
  readonly recalls: Array<{ customer: string; query: string; now: string }> = [];
  readonly writes: MemoryItem[][] = [];
  readonly consolidations: ThreadTranscript[] = [];
  resetCount = 0;

  async reset(): Promise<void> {
    this.resetCount += 1;
  }

  async recall(customer: string, query: string, now: string): Promise<MemoryItem[]> {
    this.recalls.push({ customer, query, now });
    return [
      item(),
      item({
        id: 'alpha-private',
        kind: 'personal',
        about: 'alpha',
        scope: 'customer',
        statement: `По состоянию на ${DAY}: Только для alpha.`,
      }),
    ];
  }

  async write(items: MemoryItem[]): Promise<void> {
    this.writes.push(items.map(cloneMemoryItem));
  }

  async consolidate(thread: ThreadTranscript, now: string): Promise<MemoryItem[]> {
    this.consolidations.push(cloneThread(thread));
    if (thread.events.length === 0) return [];
    return [item({
      id: `consolidated-${this.consolidations.length}`,
      statement: `По состоянию на ${DAY}: ${thread.id}.`,
      source: { thread: thread.id, via: 'consolidate' },
      createdAt: now,
    })];
  }

  async proposals(): Promise<MemoryItem[]> {
    return [item({
      id: 'proposal',
      kind: 'undocumented',
      documentationCandidate: true,
    })];
  }
}

class FailingWriteEngine extends RecordingEngine {
  override async write(_items: MemoryItem[]): Promise<void> {
    throw new Error('write failed');
  }
}

function cloneThread(thread: ThreadTranscript): ThreadTranscript {
  return {
    id: thread.id,
    customer: thread.customer,
    events: thread.events.map((event) => ({ ...event })),
    ...(thread.closedAt === undefined ? {} : { closedAt: thread.closedAt }),
  };
}

function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    outcome: 'answer',
    reply: 'Ответ агента.',
    memoryWrites: [],
    trace: [],
    usage: ZERO_USAGE,
    latencyMs: 10,
    costUsd: 0.001,
    ...overrides,
  };
}

function fullScenario(): Scenario {
  return {
    id: 'runner-story',
    title: 'Runner story',
    world: {
      knowledge_base: 'wiki',
      clock: START,
      customers: {
        alpha: { name: 'Альфа', profile: 'Первый магазин.' },
        beta: { name: 'Бета' },
      },
    },
    knowledge: {
      K1: {
        kind: 'undocumented',
        about: 'product',
        scope: 'customer',
        statement: 'Новая подтверждённая инструкция.',
        source: ['coach-product'],
        documentation_candidate: true,
      },
    },
    steps: [
      {
        id: 'alpha-message',
        type: 'customer_message',
        thread: 'alpha-thread',
        customer: 'alpha',
        at: START,
        content: 'Первый вопрос.',
      },
      { id: 'alpha-agent', type: 'agent_turn', thread: 'alpha-thread' },
      {
        id: 'coach-product',
        type: 'coach_note',
        thread: 'alpha-thread',
        author: 'eng.one',
        at: `${DAY}T10:00:00Z`,
        scope: 'product',
        content: 'Общая заметка.',
      },
      {
        id: 'human-reply',
        type: 'human_reply',
        thread: 'alpha-thread',
        author: 'eng.one',
        at: `${DAY}T10:10:00Z`,
        content: 'Ответ инженера.',
      },
      { id: 'consolidate-one', type: 'consolidate', at: `${DAY}T11:00:00Z` },
      {
        id: 'publish-k1',
        type: 'wiki_update',
        page: 'help',
        knowledge: ['K1'],
        at: `${DAY}T11:30:00Z`,
      },
      {
        id: 'beta-message',
        type: 'customer_message',
        thread: 'beta-thread',
        customer: 'beta',
        at: `${DAY}T12:00:00Z`,
        content: 'Второй вопрос.',
      },
      { id: 'beta-agent', type: 'agent_turn', thread: 'beta-thread' },
      {
        id: 'close-alpha',
        type: 'close_ticket',
        thread: 'alpha-thread',
        at: `${DAY}T12:30:00Z`,
      },
      { id: 'consolidate-two', type: 'consolidate', at: `${DAY}T13:00:00Z` },
    ],
    probes: [
      {
        id: 'recall-beta',
        type: 'memory_recall',
        customer: 'beta',
        query: 'общий факт',
        expect: { recalls: ['K1'] },
      },
      {
        id: 'proposals',
        type: 'documentation_proposals',
        expect: { proposes: ['K1'] },
      },
    ],
  };
}

describe('runScenario', () => {
  it('executes the clocked story, memory paths, wiki updates and probes in order', async () => {
    const engine = new RecordingEngine();
    const sourceWiki = wiki();
    const calls: Array<{ input: TurnInput; options?: RunTurnOptions }> = [];
    const runAgent: RunAgent = async (input, options) => {
      calls.push({ input, options });
      if (input.thread.id === 'beta-thread') {
        expect(input.wiki.readPage('help')).toContain('Новая подтверждённая инструкция.');
        expect(input.memory.map(({ id }) => id)).toEqual(['shared-memory']);
        expect(await options?.recallMemory?.('beta', 'live query', input.now)).toHaveLength(1);
        return turn({ reply: 'Ответ для beta.' });
      }
      return turn({
        outcome: 'escalate',
        reply: 'Передаю инженеру.',
        escalationReason: 'Нужна проверка.',
        memoryWrites: [item({
          id: 'agent-write',
          kind: 'personal',
          about: 'alpha',
          learnedFrom: 'wrong-customer',
          scope: 'shared',
          statement: 'Факт от клиента.',
          source: { thread: 'wrong-thread', via: 'consolidate' },
          createdAt: '2020-01-01T00:00:00Z',
        })],
      });
    };
    const wallTimes = [
      new Date('2026-09-03T12:00:00Z'),
      new Date('2026-09-03T12:00:01Z'),
    ];

    const result = await runScenario(fullScenario(), config(), {
      engine,
      wiki: sourceWiki,
      repeat: 3,
      runAgent,
      wallClock: () => wallTimes.shift() ?? new Date('2026-09-03T12:00:01Z'),
    });

    expect(result.error).toBeUndefined();
    expect(RunResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      scenario: 'runner-story',
      config: 'test-config',
      repeat: 3,
      startedAt: '2026-09-03T12:00:00.000Z',
      finishedAt: '2026-09-03T12:00:01.000Z',
      costUsd: 0.002,
      // No judge in this test, so the two judged probe checks are skipped, never passed.
      score: { pass: 0, partial: 0, fail: 0, skipped: 2 },
    });
    expect(engine.resetCount).toBe(1);
    expect(calls.map(({ input }) => ({
      thread: input.thread.id,
      now: input.now,
      memory: input.memory.map(({ id }) => id),
      tools: input.tools,
    }))).toEqual([
      {
        thread: 'alpha-thread',
        now: START,
        memory: ['shared-memory', 'alpha-private'],
        tools: { recallMemory: true, remember: true },
      },
      {
        thread: 'beta-thread',
        now: `${DAY}T12:00:00Z`,
        memory: ['shared-memory'],
        tools: { recallMemory: true, remember: true },
      },
    ]);
    expect(calls[0]?.input.thread.events).toEqual([
      { type: 'customer_message', at: START, content: 'Первый вопрос.' },
    ]);

    expect(engine.writes).toEqual([[
      expect.objectContaining({
        id: 'agent-alpha-thread-alpha-agent-1',
        learnedFrom: 'alpha',
        scope: 'customer',
        statement: `По состоянию на ${DAY}: Факт от клиента.`,
        source: { thread: 'alpha-thread', step: 'alpha-agent', via: 'agent' },
        createdAt: START,
      }),
    ]]);
    expect(result.steps[0]?.memoryWrites).toEqual(engine.writes[0]);

    expect(engine.consolidations.map(({ id }) => id)).toEqual(['alpha-thread', 'beta-thread']);
    expect(engine.consolidations[0]?.events.map(({ type }) => type)).toEqual([
      'customer_message',
      'agent_reply',
      'coach_note',
      'human_reply',
    ]);
    expect(engine.consolidations[0]?.events[2]).toMatchObject({
      type: 'coach_note',
      scope: 'product',
    });
    expect(result.consolidations.map(({ id, wrote }) => [id, wrote.length])).toEqual([
      ['consolidate-one', 1],
      ['consolidate-two', 1],
    ]);

    expect(result.probes[0]?.returned?.map(({ id }) => id)).toEqual(['shared-memory']);
    expect(result.probes[1]?.returned?.map(({ id }) => id)).toEqual(['proposal']);
    expect(result.probes.flatMap(({ checks }) =>
      checks.map(({ key, verdict, why }) => ({ key, verdict, why })),
    )).toEqual([
      { key: 'recalls:K1', verdict: 'skipped', why: expect.stringContaining('no judge') },
      { key: 'proposes:K1', verdict: 'skipped', why: expect.stringContaining('no judge') },
    ]);
    expect(sourceWiki.readPage('help')).not.toContain('Новая подтверждённая инструкция.');
  });

  it('gives write: agent only new coach notes at consolidation boundaries', async () => {
    const engine = new RecordingEngine();
    const scenario = fullScenario();
    scenario.steps = [
      scenario.steps[0]!,
      scenario.steps[1]!,
      scenario.steps[2]!,
      scenario.steps[4]!,
      {
        id: 'alpha-message-two',
        type: 'customer_message',
        thread: 'alpha-thread',
        customer: 'alpha',
        at: `${DAY}T12:00:00Z`,
        content: 'Ещё вопрос.',
      },
      { id: 'alpha-agent-two', type: 'agent_turn', thread: 'alpha-thread' },
      { id: 'consolidate-two', type: 'consolidate', at: `${DAY}T13:00:00Z` },
    ];
    scenario.probes = undefined;
    const calls: TurnInput[] = [];

    const result = await runScenario(scenario, config({ read: 'tool', write: 'agent' }), {
      engine,
      wiki: wiki(),
      runAgent: async (input) => {
        calls.push(input);
        return turn({ costUsd: undefined });
      },
    });

    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls.every(({ memory }) => memory.length === 0)).toBe(true);
    expect(calls.every(({ tools }) => tools.recallMemory && tools.remember)).toBe(true);
    expect(engine.recalls).toEqual([]);
    expect(engine.consolidations).toHaveLength(2);
    expect(engine.consolidations[0]?.events).toEqual([
      expect.objectContaining({ type: 'coach_note', scope: 'product', content: 'Общая заметка.' }),
    ]);
    expect(engine.consolidations[1]?.events).toEqual([]);
  });

  it('runs N isolated repeats and resets the engine before each one', async () => {
    const engine = new RecordingEngine();
    const scenario = fullScenario();
    scenario.steps = [scenario.steps[5]!];
    scenario.probes = undefined;
    const sourceWiki = wiki();

    const results = await runScenarioRepeats(scenario, config(), 2, { engine, wiki: sourceWiki });

    expect(results.map(({ repeat }) => repeat)).toEqual([1, 2]);
    expect(results.every(({ error }) => error === undefined)).toBe(true);
    expect(engine.resetCount).toBe(2);
    expect(sourceWiki.readPage('help')).not.toContain('Новая подтверждённая инструкция.');
  });

  it('preserves completed steps when a later agent turn fails', async () => {
    const engine = new RecordingEngine();
    let call = 0;
    const result = await runScenario(fullScenario(), config(), {
      engine,
      wiki: wiki(),
      runAgent: async () => {
        call += 1;
        if (call === 2) throw new Error('model unavailable');
        return turn();
      },
    });

    expect(result.steps).toHaveLength(1);
    expect(result.error).toBe('Error: model unavailable');
    expect(RunResultSchema.safeParse(result).success).toBe(true);
  });

  it('scores deterministic checks before judged ones and bills the judge to the run', async () => {
    const scenario = fullScenario();
    scenario.steps = [
      scenario.steps[0]!,
      { id: 'alpha-agent', type: 'agent_turn', thread: 'alpha-thread', expect: {
        outcome: 'escalate',
        uses: ['K1'],
        reply: { must: ['/1153/'] },
      } },
    ];
    scenario.probes = undefined;
    const judge: Judge = {
      spec: { provider: 'openai', model: 'gpt-5.4' },
      async turn() {
        return {
          checks: [{ key: 'uses:K1', verdict: 'pass', judgePrompt: 'FACT: …' }],
          usage: ZERO_USAGE,
          costUsd: 0.0005,
        };
      },
      async probe() {
        throw new Error('no probes in this scenario');
      },
    };

    const result = await runScenario(scenario, config(), {
      engine: new RecordingEngine(),
      wiki: wiki(),
      judge,
      runAgent: async () => turn({ outcome: 'escalate', reply: 'Заказ 1153 у инженера.' }),
    });

    expect(result.steps[0]?.checks).toEqual([
      { key: 'outcome', verdict: 'pass' },
      { key: 'reply.must[0]', verdict: 'pass' },
      { key: 'uses:K1', verdict: 'pass', judgePrompt: 'FACT: …' },
    ]);
    expect(result.score).toEqual({ pass: 3, partial: 0, fail: 0, skipped: 0 });
    expect(result.costUsd).toBeCloseTo(0.0015, 10);
    // The model that actually judged, which the D9 fallback can make differ from the config.
    expect(result.judge).toEqual({ provider: 'openai', model: 'gpt-5.4' });
    expect(RunResultSchema.safeParse(result).success).toBe(true);
  });

  it('keeps an agent result and its cost when persisting memory fails afterward', async () => {
    const scenario = fullScenario();
    scenario.steps = [scenario.steps[0]!, scenario.steps[1]!];
    scenario.probes = undefined;
    const result = await runScenario(scenario, config(), {
      engine: new FailingWriteEngine(),
      wiki: wiki(),
      runAgent: async () => turn({ memoryWrites: [item({ id: 'attempted-write' })] }),
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.memoryWrites).toHaveLength(1);
    expect(result.costUsd).toBe(0.001);
    expect(result.error).toBe('Error: write failed');
  });
});
