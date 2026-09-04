/**
 * T2.7 — `pnpm eval report`: aggregate a run directory into `evals/results/REPORT.md`.
 *
 * The report answers three questions and nothing else:
 *
 *   1. what does each config get right — one table per scenario, rows = checks,
 *      columns = configs, cells = the pass rate over repeats;
 *   2. what did it cost — totals, USD and the median turn latency per config;
 *   3. which write path learned each K item, and where do the configs disagree.
 *
 * Aggregation is offline and free: it reads the result JSON, never a model. A run directory
 * therefore stays reportable long after the keys that produced it have rotated, and a report
 * can be regenerated without paying for the run again.
 *
 * Scores stay counts (evals/README §5): a scenario is a story, and which step failed is the
 * finding. Nothing here collapses a config into a single number.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { modelKey } from '../llm/index.ts';
import { factTokens } from '../memory/text.ts';
import {
  type Config,
  type KnowledgeItem,
  type MemoryItem,
  type ModelSpec,
  type RunResult,
  RunResultSchema,
  type Scenario,
  type Score,
  type Verdict,
} from './schema.ts';
import { formatPath } from './validate.ts';

export const RESULTS_DIR = 'evals/results';
export const REPORT_FILE = join(RESULTS_DIR, 'REPORT.md');

/** `uses`, `recalls` and `proposes` ask whether a fact reached the agent; the K table grades those. */
const POSITIVE_KNOWLEDGE_CHECK = /^(?:uses|recalls|proposes):(K[1-9]\d*)$/;

// ---- Loading a run directory --------------------------------------------------------------

export interface UnreadableResult {
  readonly path: string;
  readonly problem: string;
}

export interface LoadedRun {
  readonly results: RunResult[];
  /** Files that are not result JSON. Reported rather than thrown: one bad file is not a run. */
  readonly unreadable: UnreadableResult[];
}

export async function loadRunResults(dir: string): Promise<LoadedRun> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  const results: RunResult[] = [];
  const unreadable: UnreadableResult[] = [];

  for (const name of names) {
    const path = join(dir, name);
    try {
      const parsed = RunResultSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (parsed.success) {
        results.push(parsed.data);
      } else {
        const issues = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
          .join('; ');
        unreadable.push({ path, problem: `not a run result (${issues})` });
      }
    } catch (error) {
      unreadable.push({ path, problem: (error as Error).message });
    }
  }
  return { results, unreadable };
}

/** Run directories under `evals/results`, newest first by mtime. Missing directory: none. */
export async function listRunIds(dir: string = RESULTS_DIR): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const dated = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        name: entry.name,
        at: (await stat(join(dir, entry.name))).mtimeMs,
      })),
  );
  // mtime rather than the name: `--run-id` allows names that do not sort chronologically.
  return dated.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1)).map((entry) => entry.name);
}

export async function latestRunId(dir: string = RESULTS_DIR): Promise<string | undefined> {
  return (await listRunIds(dir))[0];
}

// ---- Cells ---------------------------------------------------------------------------------

/** Every repeat passed, mixed, every repeat failed, nothing decided it. */
export type Glyph = '✓' | '◐' | '✗' | '–';

/**
 * One column of one row, over every repeat that contributed a verdict. `missing` is a run
 * that should have produced this verdict and did not, which is what an aborted run leaves
 * behind; it reads as a dash, never as a pass.
 */
export interface Cell extends Score {
  missing: number;
}

export function emptyCell(): Cell {
  return { pass: 0, partial: 0, fail: 0, skipped: 0, missing: 0 };
}

export function addVerdict(cell: Cell, verdict: Verdict): void {
  cell[verdict] += 1;
}

export function addCell(target: Cell, source: Cell): void {
  target.pass += source.pass;
  target.partial += source.partial;
  target.fail += source.fail;
  target.skipped += source.skipped;
  target.missing += source.missing;
}

export function cellTotal(cell: Cell): number {
  return cell.pass + cell.partial + cell.fail + cell.skipped + cell.missing;
}

/** Verdicts a regex or a judge actually decided; skipped and missing are not evidence. */
export function cellDecided(cell: Cell): number {
  return cell.pass + cell.partial + cell.fail;
}

