import { describe, expect, it } from 'vitest';

import { checkProbePatterns, checkTurn, memoryText, scoreOf } from './checks.ts';
import type { Expect, MemoryItem, Probe } from './schema.ts';

function turn(overrides: Partial<Parameters<typeof checkTurn>[1]> = {}) {
  return { outcome: 'answer' as const, reply: 'Ответ агента.', ...overrides };
}

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'memory-1',
    kind: 'personal',
    about: 'kofe_tochka',
    learnedFrom: 'kofe_tochka',
    scope: 'customer',
    statement: 'По состоянию на 2026-09-05: заказ 1153 остался без оплаты.',
    source: { thread: 'tkt-1', via: 'consolidate' },
    createdAt: '2026-09-05T14:00:00Z',
    ...overrides,
  };
}

function recallProbe(expectations: Probe['expect'] = {}): Probe {
  return {
    id: 'recall-kofe-tochka',
    type: 'memory_recall',
    customer: 'kofe_tochka',
    query: 'заказ 1153',
    expect: expectations,
  };
}

describe('checkTurn', () => {
  it('produces no checks for a turn the scenario does not judge', () => {
    expect(checkTurn(undefined, turn())).toEqual([]);
    expect(checkTurn({}, turn())).toEqual([]);
  });

  it('scores the outcome, tolerating what the scenario tolerates', () => {
    const expectation: Expect = { outcome: 'escalate', tolerated: ['answer'] };
    expect(checkTurn(expectation, turn({ outcome: 'escalate' }))).toEqual([
      { key: 'outcome', verdict: 'pass' },
    ]);
    expect(checkTurn(expectation, turn({ outcome: 'answer' }))).toEqual([
      { key: 'outcome', verdict: 'partial', why: 'expected "escalate", got tolerated "answer"' },
    ]);
    expect(checkTurn(expectation, turn({ outcome: 'ask' }))).toEqual([
      { key: 'outcome', verdict: 'fail', why: 'expected "escalate", got "ask"' },
    ]);
  });

  it('matches reply patterns as regexes or case-insensitive substrings', () => {
    const checks = checkTurn(
      { reply: { must: ['/1153/', 'ЗАКАЗ'], must_not: ['/оплатим/i', 'скидка'] } },
      turn({ reply: 'Заказ 1153 уже у инженера.' }),
    );
    expect(checks.map(({ key, verdict }) => [key, verdict])).toEqual([
      ['reply.must[0]', 'pass'],
      ['reply.must[1]', 'pass'],
      ['reply.must_not[0]', 'pass'],
      ['reply.must_not[1]', 'pass'],
    ]);
  });

  it('explains which side of a pattern failed', () => {
    const checks = checkTurn(
      { reply: { must: ['/1153/'], must_not: ['/инженер/i'] } },
      turn({ reply: 'Передал инженеру.' }),
    );
    expect(checks).toEqual([
      { key: 'reply.must[0]', verdict: 'fail', why: 'the reply does not match /1153/' },
      { key: 'reply.must_not[0]', verdict: 'fail', why: 'the reply matches /инженер/i' },
    ]);
  });

  it('matches escalation.reason_must against the internal reason', () => {
    const expectation: Expect = { escalation: { reason_must: ['/двойн(ое|ого) списани/i'] } };
    expect(
      checkTurn(expectation, turn({ outcome: 'escalate', escalationReason: 'Двойное списание.' })),
    ).toEqual([{ key: 'escalation.reason_must[0]', verdict: 'pass' }]);
  });

  it('fails an expected escalation reason when the turn did not escalate', () => {
    expect(checkTurn({ escalation: { reason_must: ['/деньг/i'] } }, turn())).toEqual([
      {
        key: 'escalation.reason_must[0]',
        verdict: 'fail',
        why: 'no escalation reason: the turn ended as "answer"',
      },
    ]);
  });
});

describe('checkProbePatterns', () => {
  it('tests must_not against the text of what the engine returned', () => {
    const probe = recallProbe({ must_not: ['/115[235]/', '/Антон/'] });
    expect(checkProbePatterns(probe, [item()])).toEqual([
      { key: 'must_not[0]', verdict: 'fail', why: 'what the engine returned matches /115[235]/' },
      { key: 'must_not[1]', verdict: 'pass' },
    ]);
  });

  it('skips, never fails, when the engine cannot serve the probe', () => {
    const probe: Probe = {
      id: 'no-documentation-candidates',
      type: 'documentation_proposals',
      expect: { must_not: ['/кофе-точка/i'] },
    };
    expect(checkProbePatterns(probe, undefined)).toEqual([
      {
        key: 'must_not[0]',
        verdict: 'skipped',
        why: 'proposals() is not served by this engine',
      },
    ]);
  });

  it('has nothing to check without must_not patterns', () => {
    expect(checkProbePatterns(recallProbe({ recalls: ['K1'] }), [item()])).toEqual([]);
  });
});

describe('memoryText', () => {
  it('joins statements one per line', () => {
    expect(memoryText([item({ statement: 'Первый.' }), item({ statement: 'Второй.' })])).toBe(
      'Первый.\nВторой.',
    );
  });
});

describe('scoreOf', () => {
  it('counts verdicts', () => {
    expect(
      scoreOf([
        { key: 'a', verdict: 'pass' },
        { key: 'b', verdict: 'pass' },
        { key: 'c', verdict: 'partial' },
        { key: 'd', verdict: 'fail' },
        { key: 'e', verdict: 'skipped' },
      ]),
    ).toEqual({ pass: 2, partial: 1, fail: 1, skipped: 1 });
  });
});
