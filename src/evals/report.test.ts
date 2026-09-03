import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ZERO_USAGE } from '../llm/index.ts';
import { scoreOf } from './checks.ts';
import {
  buildReport,
  carriesFact,
  cellGlyph,
  emptyCell,
  factTokens,
  latestRunId,
  listRunIds,
  loadRunResults,
  median,
  renderReport,
} from './report.ts';
import type {
  CheckResult,
  Config,
  MemoryItem,
  ProbeResult,
  RunResult,
  Scenario,
  StepResult,
} from './schema.ts';

const START = '2026-09-01T09:00:00Z';

const K1 =
  'Магазин «Альфа» выгружает каталог из «СкладУчёт»: файл в UTF-8 с BOM, разделитель «;», ' +
  'артикулы с ведущими нулями.';
const K2 =
  'Если CSV-файл начинается с BOM, импортёр не распознаёт заголовок первой колонки, и новые ' +
  'строки пропускаются молча.';

function scenario(): Scenario {
  return {
    id: 'demo',
    title: 'Demo story',
    world: {
      knowledge_base: 'wiki',
      clock: START,
      customers: { alpha: { name: 'Альфа' } },
    },
    knowledge: {
      K1: { kind: 'personal', about: 'alpha', scope: 'customer', statement: K1, source: ['t1-open'] },
      K2: {
        kind: 'undocumented',
        about: 'product',
        scope: 'customer',
        documentation_candidate: true,
        statement: K2,
        source: ['t1-note'],
      },
    },
    steps: [
      {
        id: 't1-open',
        type: 'customer_message',
        thread: 'tkt',
        customer: 'alpha',
        at: START,
        content: 'Пропали товары после импорта.',
      },
      { id: 't1-agent', type: 'agent_turn', thread: 'tkt', expect: { outcome: 'escalate', uses: ['K1'] } },
      { id: 't2-agent', type: 'agent_turn', thread: 'tkt', expect: { uses: ['K2'] } },
    ],
    probes: [
      {
        id: 'recall-alpha',
        type: 'memory_recall',
        customer: 'alpha',
        query: 'BOM',
        expect: { recalls: ['K2'] },
      },
    ],
  };
}

function config(id: string, over: Partial<Config> = {}): Config {
  return {
    id,
    agent: { provider: 'openai', model: 'gpt-4o-mini', temperature: 0 },
    memory: { engine: 'naive', read: 'hydrate', write: 'consolidate' },
    judge: { provider: 'anthropic', model: 'claude-sonnet-5' },
    ...over,
  };
}

function item(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'memory-1',
    kind: 'personal',
    about: 'alpha',
    learnedFrom: 'alpha',
    scope: 'customer',
    statement: `По состоянию на 2026-09-01: ${K1}`,
    source: { thread: 'tkt', via: 'consolidate' },
    createdAt: START,
    ...over,
  };
}

function step(id: string, checks: CheckResult[], latencyMs = 1000, writes: MemoryItem[] = []): StepResult {
  return {
    id,
    thread: 'tkt',
    at: START,
    outcome: 'escalate',
    reply: 'Передаю коллегам.',
    trace: [],
    memoryWrites: writes,
    checks,
    usage: ZERO_USAGE,
    costUsd: 0,
    latencyMs,
  };
}

interface RunOptions {
  readonly steps?: StepResult[];
  readonly probes?: ProbeResult[];
  readonly consolidated?: MemoryItem[];
  readonly costUsd?: number;
  readonly error?: string;
}

function run(configId: string, repeat: number, options: RunOptions = {}): RunResult {
  const steps = options.steps ?? [];
  const probes = options.probes ?? [];
  return {
    scenario: 'demo',
    config: configId,
    repeat,
    startedAt: START,
    judge: { provider: 'anthropic', model: 'claude-sonnet-5' },
    steps,
    consolidations:
      options.consolidated === undefined
        ? []
        : [{ id: 'consolidate-1', at: START, wrote: options.consolidated }],
    probes,
    score: scoreOf([...steps.flatMap((s) => s.checks), ...probes.flatMap((p) => p.checks)]),
    costUsd: options.costUsd ?? 0,
    ...(options.error === undefined ? {} : { error: options.error }),
  };
}