export function cellGlyph(cell: Cell): Glyph {
  const decided = cellDecided(cell);
  if (decided === 0) return '–';
  if (cell.pass === decided) return '✓';
  if (cell.fail === decided) return '✗';
  return '◐';
}

// ---- Attribution: which write path learned a fact -------------------------------------------

/** Kept as a report export for existing callers; implementation is shared with memory engines. */
export { factTokens } from '../memory/text.ts';

/** A write must repeat this share of the fact's content words to be credited with it. */
export const CARRIES_FACT_THRESHOLD = 0.3;
const CARRIES_FACT_MIN_TOKENS = 3;

/**
 * Does a memory write look like it carries this knowledge item?
 *
 * Lexical on purpose: the report must be reproducible from JSON without paying a judge, and
 * an approximate attribution of the *write* is enough — whether the fact actually reached the
 * merchant is graded by the judged `uses:`/`recalls:` checks in the same table.
 */
export function carriesFact(statement: string, fact: string): boolean {
  const wanted = factTokens(fact);
  if (wanted.size === 0) return false;
  const have = factTokens(statement);
  let hits = 0;
  for (const token of wanted) if (have.has(token)) hits += 1;
  return (
    hits >= Math.min(CARRIES_FACT_MIN_TOKENS, wanted.size) &&
    hits / wanted.size >= CARRIES_FACT_THRESHOLD
  );
}

export type WritePath = MemoryItem['source']['via'];
const WRITE_PATHS: readonly WritePath[] = ['agent', 'consolidate'];

/** Every memory item a run recorded, from both write paths. */
export function runWrites(result: RunResult): MemoryItem[] {
  return [
    ...result.steps.flatMap((step) => step.memoryWrites),
    ...result.consolidations.flatMap((consolidation) => consolidation.wrote),
  ];
}

// ---- Model -----------------------------------------------------------------------------------

export interface CheckRow {
  /** The `agent_turn` step or probe the check belongs to. */
  readonly owner: string;
  /** `outcome`, `reply.must[0]`, `uses:K3`, … — stable across runs (checks.ts). */
  readonly key: string;
  readonly cells: ReadonlyMap<string, Cell>;
}

export interface KnowledgeRow {
  readonly id: string;
  readonly item: KnowledgeItem;
  /** Write paths whose output lexically carries the fact; empty when nothing did. */
  readonly learnedVia: readonly WritePath[];
  /** The `uses`/`recalls`/`proposes` checks for this item, per config. */
  readonly cells: ReadonlyMap<string, Cell>;
}

export interface ScenarioReport {
  readonly id: string;
  readonly title: string;
  readonly checks: readonly CheckRow[];
  readonly knowledge: readonly KnowledgeRow[];
}

export interface ConfigSummary {
  readonly id: string;
  readonly memory?: Config['memory'];
  readonly agent?: string;
  /** The models that actually judged; D9's fallback can make this differ from `configuredJudge`. */
  readonly judges: readonly string[];
  readonly configuredJudge?: string;
  readonly runs: number;
  readonly errors: number;
  readonly score: Score;
  readonly costUsd: number;
  readonly turns: number;
  readonly medianLatencyMs?: number;
}

export interface FindingGroup {
  readonly glyph: Glyph;
  readonly configs: readonly string[];
}

export interface Finding {
  readonly scenario: string;
  readonly owner: string;
  readonly key: string;
  readonly groups: readonly FindingGroup[];
}

export interface RunError {
  readonly scenario: string;
  readonly config: string;
  readonly repeat: number;
  readonly error: string;
}

/** One thread an engine failed to consolidate; the run went on without that memory. */
export interface ConsolidationFailure {
  readonly scenario: string;
  readonly config: string;
  readonly repeat: number;
  readonly step: string;
  readonly thread: string;
  readonly error: string;
}

export interface ReportModel {
  readonly runId: string;
  readonly generatedAt: string;
  readonly resultCount: number;
  /** The largest number of repeats any scenario × config pair has; 1 hides the fractions. */
  readonly repeats: number;
  /** Result files produced with the LLM disk cache on; their repeats are replays, not samples. */
  readonly cachedResults: number;
  readonly configs: readonly ConfigSummary[];
  readonly scenarios: readonly ScenarioReport[];
  readonly findings: readonly Finding[];
  readonly errors: readonly RunError[];
  readonly consolidationFailures: readonly ConsolidationFailure[];
  readonly unreadable: readonly UnreadableResult[];
}

