import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { createJudge, createSkipJudge, type KnowledgeMap } from './judge.ts';
import type { Expect, MemoryItem, ModelSpec, Probe } from './schema.ts';

const SPEC: ModelSpec = { provider: 'anthropic', model: 'claude-sonnet-5' };

const KNOWLEDGE: KnowledgeMap = {
  K1: {
    kind: 'temporal',
    about: 'product',
    scope: 'shared',
    statement: '«Оплатим» не проводит карты с 12:00 5 сентября, QR работает.',
    source: ['coach-incident'],
    valid_until: '2026-09-05T18:00:00Z',
  },
  K2: {
    kind: 'personal',
    about: 'kofe_tochka',
    scope: 'customer',
    statement: 'По заказу 1153 деньги списаны, а заказ не оплачен.',
    source: ['coach-customer'],
  },
};

type MockGenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const USAGE: MockGenerateResult['usage'] = {
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

/** One judge answer. `Output.object` reads the model's text, so the mock returns JSON. */
function verdict(value: 'pass' | 'partial' | 'fail', why = 'because'): MockGenerateResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ verdict: value, why }) }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

/** Records every prompt the judge sends and replies with the queued verdicts, in order. */
function mockJudge(answers: MockGenerateResult[]) {
  const prompts: string[] = [];
  const queue = [...answers];
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      const next = queue.shift();
      if (next === undefined) throw new Error('the judge asked more questions than expected');
      return next;
    },
  });
  return { judge: createJudge(SPEC, { model }), prompts, remaining: () => queue.length };
}

function turn(reply: string) {
  return { outcome: 'answer' as const, reply };
}

function item(statement: string): MemoryItem {
  return {
    id: 'memory-1',
    kind: 'personal',
    about: 'kofe_tochka',
    learnedFrom: 'kofe_tochka',
    scope: 'customer',
    statement,
    source: { thread: 'tkt-1', via: 'consolidate' },
    createdAt: '2026-09-05T14:00:00Z',
  };
}

describe('createJudge().turn', () => {
  it('judges uses, must_not_use and the rubric, and logs every prompt', async () => {
    const { judge, prompts } = mockJudge([
      verdict('pass', 'names the outage and the QR workaround'),
      verdict('fail', 'says nothing about order 1153'),
      verdict('partial', 'relays the incident but does not date it'),
    ]);
    const expectation: Expect = {
      uses: ['K1'],
      must_not_use: ['K2'],
      reply: { rubric: 'Relays the incident and its end time without escalating again.' },
    };

    const judged = await judge.turn(expectation, turn('Сбой у «Оплатим», примите оплату по QR.'), KNOWLEDGE);

    expect(judged.checks.map(({ key, verdict: v, why }) => ({ key, verdict: v, why }))).toEqual([
      { key: 'uses:K1', verdict: 'pass', why: 'names the outage and the QR workaround' },
      { key: 'must_not_use:K2', verdict: 'pass', why: 'says nothing about order 1153' },
      { key: 'reply.rubric', verdict: 'partial', why: 'relays the incident but does not date it' },
    ]);
    expect(judged.checks.every((check) => check.judgePrompt !== undefined)).toBe(true);
    expect(prompts).toHaveLength(3);
    expect(judged.usage.inputTokens).toBe(3_000);
    // 3 × (1000 input @ $2/Mtok + 100 output @ $10/Mtok)
    expect(judged.costUsd).toBeCloseTo(0.009, 10);
  });

  it('asks the same question for uses and must_not_use, and inverts only the verdict', async () => {
    const positive = mockJudge([verdict('pass')]);
    const negative = mockJudge([verdict('pass')]);
    const reply = 'Карты у «Оплатим» временно не проходят, работает QR.';

    const used = await positive.judge.turn({ uses: ['K1'] }, turn(reply), KNOWLEDGE);
    const isolated = await negative.judge.turn({ must_not_use: ['K1'] }, turn(reply), KNOWLEDGE);

    expect(used.checks[0]?.verdict).toBe('pass');
    expect(isolated.checks[0]?.verdict).toBe('fail');
    expect(positive.prompts).toEqual(negative.prompts);
    expect(used.checks[0]?.judgePrompt).toContain(KNOWLEDGE['K1']?.statement);
    expect(used.checks[0]?.judgePrompt).toContain(reply);
  });

  it('keeps a partial verdict partial when inverted', async () => {
    const { judge } = mockJudge([verdict('partial')]);
    const judged = await judge.turn({ must_not_use: ['K1'] }, turn('Что-то про оплату.'), KNOWLEDGE);
    expect(judged.checks[0]?.verdict).toBe('partial');
  });

  it('calls nothing for a turn with no judged expectation', async () => {
    const { judge, prompts } = mockJudge([]);
    expect(await judge.turn(undefined, turn('Ответ.'), KNOWLEDGE)).toMatchObject({ checks: [] });
    expect(await judge.turn({ outcome: 'answer' }, turn('Ответ.'), KNOWLEDGE)).toMatchObject({
      checks: [],
      costUsd: 0,
    });
    expect(prompts).toEqual([]);
  });

  it('decides an empty reply without paying for a call', async () => {
    const { judge, prompts } = mockJudge([]);
    const judged = await judge.turn({ uses: ['K1'], must_not_use: ['K2'] }, turn('  '), KNOWLEDGE);
    expect(judged.checks.map(({ key, verdict: v }) => [key, v])).toEqual([
      ['uses:K1', 'fail'],
      ['must_not_use:K2', 'pass'],
    ]);
    expect(judged.costUsd).toBe(0);
    expect(prompts).toEqual([]);
  });

  it('rejects a knowledge id the scenario does not define', async () => {
    const { judge } = mockJudge([]);
    await expect(judge.turn({ uses: ['K9'] }, turn('Ответ.'), KNOWLEDGE)).rejects.toThrow(
      'Unknown knowledge item "K9"',
    );
  });
});