/** The shape T2.8 smoke-tests: `none` learns nothing, `naive` gets the same-customer fact. */
function smokeResults(): RunResult[] {
  return [
    run('naive', 1, {
      steps: [
        step('t1-agent', [
          { key: 'outcome', verdict: 'pass' },
          { key: 'uses:K1', verdict: 'pass' },
        ], 2400, [item({ id: 'agent-1', source: { thread: 'tkt', step: 't1-agent', via: 'agent' } })]),
        step('t2-agent', [{ key: 'uses:K2', verdict: 'fail', why: 'no BOM' }], 1800),
      ],
      probes: [{ id: 'recall-alpha', checks: [{ key: 'recalls:K2', verdict: 'partial' }] }],
      consolidated: [item({ id: 'consolidated-1', statement: `По состоянию на 2026-09-01: ${K2}` })],
      costUsd: 0.004,
    }),
    run('none', 1, {
      steps: [
        step('t1-agent', [
          { key: 'outcome', verdict: 'pass' },
          { key: 'uses:K1', verdict: 'fail' },
        ], 1200),
        step('t2-agent', [{ key: 'uses:K2', verdict: 'fail' }], 1000),
      ],
      probes: [{ id: 'recall-alpha', checks: [{ key: 'recalls:K2', verdict: 'skipped' }] }],
      costUsd: 0.002,
    }),
  ];
}

const NONE_CONFIG = config('none', { memory: { engine: 'none', read: 'hydrate', write: 'consolidate' } });

function report(results: RunResult[], configs: Config[] = [NONE_CONFIG, config('naive')]) {
  return buildReport({
    runId: 'run-1',
    results,
    scenarios: [scenario()],
    configs,
    generatedAt: '2026-09-03T22:00:00Z',
  });
}

function cell(model: ReturnType<typeof report>, owner: string, key: string, configId: string) {
  const row = model.scenarios[0]?.checks.find((r) => r.owner === owner && r.key === key);
  expect(row, `row ${owner} · ${key}`).toBeDefined();
  return row?.cells.get(configId) ?? emptyCell();
}

describe('factTokens', () => {
  it('drops the write date prefix, stopwords and short words', () => {
    const tokens = factTokens('По состоянию на 2026-09-01: если файл с BOM, товары пропадают');
    expect([...tokens]).not.toContain('2026');
    expect([...tokens]).not.toContain('если');
    expect(tokens.has('товар')).toBe(true);
  });

  it('stems to five characters so Russian endings agree', () => {
    expect(factTokens('товары').has('товар')).toBe(true);
    expect(factTokens('товаров').has('товар')).toBe(true);
  });

  it('keeps numbers whole', () => {
    expect(factTokens('заказ 1153 и артикул 000123')).toEqual(new Set(['заказ', '1153', 'артик', '000123']));
  });
});

describe('carriesFact', () => {
  it('credits a paraphrase that repeats the fact content words', () => {
    expect(
      carriesFact(
        'По состоянию на 2026-09-01: импортёр не распознаёт заголовок первой колонки, если CSV-файл ' +
          'начинается с BOM; новые строки пропускаются.',
        K2,
      ),
    ).toBe(true);
  });

  it('rejects an unrelated statement', () => {
    expect(carriesFact('По состоянию на 2026-09-01: доставка только по Томской области.', K2)).toBe(false);
  });

  it('rejects a statement about the other fact of the same scenario', () => {
    expect(carriesFact(`По состоянию на 2026-09-01: ${K1}`, K2)).toBe(false);
  });
});

describe('cellGlyph', () => {
  it('reads a cell nothing decided as a dash', () => {
    expect(cellGlyph({ ...emptyCell(), skipped: 2, missing: 1 })).toBe('–');
  });

  it('separates all-pass, all-fail and mixed', () => {
    expect(cellGlyph({ ...emptyCell(), pass: 3 })).toBe('✓');
    expect(cellGlyph({ ...emptyCell(), fail: 3 })).toBe('✗');
    expect(cellGlyph({ ...emptyCell(), pass: 2, fail: 1 })).toBe('◐');
    expect(cellGlyph({ ...emptyCell(), partial: 2 })).toBe('◐');
    expect(cellGlyph({ ...emptyCell(), pass: 2, skipped: 1 })).toBe('✓');
  });
});

describe('median', () => {
  it('averages the middle pair of an even sample', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBe(0);
  });
});