export interface ReportInputs {
  readonly runId: string;
  readonly results: readonly RunResult[];
  /** Titles, K items and step order. A scenario whose file is gone still reports its checks. */
  readonly scenarios?: readonly Scenario[];
  /** Engine, read/write axes and models. Column order follows this list. */
  readonly configs?: readonly Config[];
  readonly generatedAt?: string;
  readonly unreadable?: readonly UnreadableResult[];
}

// ---- Aggregation ------------------------------------------------------------------------------

export function buildReport(inputs: ReportInputs): ReportModel {
  const scenarioById = new Map((inputs.scenarios ?? []).map((scenario) => [scenario.id, scenario]));
  const configById = new Map((inputs.configs ?? []).map((config) => [config.id, config]));
  const configIds = orderIds(inputs.results.map((result) => result.config), [...configById.keys()]);
  const scenarioIds = orderIds(inputs.results.map((result) => result.scenario), [...scenarioById.keys()]);
  const rank = indexOf(configIds);

  // Config order first, then repeat: the rows of an unknown scenario keep a stable order too.
  const results = [...inputs.results].sort(
    (a, b) =>
      (rank.get(a.config) ?? 0) - (rank.get(b.config) ?? 0) ||
      a.scenario.localeCompare(b.scenario) ||
      a.repeat - b.repeat,
  );

  const scenarios = scenarioIds.map((id) =>
    buildScenario(
      id,
      scenarioById.get(id),
      results.filter((result) => result.scenario === id),
      configIds,
    ),
  );

  return {
    runId: inputs.runId,
    generatedAt: inputs.generatedAt ?? new Date().toISOString(),
    resultCount: results.length,
    repeats: Math.max(1, ...results.map((result) => result.repeat)),
    cachedResults: results.filter((result) => result.cached === true).length,
    configs: configIds.map((id) =>
      summarizeConfig(id, configById.get(id), results.filter((result) => result.config === id)),
    ),
    scenarios,
    findings: findings(scenarios, configIds),
    errors: results
      .filter((result) => result.error !== undefined)
      .map((result) => ({
        scenario: result.scenario,
        config: result.config,
        repeat: result.repeat,
        error: result.error ?? '',
      })),
    consolidationFailures: results.flatMap((result) =>
      result.consolidations.flatMap((consolidation) =>
        (consolidation.errors ?? []).map((failure) => ({
          scenario: result.scenario,
          config: result.config,
          repeat: result.repeat,
          step: consolidation.id,
          thread: failure.thread,
          error: failure.error,
        })),
      ),
    ),
    unreadable: inputs.unreadable ?? [],
  };
}

interface RowAccumulator {
  readonly owner: string;
  readonly key: string;
  readonly rank: number;
  readonly seq: number;
  readonly cells: Map<string, Cell>;
}

function buildScenario(
  id: string,
  scenario: Scenario | undefined,
  results: readonly RunResult[],
  configIds: readonly string[],
): ScenarioReport {
  const ranks = ownerRanks(scenario);
  const runsPerConfig = countRuns(results);
  const rows = new Map<string, RowAccumulator>();

  const cellOf = (owner: string, key: string, config: string): Cell => {
    const rowKey = `${owner} ${key}`;
    let row = rows.get(rowKey);
    if (row === undefined) {
      row = {
        owner,
        key,
        rank: ranks.get(owner) ?? Number.MAX_SAFE_INTEGER,
        seq: rows.size,
        cells: new Map(),
      };
      rows.set(rowKey, row);
    }
    let cell = row.cells.get(config);
    if (cell === undefined) {
      cell = emptyCell();
      row.cells.set(config, cell);
    }
    return cell;
  };

  for (const result of results) {
    for (const step of result.steps) {
      for (const check of step.checks) {
        addVerdict(cellOf(step.id, check.key, result.config), check.verdict);
      }
    }
    for (const probe of result.probes) {
      for (const check of probe.checks) {
        addVerdict(cellOf(probe.id, check.key, result.config), check.verdict);
      }
    }
  }

  const checks = [...rows.values()]
    .sort((a, b) => a.rank - b.rank || a.seq - b.seq)
    .map((row) => {
      // A run that stopped before this step still owes a verdict: count the gap so it reads
      // as undecided rather than silently shrinking the denominator.
      const cells = new Map<string, Cell>();
      for (const config of configIds) {
        const cell = row.cells.get(config) ?? emptyCell();
        cell.missing += Math.max(0, (runsPerConfig.get(config) ?? 0) - cellTotal(cell));
        cells.set(config, cell);
      }
      return { owner: row.owner, key: row.key, cells };
    });

  return {
    id,
    title: scenario?.title ?? id,
    checks,
    knowledge: knowledgeRows(scenario, results, configIds, checks),
  };
}