describe('createJudge().probe', () => {
  const recallProbe: Probe = {
    id: 'recall-kofe-tochka',
    type: 'memory_recall',
    customer: 'kofe_tochka',
    query: 'заказ 1153',
    expect: { recalls: ['K2'], must_not_recall: ['K1'] },
  };

  it('judges recalls and must_not_recall against the recalled statements', async () => {
    const { judge } = mockJudge([verdict('pass'), verdict('fail')]);
    const returned = [item('По состоянию на 2026-09-05: по заказу 1153 деньги списаны без оплаты.')];

    const judged = await judge.probe(recallProbe, returned, KNOWLEDGE);

    expect(judged.checks.map(({ key, verdict: v }) => [key, v])).toEqual([
      ['recalls:K2', 'pass'],
      ['must_not_recall:K1', 'pass'],
    ]);
    expect(judged.checks[0]?.judgePrompt).toContain('заказу 1153 деньги списаны');
  });

  it('decides an empty recall without a call', async () => {
    const { judge, prompts } = mockJudge([]);
    const judged = await judge.probe(recallProbe, [], KNOWLEDGE);
    expect(judged.checks).toEqual([
      { key: 'recalls:K2', verdict: 'fail', why: 'recall returned nothing' },
      { key: 'must_not_recall:K1', verdict: 'pass', why: 'recall returned nothing' },
    ]);
    expect(prompts).toEqual([]);
  });

  it('skips a proposals probe the engine cannot serve', async () => {
    const { judge, prompts } = mockJudge([]);
    const probe: Probe = {
      id: 'no-documentation-candidates',
      type: 'documentation_proposals',
      expect: { proposes: ['K1'] },
    };
    expect(await judge.probe(probe, undefined, KNOWLEDGE)).toEqual({
      checks: [
        {
          key: 'proposes:K1',
          verdict: 'skipped',
          why: 'proposals() is not served by this engine',
        },
      ],
      usage: {
        inputTokens: 0,
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
      costUsd: 0,
    });
    expect(prompts).toEqual([]);
  });
});

describe('judge failures', () => {
  it('reports a judge outage as skipped and keeps the prompt for the audit', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('503 upstream');
      },
    });
    const judged = await createJudge(SPEC, { model }).turn(
      { uses: ['K1'] },
      turn('Ответ.'),
      KNOWLEDGE,
    );
    expect(judged.checks[0]).toMatchObject({
      key: 'uses:K1',
      verdict: 'skipped',
      why: 'judge unavailable: 503 upstream',
    });
    expect(judged.checks[0]?.judgePrompt).toContain('FACT:');
  });

  it('createSkipJudge names its reason on every judged check', async () => {
    const judged = await createSkipJudge('no judge configured for this run').turn(
      { uses: ['K1'], reply: { rubric: 'Anything.' } },
      turn('Ответ.'),
      KNOWLEDGE,
    );
    expect(judged.checks.map(({ key, verdict: v, why }) => ({ key, verdict: v, why }))).toEqual([
      {
        key: 'uses:K1',
        verdict: 'skipped',
        why: 'judge unavailable: no judge configured for this run',
      },
      {
        key: 'reply.rubric',
        verdict: 'skipped',
        why: 'judge unavailable: no judge configured for this run',
      },
    ]);
    expect(judged.costUsd).toBe(0);
  });
});