describe('buildReport', () => {
  it('orders configs by the config list and rows by the scenario, not by arrival', () => {
    const model = report(smokeResults());
    expect(model.configs.map((c) => c.id)).toEqual(['none', 'naive']);
    expect(model.scenarios[0]?.checks.map((row) => `${row.owner}/${row.key}`)).toEqual([
      't1-agent/outcome',
      't1-agent/uses:K1',
      't2-agent/uses:K2',
      'recall-alpha/recalls:K2',
    ]);
    expect(model.scenarios[0]?.title).toBe('Demo story');
    expect(model.repeats).toBe(1);
  });

  it('scores every verdict into its config column', () => {
    const model = report(smokeResults());
    expect(cellGlyph(cell(model, 't1-agent', 'uses:K1', 'naive'))).toBe('✓');
    expect(cellGlyph(cell(model, 't1-agent', 'uses:K1', 'none'))).toBe('✗');
    expect(cellGlyph(cell(model, 'recall-alpha', 'recalls:K2', 'naive'))).toBe('◐');
    // The engine cannot serve the probe: skipped, never a fail (evals/README §4).
    expect(cell(model, 'recall-alpha', 'recalls:K2', 'none')).toMatchObject({ skipped: 1, fail: 0 });
  });

  it('counts the verdicts an aborted run never produced as missing', () => {
    const [naive] = smokeResults();
    const model = report([
      naive as RunResult,
      run('none', 1, {
        steps: [step('t1-agent', [{ key: 'outcome', verdict: 'pass' }])],
        error: 'AI_APICallError: bad key',
      }),
    ]);
    expect(cell(model, 't2-agent', 'uses:K2', 'none')).toMatchObject({ missing: 1 });
    expect(cellGlyph(cell(model, 't2-agent', 'uses:K2', 'none'))).toBe('–');
    expect(model.errors).toEqual([
      { scenario: 'demo', config: 'none', repeat: 1, error: 'AI_APICallError: bad key' },
    ]);
  });

  it('attributes each K item to the write path that wrote it', () => {
    const model = report(smokeResults());
    const knowledge = model.scenarios[0]?.knowledge ?? [];
    expect(knowledge.map((row) => row.id)).toEqual(['K1', 'K2']);
    expect(knowledge[0]?.learnedVia).toEqual(['agent']);
    expect(knowledge[1]?.learnedVia).toEqual(['consolidate']);
    expect(knowledge[1]?.item.kind).toBe('undocumented');
  });

  it('leaves `learned via` empty when no engine wrote the fact', () => {
    const model = report(smokeResults().filter((result) => result.config === 'none'), [NONE_CONFIG]);
    expect(model.scenarios[0]?.knowledge.map((row) => row.learnedVia)).toEqual([[], []]);
  });

  it('aggregates every positive knowledge check into the K column', () => {
    const model = report(smokeResults());
    // `uses:K2` failed and `recalls:K2` was partial for naive: mixed, not a pass.
    expect(model.scenarios[0]?.knowledge[1]?.cells.get('naive')).toMatchObject({ fail: 1, partial: 1 });
    expect(model.scenarios[0]?.knowledge[0]?.cells.get('naive')).toMatchObject({ pass: 1 });
  });

  it('totals cost, turns and median latency per config', () => {
    const model = report(smokeResults());
    const naive = model.configs.find((c) => c.id === 'naive');
    expect(naive).toMatchObject({
      runs: 1,
      errors: 0,
      costUsd: 0.004,
      turns: 2,
      medianLatencyMs: 2100,
      agent: 'openai:gpt-4o-mini',
      judges: ['anthropic:claude-sonnet-5'],
      configuredJudge: 'anthropic:claude-sonnet-5',
    });
    expect(naive?.score).toEqual({ pass: 2, partial: 1, fail: 1, skipped: 0 });
  });

  it('reports only the checks the configs disagree on', () => {
    const model = report(smokeResults());
    expect(model.findings.map((finding) => `${finding.owner}/${finding.key}`)).toEqual([
      't1-agent/uses:K1',
    ]);
    expect(model.findings[0]?.groups).toEqual([
      { glyph: '✓', configs: ['naive'] },
      { glyph: '✗', configs: ['none'] },
    ]);
  });

  it('counts repeats and keeps a per-repeat tally', () => {
    const passing = (repeat: number): RunResult =>
      run('naive', repeat, { steps: [step('t1-agent', [{ key: 'outcome', verdict: 'pass' }])] });
    const model = report([
      passing(1),
      { ...passing(2), steps: [step('t1-agent', [{ key: 'outcome', verdict: 'fail' }])] },
    ], [config('naive')]);
    expect(model.repeats).toBe(2);
    expect(cell(model, 't1-agent', 'outcome', 'naive')).toMatchObject({ pass: 1, fail: 1 });
    expect(renderReport(model)).toContain('◐ 1/2');
  });

  it('counts repeats per scenario, not runs per config', () => {
    const one = run('naive', 1, { steps: [step('t1-agent', [{ key: 'outcome', verdict: 'pass' }])] });
    const model = report([one, { ...one, scenario: 'other' }], [config('naive')]);
    expect(model.resultCount).toBe(2);
    expect(model.repeats).toBe(1);
  });

  it('shows a bare dash for a cell nothing decided, even across repeats', () => {
    const skipped = (repeat: number): RunResult =>
      run('naive', repeat, {
        probes: [{ id: 'recall-alpha', checks: [{ key: 'recalls:K2', verdict: 'skipped' }] }],
      });
    const markdown = renderReport(report([skipped(1), skipped(2)], [config('naive')]));
    expect(markdown).toMatch(/\| `recall-alpha` +\| `recalls:K2` +\| – +\|/);
    expect(markdown).not.toContain('– 0/2');
    expect(markdown).toContain('A single config: nothing to compare.');
  });

  it('reports a scenario whose file is gone, without a knowledge table', () => {
    const model = buildReport({ runId: 'run-1', results: smokeResults(), configs: [config('naive')] });
    expect(model.scenarios[0]?.title).toBe('demo');
    expect(model.scenarios[0]?.knowledge).toEqual([]);
    expect(model.scenarios[0]?.checks.length).toBe(4);
    // A config with no file still gets a column, after the known ones.
    expect(model.configs.map((c) => c.id)).toEqual(['naive', 'none']);
    expect(model.configs[1]?.memory).toBeUndefined();
  });
});