function knowledgeRows(
  scenario: Scenario | undefined,
  results: readonly RunResult[],
  configIds: readonly string[],
  checks: readonly CheckRow[],
): KnowledgeRow[] {
  if (scenario === undefined) return [];
  const writes = results.flatMap(runWrites);

  return Object.entries(scenario.knowledge).map(([id, item]) => {
    const cells = new Map(configIds.map((config) => [config, emptyCell()]));
    for (const row of checks) {
      if (POSITIVE_KNOWLEDGE_CHECK.exec(row.key)?.[1] !== id) continue;
      for (const config of configIds) {
        const source = row.cells.get(config);
        const target = cells.get(config);
        if (source !== undefined && target !== undefined) addCell(target, source);
      }
    }
    const carriers = writes.filter((write) => carriesFact(write.statement, item.statement));
    return {
      id,
      item,
      learnedVia: WRITE_PATHS.filter((via) => carriers.some((write) => write.source.via === via)),
      cells,
    };
  });
}

function summarizeConfig(
  id: string,
  config: Config | undefined,
  results: readonly RunResult[],
): ConfigSummary {
  const score: Score = { pass: 0, partial: 0, fail: 0, skipped: 0 };
  const latencies: number[] = [];
  const judges = new Set<string>();
  let costUsd = 0;

  for (const result of results) {
    score.pass += result.score.pass;
    score.partial += result.score.partial;
    score.fail += result.score.fail;
    score.skipped += result.score.skipped;
    costUsd += result.costUsd;
    if (result.judge !== undefined) judges.add(modelKey(result.judge));
    for (const step of result.steps) latencies.push(step.latencyMs);
  }

  return {
    id,
    ...(config === undefined
      ? {}
      : { memory: config.memory, agent: modelKey(config.agent), configuredJudge: modelKey(config.judge) }),
    judges: [...judges].sort(),
    runs: results.length,
    errors: results.filter((result) => result.error !== undefined).length,
    score,
    costUsd,
    turns: latencies.length,
    ...(latencies.length === 0 ? {} : { medianLatencyMs: median(latencies) }),
  };
}

/** Checks the configs do not agree on. A column nothing decided never makes a finding alone. */
function findings(scenarios: readonly ScenarioReport[], configIds: readonly string[]): Finding[] {
  const found: Finding[] = [];
  for (const scenario of scenarios) {
    for (const row of scenario.checks) {
      const byGlyph = new Map<Glyph, string[]>();
      for (const config of configIds) {
        const cell = row.cells.get(config);
        if (cell === undefined) continue;
        const glyph = cellGlyph(cell);
        byGlyph.set(glyph, [...(byGlyph.get(glyph) ?? []), config]);
      }
      if ([...byGlyph.keys()].filter((glyph) => glyph !== '–').length < 2) continue;
      found.push({
        scenario: scenario.id,
        owner: row.owner,
        key: row.key,
        groups: (['✓', '◐', '✗', '–'] as const)
          .filter((glyph) => byGlyph.has(glyph))
          .map((glyph) => ({ glyph, configs: byGlyph.get(glyph) ?? [] })),
      });
    }
  }
  return found;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const high = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? high : (high + (sorted[middle - 1] ?? 0)) / 2;
}

