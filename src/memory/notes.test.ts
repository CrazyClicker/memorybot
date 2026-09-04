import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';

import type { Config, MemoryItem, Scenario } from '../evals/schema.ts';
import { createMemoryEngine, runScenario } from '../evals/runner.ts';
import { NotesMemoryEngine } from './notes.ts';
import type { ThreadTranscript } from './engine.ts';

const NOW = '2026-09-03T12:00:00Z';
const SPEC = { provider: 'openai', model: 'gpt-4o-mini', temperature: 0 } as const;
type MockGenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const USAGE: MockGenerateResult['usage'] = {
  inputTokens: { total: 1_000, noCache: 800, cacheRead: 200, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

function extraction(notes: unknown[]): MockGenerateResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        notes: notes.map((note) => ({ valid_until: null, ...(note as object) })),
      }),
    }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

function model(answers: MockGenerateResult[] | MockGenerateResult = []) {
  return new MockLanguageModelV4({ doGenerate: answers });
}

function thread(events?: ThreadTranscript['events']): ThreadTranscript {
  return {
    id: 'ticket-alpha',
    customer: 'alpha',
    events: events ?? [
      {
        type: 'customer_message',
        at: '2026-09-01T09:00:00Z',
        content: 'Мы используем двухстадийную оплату.',
      },
      {
        type: 'human_reply',
        author: 'support.anna',
        at: '2026-09-01T10:00:00Z',
        content: 'Проверили импортёр.',
      },
      {
        type: 'coach_note',
        author: 'eng.ivan',
        scope: 'product',
        at: '2026-09-02T14:00:00Z',
        content: 'Карты не проходят до 18:00, QR работает.',
      },
      {
        type: 'coach_note',
        author: 'eng.ivan',
        scope: 'customer',
        at: '2026-09-02T15:00:00Z',
        content: 'BOM ломает заголовок первой колонки.',
      },
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
    statement: `По состоянию на 2026-09-01: ${id}`,
    source: { thread: 'ticket-alpha', via: 'agent' },
    createdAt: '2026-09-01T09:00:00Z',
    ...overrides,
  };
}

const openEngines: NotesMemoryEngine[] = [];
const tempDirs: string[] = [];

function engine(mock = model(), options: Partial<ConstructorParameters<typeof NotesMemoryEngine>[0]> = {}) {
  const result = new NotesMemoryEngine({ modelSpec: SPEC, model: mock, ...options });
  openEngines.push(result);
  return result;
}

afterEach(async () => {
  for (const value of openEngines.splice(0)) value.close();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('NotesMemoryEngine consolidation', () => {
  it('maps structured output into dated, scoped notes and charges the extraction call', async () => {
    const mock = model(extraction([
      {
        kind: 'personal',
        about: 'alpha',
        statement: 'Магазин использует двухстадийную оплату.',
        source_events: [1],
      },
      {
        kind: 'temporal',
        about: 'product',
        statement: 'Карты временно не проходят, QR работает.',
        valid_until: '2026-09-02T18:00:00Z',
        source_events: [3],
      },
      {
        kind: 'undocumented',
        about: 'product',
        statement: 'BOM мешает распознать заголовок первой колонки.',
        source_events: [2, 4],
      },
      {
        kind: 'other',
        about: 'alpha',
        statement: 'Временная метка у нетемпоральной заметки отбрасывается.',
        valid_until: '2026-09-10',
        source_events: [1],
      },
    ]));
    const notes = engine(mock);

    const written = await notes.consolidate(thread(), NOW);

    expect(written).toEqual([
      expect.objectContaining({
        id: 'notes-1',
        kind: 'personal',
        about: 'alpha',
        learnedFrom: 'alpha',
        scope: 'customer',
        statement: 'По состоянию на 2026-09-01: Магазин использует двухстадийную оплату.',
        source: { thread: 'ticket-alpha', via: 'consolidate' },
        createdAt: NOW,
      }),
      expect.objectContaining({
        id: 'notes-2',
        kind: 'temporal',
        about: 'product',
        scope: 'shared',
        statement: 'По состоянию на 2026-09-02: Карты временно не проходят, QR работает.',
        validUntil: '2026-09-02T18:00:00Z',
      }),
      expect.objectContaining({
        id: 'notes-3',
        kind: 'undocumented',
        about: 'product',
        scope: 'customer',
        documentationCandidate: true,
        statement: 'По состоянию на 2026-09-02: BOM мешает распознать заголовок первой колонки.',
      }),
      expect.not.objectContaining({ validUntil: expect.anything() }),
    ]);
    expect(written[3]?.validUntil).toBeUndefined();
    expect(notes.usage()).toEqual({
      usage: {
        inputTokens: 1_000,
        uncachedInputTokens: 800,
        cacheReadTokens: 200,
        cacheWriteTokens: 0,
        outputTokens: 100,
      },
      // 800 @ $0.15/M + 200 @ $0.075/M + 100 @ $0.60/M
      costUsd: 0.000195,
    });

    const prompt = JSON.stringify(mock.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('customer claim (evidence about this customer)');
    expect(prompt).toContain('human support reply by support.anna (trusted)');
    expect(prompt).toContain('coach note scope=product by eng.ivan (trusted)');
    expect(prompt).toContain('One note per fact');
    expect(prompt).toContain('Dates mentioned near a fact do not make it temporal');
    expect(prompt).toContain('later confirmation that it happened are two facts');
    expect(prompt).toContain('keeps all of its parameters together');
    expect(prompt).toContain('extract the missing details as a new note');
    expect(prompt).toContain('hedge only what the source itself hedged');
    expect(prompt).toContain('not for behaviour that a later change replaces');
    // Tripwire: the instructions must stay free of any scenario's objects, so scenarios the
    // engine never saw remain a valid check (the events below legitimately mention BOM).
    const instructions = JSON.stringify(
      (mock.doGenerateCalls[0]?.prompt ?? []).filter((message) => message.role === 'system'),
    );
    expect(instructions).not.toMatch(/BOM|sku|СкладУчёт|release|error count|10 сентября/i);
  });

  it('accepts what the model boundary lets through and checks it note by note', async () => {
    const mock = model(extraction([
      // Out-of-range citations are dropped; a note left with none is a guess and is skipped.
      { kind: 'personal', about: 'alpha', statement: 'Без источника.', source_events: [0, 9] },
      // An unparsable date on a temporal note: the fact stays, the lifecycle claim goes.
      { kind: 'temporal', about: 'product', statement: 'Сбой до вечера.', valid_until: 'до 18:00', source_events: [3] },
      // A temporal note with no date at all is downgraded the same way.
      { kind: 'temporal', about: 'alpha', statement: 'Пока не подтверждать списание.', source_events: [1] },
      // A bare local timestamp is read as UTC instead of losing the expiry.
      { kind: 'temporal', about: 'product', statement: 'Карты не проходят до вечера.', valid_until: '2026-09-02 18:00', source_events: [3] },
      // A date on a non-temporal note is ignored, in-range citations are kept.
      { kind: 'personal', about: 'alpha', statement: 'Двухстадийная оплата.', valid_until: '2026-09-10', source_events: [1, 42] },
      { kind: 'personal', about: 'alpha', statement: '   ', source_events: [1] },
    ]));
    const notes = engine(mock);

    const written = await notes.consolidate(thread(), NOW);

    expect(written.map(({ kind, statement, validUntil, scope }) => ({ kind, statement, validUntil, scope }))).toEqual([
      { kind: 'other', statement: 'По состоянию на 2026-09-02: Сбой до вечера.', validUntil: undefined, scope: 'shared' },
      { kind: 'other', statement: 'По состоянию на 2026-09-01: Пока не подтверждать списание.', validUntil: undefined, scope: 'customer' },
      { kind: 'temporal', statement: 'По состоянию на 2026-09-02: Карты не проходят до вечера.', validUntil: '2026-09-02T18:00:00Z', scope: 'shared' },
      { kind: 'personal', statement: 'По состоянию на 2026-09-01: Двухстадийная оплата.', validUntil: undefined, scope: 'customer' },
    ]);
  });

  it('retries once when the object does not parse, then lets the error through', async () => {
    const malformed: MockGenerateResult = {
      content: [{ type: 'text', text: '{"notes": [oops' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: USAGE,
      warnings: [],
    };
    const recovered = model([malformed, extraction([{
      kind: 'personal',
      about: 'alpha',
      statement: 'Магазин использует двухстадийную оплату.',
      source_events: [1],
    }])]);
    expect(await engine(recovered).consolidate(thread(), NOW)).toHaveLength(1);
    expect(recovered.doGenerateCalls).toHaveLength(2);

    const broken = model([malformed, malformed]);
    await expect(engine(broken).consolidate(thread(), NOW)).rejects.toThrow(/No object generated/);
    expect(broken.doGenerateCalls).toHaveLength(2);
  });

  it('does not call the model for an empty transcript', async () => {
    const mock = model();
    const notes = engine(mock);
    expect(await notes.consolidate(thread([]), NOW)).toEqual([]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(notes.usage().costUsd).toBe(0);
  });

  it('shows known notes in the next prompt and deduplicates a re-extraction', async () => {
    const answer = extraction([{
      kind: 'undocumented',
      about: 'product',
      statement: 'BOM мешает распознать заголовок первой колонки, строки пропускаются.',
      source_events: [4],
    }]);
    const mock = model([answer, extraction([{
      kind: 'undocumented',
      about: 'product',
      statement: 'Из-за BOM заголовок первой колонки не распознаётся, строки пропускаются.',
      source_events: [4],
    }])]);
    const notes = engine(mock);

    expect(await notes.consolidate(thread(), NOW)).toHaveLength(1);
    expect(await notes.consolidate(thread(), '2026-09-04T12:00:00Z')).toEqual([]);
    expect(JSON.stringify(mock.doGenerateCalls[1]?.prompt)).toContain(
      'BOM мешает распознать заголовок первой колонки',
    );
    expect(await notes.proposals()).toHaveLength(1);
  });
});

describe('NotesMemoryEngine store and recall', () => {
  it('deduplicates writes only inside the same scope domain', async () => {
    const notes = engine();
    await notes.write([
      item('alpha-1', { statement: 'BOM мешает распознать заголовок первой колонки.' }),
      item('alpha-duplicate', { statement: 'BOM не даёт распознать заголовок первой колонки.' }),
      item('beta-copy', {
        learnedFrom: 'beta',
        about: 'beta',
        statement: 'BOM мешает распознать заголовок первой колонки.',
      }),
    ], NOW);

    expect((await notes.recall('alpha', 'BOM', NOW)).map(({ id }) => id)).toEqual(['alpha-1']);
    expect((await notes.recall('beta', 'BOM', NOW)).map(({ id }) => id)).toEqual(['beta-copy']);
  });

  it('keeps the scheduled workaround and the later shipped release as separate facts', async () => {
    const notes = engine();
    await notes.write([
      item('k3', {
        kind: 'temporal',
        statement:
          'До релиза импортёра 10 сентября нужно сохранять экспорт как UTF-8 без BOM, иначе импорт снова пропустит новые строки.',
        validUntil: '2026-09-10',
      }),
      item('k5', {
        kind: 'undocumented',
        about: 'product',
        statement:
          'Релиз импортёра от 10 сентября вышел: импортёр удаляет BOM и показывает пропущенные строки в отчёте.',
      }),
    ], NOW);

    expect((await notes.recall('alpha', 'релиз импортёра BOM', NOW)).map(({ id }) => id)).toEqual([
      'k5',
      'k3',
    ]);
  });

  it('does not deduplicate the same wording across different knowledge kinds', async () => {
    const notes = engine();
    await notes.write([
      item('planned', {
        kind: 'temporal',
        about: 'product',
        statement: 'Релиз импортёра удаляет BOM и показывает пропущенные строки.',
        validUntil: '2026-09-10',
      }),
      item('shipped', {
        kind: 'undocumented',
        about: 'product',
        statement: 'Релиз импортёра удаляет BOM и показывает пропущенные строки.',
      }),
    ], NOW);

    expect((await notes.recall('alpha', 'релиз BOM', NOW)).map(({ id }) => id)).toEqual([
      'shipped',
      'planned',
    ]);
  });

  it('keeps isolation, ranks by overlap, keeps zero-overlap and returns expired temporal rows', async () => {
    const notes = engine();
    await notes.write([
      item('alpha-old', {
        statement: 'Доставка разрешена только по Томской области.',
        createdAt: '2026-09-01T09:00:00Z',
      }),
      item('alpha-expired', {
        kind: 'temporal',
        about: 'product',
        statement: 'Карты Оплатим временно не проходят, QR работает.',
        validUntil: '2026-09-02T18:00:00Z',
        createdAt: '2026-09-02T12:00:00Z',
      }),
      item('shared', {
        about: 'product',
        scope: 'shared',
        statement: 'Выплаты задерживаются до пятницы.',
        createdAt: '2026-09-03T10:00:00Z',
      }),
      item('beta-private', {
        about: 'beta',
        learnedFrom: 'beta',
        statement: 'Секретная настройка beta.',
        createdAt: '2026-09-03T11:00:00Z',
      }),
    ], NOW);

    const recalled = await notes.recall('alpha', 'Почему карты Оплатим не проходят?', NOW);
    expect(recalled.map(({ id }) => id)).toEqual(['alpha-expired', 'shared', 'alpha-old']);
    expect(recalled[0]).toMatchObject({ validUntil: '2026-09-02T18:00:00Z' });
    expect(recalled.map(({ id }) => id)).not.toContain('beta-private');
  });

  it('applies a hard token cap to the ranked prefix', async () => {
    const notes = engine(model(), { maxRecallTokens: 2, countTokens: () => 1 });
    await notes.write([
      item('one', { statement: 'Первый нерелевантный факт.', createdAt: '2026-09-01T09:00:00Z' }),
      item('two', { statement: 'Второй факт про оплату.', createdAt: '2026-09-02T09:00:00Z' }),
      item('three', { statement: 'Третий факт про оплату картой.', createdAt: '2026-09-03T09:00:00Z' }),
    ], NOW);
    expect((await notes.recall('alpha', 'оплата картой', NOW)).map(({ id }) => id)).toEqual([
      'three',
      'two',
    ]);
  });

  it('serves only flagged product documentation candidates and resets all state', async () => {
    const notes = engine();
    await notes.write([
      item('candidate', {
        kind: 'undocumented',
        about: 'product',
        documentationCandidate: true,
        statement: 'Импортёр пропускает строки с пустым артикулом.',
      }),
      item('not-flagged', { kind: 'undocumented', about: 'product' }),
      item('customer-flagged', { documentationCandidate: true }),
    ], NOW);
    expect((await notes.proposals()).map(({ id }) => id)).toEqual(['candidate']);

    await notes.reset();
    expect(await notes.recall('alpha', '', NOW)).toEqual([]);
    expect(await notes.proposals()).toEqual([]);
    expect(notes.usage().costUsd).toBe(0);
  });

  it('reopens a file-backed store without reusing generated ids', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'prilavok-notes-'));
    tempDirs.push(directory);
    const path = join(directory, 'notes.sqlite');
    const first = engine(model(), { path });
    await first.write([item('notes-7', { statement: 'Сохранённый личный факт.' })], NOW);
    first.close();
    openEngines.splice(openEngines.indexOf(first), 1);

    const second = engine(model(extraction([{
      kind: 'personal',
      about: 'alpha',
      statement: 'Другой новый личный факт.',
      source_events: [1],
    }])), { path });

    expect((await second.recall('alpha', 'сохранённый', NOW)).map(({ id }) => id)).toEqual(['notes-7']);
    expect((await second.consolidate(thread(), NOW))[0]?.id).toBe('notes-8');
  });
});

describe('notes runner wiring', () => {
  it('creates notes from the config and records extraction cost on the boundary and run', async () => {
    const mock = model(extraction([{
      kind: 'personal',
      about: 'alpha',
      statement: 'Магазин использует двухстадийную оплату.',
      source_events: [1],
    }]));
    const config: Config = {
      id: 'notes-test',
      agent: SPEC,
      memory: { engine: 'notes', read: 'hydrate', write: 'consolidate' },
      judge: { provider: 'anthropic', model: 'claude-sonnet-5' },
    };
    const scenario: Scenario = {
      id: 'notes-story',
      title: 'Notes story',
      world: {
        knowledge_base: 'none',
        clock: '2026-09-01T09:00:00Z',
        customers: { alpha: { name: 'Альфа' } },
      },
      knowledge: {},
      steps: [
        {
          id: 'message',
          type: 'customer_message',
          thread: 'ticket-alpha',
          customer: 'alpha',
          at: '2026-09-01T09:00:00Z',
          content: 'Мы используем двухстадийную оплату.',
        },
        { id: 'consolidate', type: 'consolidate', at: NOW },
      ],
    };
    const notes = createMemoryEngine(config, { model: mock }) as NotesMemoryEngine;
    openEngines.push(notes);

    const result = await runScenario(scenario, config, { engine: notes });

    expect(result.error).toBeUndefined();
    expect(result.consolidations[0]).toMatchObject({
      id: 'consolidate',
      wrote: [expect.objectContaining({ kind: 'personal', about: 'alpha' })],
      costUsd: 0.000195,
    });
    expect(result.costUsd).toBeCloseTo(0.000195, 10);
  });
});
