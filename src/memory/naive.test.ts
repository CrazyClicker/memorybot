import { describe, expect, it } from 'vitest';

import type { MemoryItem, ThreadTranscript } from './engine.ts';
import { estimateTokens, NaiveMemoryEngine, renderTranscript } from './naive.ts';

const NOW = '2026-09-03T12:00:00Z';

function item(
  id: string,
  learnedFrom: string,
  options: Partial<MemoryItem> = {},
): MemoryItem {
  return {
    id,
    kind: 'personal',
    about: learnedFrom,
    learnedFrom,
    scope: 'customer',
    statement: `По состоянию на 2026-09-03: ${id}`,
    source: { thread: `thread-${learnedFrom}`, via: 'agent' },
    createdAt: NOW,
    ...options,
  };
}

describe('NaiveMemoryEngine', () => {
  it('returns matching log entries newest first, regardless of the query', async () => {
    const engine = new NaiveMemoryEngine();
    await engine.write([item('a-old', 'alfa'), item('beta-only', 'beta')], NOW);
    await engine.write([
      item('shared', 'alfa', { about: 'product', scope: 'shared' }),
      item('a-new', 'alfa'),
    ], NOW);

    expect((await engine.recall('alfa', 'does not rank this', NOW)).map(({ id }) => id)).toEqual([
      'a-new',
      'shared',
      'a-old',
    ]);
    expect((await engine.recall('beta', 'anything', NOW)).map(({ id }) => id)).toEqual([
      'shared',
      'beta-only',
    ]);
  });

  it('allows the learner to recall a customer-scoped product fact without leaking it', async () => {
    const engine = new NaiveMemoryEngine();
    await engine.write([item('product-private', 'alfa', { about: 'product' })], NOW);
    expect((await engine.recall('alfa', '', NOW)).map(({ id }) => id)).toEqual(['product-private']);
    expect(await engine.recall('beta', '', NOW)).toEqual([]);
  });

  it('dates undated explicit writes and does not expose mutable engine state', async () => {
    const engine = new NaiveMemoryEngine();
    const original = item('mutable', 'alfa', { statement: 'Личный факт.' });
    await engine.write([original], NOW);

    const first = await engine.recall('alfa', '', NOW);
    expect(first[0]?.statement).toBe('По состоянию на 2026-09-03: Личный факт.');
    if (first[0] !== undefined) first[0].statement = 'Изменено снаружи.';
    expect((await engine.recall('alfa', '', NOW))[0]?.statement).toContain('Личный факт.');
    expect(original.statement).toBe('Личный факт.');
  });

  it('stops at the token budget instead of returning older entries that fit around it', async () => {
    const costs: Record<string, number> = { oldest: 1, middle: 2, newest: 2 };
    const engine = new NaiveMemoryEngine({
      maxRecallTokens: 4,
      countTokens: (text) => costs[text.split(': ').at(-1) ?? ''] ?? 0,
    });
    await engine.write([item('oldest', 'alfa'), item('middle', 'alfa'), item('newest', 'alfa')], NOW);

    expect((await engine.recall('alfa', '', NOW)).map(({ id }) => id)).toEqual(['newest', 'middle']);
  });

  it('appends an opaque, dated whole transcript and resets deterministic state', async () => {
    const engine = new NaiveMemoryEngine();
    const thread: ThreadTranscript = {
      id: 'thread-alfa-1',
      customer: 'alfa',
      events: [
        { type: 'customer_message', at: '2026-09-03T09:00:00Z', content: 'Где товары?' },
        { type: 'human_reply', at: '2026-09-03T10:00:00Z', author: 'eng.anna', content: 'Проверяем импорт.' },
        { type: 'coach_note', at: '2026-09-03T10:05:00Z', author: 'eng.anna', content: 'Сохрани контекст.' },
      ],
      closedAt: '2026-09-03T11:00:00Z',
    };

    const [written] = await engine.consolidate(thread, NOW);
    expect(written).toMatchObject({
      id: 'naive-thread-alfa-1-1',
      kind: 'other',
      about: 'alfa',
      learnedFrom: 'alfa',
      scope: 'customer',
      source: { thread: 'thread-alfa-1', via: 'consolidate' },
      createdAt: NOW,
    });
    expect(written?.statement).toContain('По состоянию на 2026-09-03: История обращения thread-alfa-1:');
    expect(written?.statement).toContain('[2026-09-03T10:00:00Z] Сотрудник поддержки (eng.anna): Проверяем импорт.');
    expect(written?.statement).toContain('[2026-09-03T11:00:00Z] Обращение закрыто.');
    expect((await engine.recall('alfa', '', NOW))[0]).toEqual(written);

    await engine.reset();
    expect(await engine.recall('alfa', '', NOW)).toEqual([]);
    expect((await engine.consolidate(thread, NOW))[0]?.id).toBe('naive-thread-alfa-1-1');
  });

  it('broadcasts only product-scoped coach notes while keeping the transcript customer-scoped', async () => {
    const engine = new NaiveMemoryEngine();
    const thread: ThreadTranscript = {
      id: 'thread-alfa-incident',
      customer: 'alfa',
      events: [
        {
          type: 'coach_note',
          scope: 'product',
          at: NOW,
          content: 'Карточные платежи временно недоступны.',
        },
        {
          type: 'coach_note',
          scope: 'customer',
          at: NOW,
          content: 'У клиента спор по заказу 1153.',
        },
      ],
    };

    const written = await engine.consolidate(thread, NOW);
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({ about: 'product', scope: 'shared', learnedFrom: 'alfa' });
    expect((await engine.recall('beta', 'платежи', NOW)).map(({ statement }) => statement)).toEqual([
      'По состоянию на 2026-09-03: Карточные платежи временно недоступны.',
    ]);
    expect((await engine.recall('beta', 'заказ', NOW)).map(({ statement }) => statement).join('\n')).not.toContain('1153');
  });

  it('does not create an empty transcript entry', async () => {
    const engine = new NaiveMemoryEngine();
    expect(await engine.consolidate({ id: 'empty', customer: 'alfa', events: [] }, NOW)).toEqual([]);
  });

  it('provides a conservative deterministic default token estimate', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('тест')).toBe(2);
  });
});