function ownerRanks(scenario: Scenario | undefined): Map<string, number> {
  const ranks = new Map<string, number>();
  if (scenario === undefined) return ranks;
  scenario.steps.forEach((step, index) => ranks.set(step.id, index));
  (scenario.probes ?? []).forEach((probe, index) =>
    ranks.set(probe.id, scenario.steps.length + index),
  );
  return ranks;
}

/** Preferred ids that were actually run, in the caller's order, then anything else alphabetically. */
function orderIds(seen: readonly string[], preferred: readonly string[]): string[] {
  const present = new Set(seen);
  const ordered = preferred.filter((id) => present.has(id));
  const rest = [...present].filter((id) => !ordered.includes(id)).sort();
  return [...ordered, ...rest];
}

function indexOf(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]));
}

function countRuns(results: readonly RunResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.config, (counts.get(result.config) ?? 0) + 1);
  return counts;
}

// ---- Rendering ---------------------------------------------------------------------------------

export function renderReport(model: ReportModel): string {
  const out: string[] = [
    `# Eval report — \`${model.runId}\``,
    '',
    intro(model),
    '',
    '## How to read this',
    '',
    'Cells are pass rates over repeats: `✓` every repeat passed · `◐` mixed, or partial credit ·',
    '`✗` every repeat failed · `–` nothing decided it (the engine does not serve the check, no',
    'judge ran, or the run stopped first). The fraction counts outright passes, so two partials',
    'read `◐ 0/2`. Scores are counts, never one number: which check failed is the finding.',
    '',
    '`learned via` credits a write path with a K item when a memory write it produced repeats at',
    `least ${Math.round(CARRIES_FACT_THRESHOLD * 100)}% of that item's content words. The match is lexical and says only that the`,
    'path *wrote* something like the fact; whether the fact reached the merchant is the graded',
    '`uses:`/`recalls:` columns beside it.',
    ...(model.configs.some((config) => config.memory?.engine === 'mem0')
      ? [
          '',
          '**Mem0 caveat.** OSS Mem0 uses wall-clock timestamps internally and its built-in',
          'extraction is tuned to personal-assistant facts. The adapter dates surfaced statements',
          'with the scenario clock; dropped technical facts remain observable engine behaviour.',
        ]
      : []),
    '',
    '## Configs',
    '',
    ...configTable(model),
  ];

  for (const scenario of model.scenarios) {
    out.push('', `## \`${scenario.id}\` — ${scenario.title}`, '', '### Checks', '');
    out.push(...checkTable(scenario, model));
    if (scenario.knowledge.length > 0) {
      out.push('', '### Knowledge', '');
      out.push(...knowledgeTable(scenario, model));
    }
  }

  out.push('', '## Findings', '');
  if (model.findings.length === 0) {
    out.push(
      model.scenarios.every((scenario) => scenario.checks.length === 0)
        ? 'No checks were recorded: nothing to compare.'
        : model.configs.length < 2
          ? 'A single config: nothing to compare.'
          : 'Every config agrees on every check.',
    );
  } else {
    out.push('Checks the configs do not agree on.', '');
    for (const finding of model.findings) {
      const groups = finding.groups
        .map((group) => `${group.glyph} ${group.configs.map((id) => `\`${id}\``).join(', ')}`)
        .join(' · ');
      out.push(`- \`${finding.scenario}\` · \`${finding.owner}\` · \`${finding.key}\` — ${groups}`);
    }
  }

  if (model.errors.length > 0) {
    out.push('', '## Runs that did not finish', '', 'What they completed is still counted above.', '');
    for (const error of model.errors) {
      out.push(`- \`${error.scenario}.${error.config}.${error.repeat}\` — ${inline(error.error)}`);
    }
  }

  if (model.consolidationFailures.length > 0) {
    out.push(
      '',
      '## Consolidations that failed',
      '',
      'The engine wrote nothing for that thread at that step; the checks after it measure the gap.',
      '',
    );
    for (const failure of model.consolidationFailures) {
      out.push(
        `- \`${failure.scenario}.${failure.config}.${failure.repeat}\` · \`${failure.step}\` · ` +
          `\`${failure.thread}\` — ${inline(failure.error)}`,
      );
    }
  }

  if (model.unreadable.length > 0) {
    out.push('', '## Files skipped', '');
    for (const file of model.unreadable) out.push(`- \`${file.path}\` — ${inline(file.problem)}`);
  }

  return `${out.join('\n')}\n`;
}

