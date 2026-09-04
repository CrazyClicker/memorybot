import { describe, expect, it } from 'vitest';

import { ZERO_USAGE } from '../llm/index.ts';
import {
  clockMs,
  expiryMs,
  compilePattern,
  ConfigSchema,
  MemoryItemSchema,
  PatternSchema,
  patternProblem,
  RunResultSchema,
  ScenarioSchema,
  TokenUsageSchema,
} from './schema.ts';

function firstIssue(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  if (result.success || result.error === undefined) throw new Error('expected a failure');
  const issue = result.error.issues[0];
  if (issue === undefined) throw new Error('expected at least one issue');
  return { path: issue.path.join('.'), message: issue.message };
}

describe('PatternSchema', () => {
  it('accepts substrings and regex literals', () => {
    for (const pattern of ['BOM', 'артикул', '/10 сентября|10\\.09/', '/P-00\\d/i', '/x/su']) {
      expect(PatternSchema.safeParse(pattern).success, pattern).toBe(true);
    }
  });

  it('rejects a regex that does not compile', () => {
    const result = PatternSchema.safeParse('/(/');
    expect(result.success).toBe(false);
    expect(firstIssue(result).message).toMatch(/invalid pattern \/\(\//);
  });

  it('rejects unknown, global and sticky flags', () => {
    expect(patternProblem('/a/zz')).toMatch(/flags/i);
    expect(patternProblem('/a/g')).toMatch(/"g"/);
    expect(patternProblem('/a/gy')).toMatch(/"gy"/);
    expect(patternProblem('/a/i')).toBeUndefined();
    expect(patternProblem('plain')).toBeUndefined();
  });

  it('rejects the empty string', () => {
    expect(PatternSchema.safeParse('').success).toBe(false);
  });
});

describe('compilePattern', () => {
  it('matches a substring case-insensitively and literally', () => {
    expect(compilePattern('артикул').test('Ваш АРТИКУЛ')).toBe(true);
    expect(compilePattern('10.09').test('до 10.09')).toBe(true);
    expect(compilePattern('10.09').test('10x09')).toBe(false);
  });

  it('keeps a regex literal and its flags', () => {
    const re = compilePattern('/18[:.]00/');
    expect(re.test('к 18:00')).toBe(true);
    expect(re.test('к 18-00')).toBe(false);
    expect(compilePattern('/bom/i').flags).toBe('i');
    expect(compilePattern('/bom/').test('BOM')).toBe(false);
  });
});

const minimalScenario = {
  id: 'minimal',
  title: 'Minimal',
  world: {
    knowledge_base: 'wiki',
    clock: '2026-09-01T09:00:00Z',
    customers: { alfa: { name: 'Альфа', profile: 'Магазин.' } },
  },
  knowledge: {
    K1: { kind: 'personal', about: 'alfa', statement: 'Факт.', source: ['a1-open'] },
  },
  steps: [
    {
      id: 'a1-open',
      type: 'customer_message',
      thread: 'tkt_alfa_1',
      customer: 'alfa',
      at: '2026-09-01T09:00:00Z',
      content: 'Вопрос.',
    },
    { id: 'a1-agent', type: 'agent_turn', thread: 'tkt_alfa_1', expect: { outcome: 'answer' } },
    {
      id: 'a1-note',
      type: 'coach_note',
      thread: 'tkt_alfa_1',
      author: 'eng.oleg',
      at: '2026-09-01T10:00:00Z',
      content: 'Заметка.',
    },
  ],
};

/** The minimal scenario with the agent turn's `expect` replaced. */
function withExpect(expect: unknown): unknown {
  const steps: unknown[] = structuredClone(minimalScenario.steps);
  steps[1] = { ...(steps[1] as object), expect };
  return { ...minimalScenario, steps };
}

describe('ScenarioSchema', () => {
  it('parses a minimal scenario and fills the scope defaults', () => {
    const parsed = ScenarioSchema.parse(minimalScenario);
    expect(parsed.knowledge['K1']?.scope).toBe('customer');
    expect(parsed.steps[1]).toMatchObject({ type: 'agent_turn' });
    expect(parsed.steps[1]).not.toHaveProperty('at');
    expect(parsed.steps[2]).toMatchObject({ type: 'coach_note', scope: 'customer' });
  });

  it('rejects unknown keys, naming where they are', () => {
    const result = ScenarioSchema.safeParse(withExpect({ must_not_used: ['K1'] }));
    const issue = firstIssue(result);
    expect(issue.path).toBe('steps.1.expect');
    expect(issue.message).toMatch(/must_not_used/);
  });

  it('rejects a timestamp without a timezone', () => {
    const result = ScenarioSchema.safeParse({
      ...minimalScenario,
      world: { ...minimalScenario.world, clock: '2026-09-01T09:00:00' },
    });
    expect(firstIssue(result).path).toBe('world.clock');
  });

  it('rejects knowledge ids that are not K<n>', () => {
    for (const bad of ['K01', 'k1', 'fact']) {
      const result = ScenarioSchema.safeParse({ ...minimalScenario, knowledge: { [bad]: minimalScenario.knowledge.K1 } });
      expect(result.success, bad).toBe(false);
    }
  });

  it('rejects an unknown step type with the known ones', () => {
    const steps = [{ id: 'x', type: 'internal_discussion', at: '2026-09-01T09:00:00Z' }];
    const result = ScenarioSchema.safeParse({ ...minimalScenario, steps });
    expect(firstIssue(result).message).toMatch(/coach_note/);
  });

  it('rejects a bad pattern inside reply.must', () => {
    const issue = firstIssue(ScenarioSchema.safeParse(withExpect({ reply: { must: ['/(/'] } })));
    expect(issue.path).toBe('steps.1.expect.reply.must.0');
  });
});

describe('ConfigSchema', () => {
  const config = {
    id: 'notes',
    agent: { provider: 'openai', model: 'gpt-4o-mini', temperature: 0 },
    memory: { engine: 'notes', read: 'hydrate', write: 'consolidate' },
    judge: { provider: 'anthropic', model: 'claude-sonnet-5' },
  };

  it('parses a config file', () => {
    expect(ConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects an unknown engine or read mode', () => {
    expect(ConfigSchema.safeParse({ ...config, memory: { ...config.memory, engine: 'flywheel' } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...config, memory: { ...config.memory, read: 'prompt' } }).success).toBe(false);
  });
});

describe('result schemas', () => {
  const item = {
    id: 'n1',
    kind: 'temporal',
    about: 'product',
    learnedFrom: 'kofe_tochka',
    scope: 'shared',
    statement: 'По состоянию на 2026-09-05: сбой.',
    validUntil: '2026-09-05T18:00:00Z',
    source: { thread: 'tkt_kofe_tochka_1', step: 't1-coach-note-product', via: 'consolidate' },
    createdAt: '2026-09-05T14:00:00Z',
  };

  it('parses a memory item and requires its write source', () => {
    expect(MemoryItemSchema.parse(item)).toEqual(item);
    const { source: _source, ...withoutSource } = item;
    expect(MemoryItemSchema.safeParse(withoutSource).success).toBe(false);
  });

  it('parses a run result', () => {
    const run = {
      scenario: 'payment-provider-incident',
      config: 'notes',
      repeat: 1,
      startedAt: '2026-09-03T12:00:00Z',
      steps: [
        {
          id: 't2-agent',
          thread: 'tkt_lavanda_1',
          at: '2026-09-05T15:00:00Z',
          outcome: 'answer',
          reply: 'Это сбой на стороне «Оплатим».',
          trace: [{ step: 1, text: 'ok', toolCalls: [{ tool: 'read_page', input: { slug: 'platezhi-i-vyplaty' }, output: '…' }], usage: ZERO_USAGE }],
          memoryWrites: [],
          checks: [
            { key: 'outcome', verdict: 'pass' },
            { key: 'uses:K1', verdict: 'partial', why: 'no recovery time', judgePrompt: '…' },
          ],
          usage: ZERO_USAGE,
          latencyMs: 1200,
        },
      ],
      consolidations: [{ id: 'consolidate-1', at: '2026-09-05T14:00:00Z', wrote: [item] }],
      probes: [{ id: 'recall-lavanda', checks: [{ key: 'recalls:K1', verdict: 'skipped' }] }],
      score: { pass: 1, partial: 1, fail: 0, skipped: 1 },
      costUsd: 0.0004,
    };
    expect(RunResultSchema.safeParse(run).success).toBe(true);
  });

  it('shares the token usage shape with src/llm', () => {
    expect(TokenUsageSchema.parse(ZERO_USAGE)).toEqual(ZERO_USAGE);
  });
});

describe('clockMs', () => {
  it('reads a bare date as midnight UTC and a timestamp as itself', () => {
    expect(clockMs('2026-09-10')).toBe(Date.UTC(2026, 8, 10));
    expect(clockMs('2026-09-05T18:00:00Z')).toBe(Date.UTC(2026, 8, 5, 18));
    expect(clockMs('2026-09-05T18:00:00+03:00')).toBe(Date.UTC(2026, 8, 5, 15));
  });
});

describe('expiryMs', () => {
  // A date-only expiry is a day, not an instant: an extractor that wrote `2026-09-05` for an
  // incident recovering at 18:00 that day must not make the note read expired at 15:00.
  it('covers the whole day a bare date names', () => {
    expect(expiryMs('2026-09-05')).toBe(Date.UTC(2026, 8, 5, 23, 59, 59, 999));
    expect(expiryMs('2026-09-05')).toBeGreaterThan(Date.UTC(2026, 8, 5, 15));
    expect(expiryMs('2026-09-05')).toBeLessThan(Date.UTC(2026, 8, 6));
  });

  it('takes a timestamp as the exact instant', () => {
    expect(expiryMs('2026-09-05T18:00:00Z')).toBe(Date.UTC(2026, 8, 5, 18));
    expect(expiryMs('2026-09-05T18:00:00+03:00')).toBe(Date.UTC(2026, 8, 5, 15));
  });
});