describe('renderReport', () => {
  it('renders the configs, the two per-scenario tables and the findings', () => {
    const markdown = renderReport(report(smokeResults()));
    expect(markdown).toContain('# Eval report — `run-1`');
    expect(markdown).toContain('2 result files: 1 scenario × 2 configs × 1 repeat.');
    expect(markdown).toMatch(/\| `none` +\| none +\| hydrate \| consolidate \| openai:gpt-4o-mini \|/);
    expect(markdown).toContain('## `demo` — Demo story');
    expect(markdown).toContain('| step');
    expect(markdown).toContain('| K   | kind');
    expect(markdown).toContain('| K1  | personal');
    expect(markdown).toMatch(/\| `t1-agent` +\| `uses:K1` +\| ✗ +\| ✓ +\|/);
    expect(markdown).toContain('- `demo` · `t1-agent` · `uses:K1` — ✓ `naive` · ✗ `none`');
    expect(markdown).not.toContain('## Runs that did not finish');
  });

  it('names the judge that actually ran when it is not the configured one', () => {
    const [naive] = smokeResults();
    const model = report(
      [{ ...(naive as RunResult), judge: { provider: 'openai', model: 'gpt-5.4' } }],
      [config('naive')],
    );
    expect(renderReport(model)).toContain('openai:gpt-5.4 (configured: anthropic:claude-sonnet-5)');
  });

  it('lists runs that stopped early and files it could not read', () => {
    const model = buildReport({
      runId: 'run-1',
      results: [run('none', 1, { error: 'AI_APICallError: bad key' })],
      scenarios: [scenario()],
      configs: [NONE_CONFIG],
      unreadable: [{ path: 'evals/results/run-1/notes.json', problem: 'Unexpected end of JSON input' }],
      generatedAt: START,
    });
    const markdown = renderReport(model);
    expect(markdown).toContain('- `demo.none.1` — AI_APICallError: bad key');
    expect(markdown).toContain('- `evals/results/run-1/notes.json` — Unexpected end of JSON input');
    expect(markdown).toContain('No checks were recorded: nothing to compare.');
    expect(markdown).toContain('No checks were recorded for this scenario.');
  });
});

describe('loadRunResults', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'report-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses result files and reports the ones that are not results', async () => {
    const runDir = join(dir, 'run-1');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'demo.none.1.json'), JSON.stringify(run('none', 1)));
    await writeFile(join(runDir, 'broken.json'), '{ nope');
    await writeFile(join(runDir, 'other.json'), JSON.stringify({ scenario: 'demo' }));
    await writeFile(join(runDir, 'README.md'), 'not json');

    const loaded = await loadRunResults(runDir);
    expect(loaded.results.map((result) => result.config)).toEqual(['none']);
    expect(loaded.unreadable.map((file) => file.path.endsWith('broken.json'))).toContain(true);
    expect(loaded.unreadable).toHaveLength(2);
    expect(loaded.unreadable[1]?.problem).toContain('not a run result');
  });

  it('lists run directories newest first and ignores loose files', async () => {
    await mkdir(join(dir, 'older'), { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await mkdir(join(dir, 'newer'), { recursive: true });
    await writeFile(join(dir, 'REPORT.md'), '# report');

    expect(await listRunIds(dir)).toEqual(['newer', 'older']);
    expect(await latestRunId(dir)).toBe('newer');
  });

  it('treats a missing results directory as no runs', async () => {
    expect(await listRunIds(join(dir, 'nothing-here'))).toEqual([]);
    expect(await latestRunId(join(dir, 'nothing-here'))).toBeUndefined();
  });
});