function intro(model: ReportModel): string {
  const generated =
    `Generated ${model.generatedAt} from ${plural(model.resultCount, 'result file')}: ` +
    `${plural(model.scenarios.length, 'scenario')} × ${plural(model.configs.length, 'config')} × ` +
    `${plural(model.repeats, 'repeat')}.`;
  if (model.cachedResults === 0) return generated;
  return (
    `${generated}\n\n` +
    `**Cached.** ${plural(model.cachedResults, 'result file')} of ${model.resultCount} ran with the ` +
    'LLM disk cache on: identical calls replay the recorded response, so repeats of a cached run ' +
    'are the same sample graded again, and its latencies are replay times, not model latencies.'
  );
}

function configTable(model: ReportModel): string[] {
  const rows = model.configs.map((config) => [
    `\`${config.id}\``,
    config.memory?.engine ?? '?',
    config.memory?.read ?? '?',
    config.memory?.write ?? '?',
    config.agent ?? '?',
    judgeCell(config),
    String(config.runs),
    String(config.score.pass),
    String(config.score.partial),
    String(config.score.fail),
    String(config.score.skipped),
    config.costUsd === 0 ? '0' : config.costUsd.toFixed(4),
    config.medianLatencyMs === undefined ? '–' : duration(config.medianLatencyMs),
  ]);
  return table(
    // Counts, not glyphs: this table totals verdicts across every scenario of the run.
    ['config', 'engine', 'read', 'write', 'agent', 'judge', 'runs', 'pass', 'partial', 'fail', 'skipped', 'USD', 'median turn'],
    rows,
  );
}

/** D9: the judge that ran may not be the one configured. The report shows both, not a footnote. */
function judgeCell(config: ConfigSummary): string {
  if (config.judges.length === 0) return `${config.configuredJudge ?? '?'} (never ran)`;
  const ran = config.judges.join(', ');
  const configured = config.configuredJudge;
  return configured === undefined || config.judges.every((judge) => judge === configured)
    ? ran
    : `${ran} (configured: ${configured})`;
}

function checkTable(scenario: ScenarioReport, model: ReportModel): string[] {
  if (scenario.checks.length === 0) return ['No checks were recorded for this scenario.'];
  const rows = scenario.checks.map((row) => [
    `\`${row.owner}\``,
    `\`${row.key}\``,
    ...model.configs.map((config) => cellText(row.cells.get(config.id), model.repeats)),
  ]);
  return table(['step', 'check', ...model.configs.map((config) => `\`${config.id}\``)], rows);
}

function knowledgeTable(scenario: ScenarioReport, model: ReportModel): string[] {
  const rows = scenario.knowledge.map((row) => [
    row.id,
    row.item.kind,
    row.item.about,
    row.item.scope,
    row.learnedVia.length === 0 ? '–' : row.learnedVia.join(' + '),
    ...model.configs.map((config) => cellText(row.cells.get(config.id), model.repeats)),
  ]);
  return table(
    ['K', 'kind', 'about', 'scope', 'learned via', ...model.configs.map((config) => `\`${config.id}\``)],
    rows,
  );
}

/**
 * With one repeat the glyph is the whole story; with more, add how many verdicts were an
 * outright pass. A cell nothing decided gets no fraction: `– 0/2` only invites the reader to
 * mistake "the engine does not serve this" for "it failed twice".
 */
function cellText(cell: Cell | undefined, repeats: number): string {
  if (cell === undefined) return '–';
  const glyph = cellGlyph(cell);
  const total = cellTotal(cell);
  if (repeats < 2 || total < 2 || cellDecided(cell) === 0) return glyph;
  return `${glyph} ${cell.pass}/${total}`;
}

function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Keep a message on one line and inside its bullet or table cell. */
function inline(text: string): string {
  return text.replace(/\s+/gu, ' ').replace(/\|/gu, '\\|').trim();
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, column) =>
    Math.max(3, header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(' | ')} |`;
  return [
    line(headers),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...rows.map((row) => line(headers.map((_header, column) => row[column] ?? ''))),
  ];
}
