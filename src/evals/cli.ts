#!/usr/bin/env tsx
/** `pnpm eval <command>`. Unimplemented commands exit 2 and name their ROADMAP task. */
import 'dotenv/config';

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { cacheDirFrom } from '../llm/index.ts';
import { cachedRepeatsProblem, CliError, type CommandName, COMMANDS, parseCli } from './args.ts';
import { createJudge, type Judge, resolveJudgeSpec } from './judge.ts';
import { CONFIGS_DIR, listYamlFiles, type LoadedFile, SCENARIOS_DIR, validateFiles } from './load.ts';
import { MissingCredentialError, type MemoryEngine } from '../memory/index.ts';
import {
  buildReport,
  latestRunId,
  loadRunResults,
  renderReport,
  REPORT_FILE,
  RESULTS_DIR,
} from './report.ts';
import { createMemoryEngine, runScenarioRepeats } from './runner.ts';
import { RunResultSchema, type Config, type Scenario } from './schema.ts';
import { hasErrors } from './validate.ts';
import { suiteGroups, SUITE_PLAN_FILE, SuitePlanSchema, type RunGroup } from './suites.ts';
import { renderSuiteReport } from './suite-report.ts';
import { renderCampaignReport } from './campaign-report.ts';

const EXIT_USAGE = 1;
const EXIT_NOT_IMPLEMENTED = 2;

type Command = (values: Record<string, unknown>) => Promise<void>;

const notImplemented =
  (name: CommandName): Command =>
  async () => {
    const { task, summary } = COMMANDS[name];
    process.stderr.write(
      `\`pnpm eval ${name}\` is not implemented yet.\n` +
        `  what it will do: ${summary}\n` +
        `  implemented by:  ROADMAP ${task}\n`,
    );
    process.exitCode = EXIT_NOT_IMPLEMENTED;
  };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function printFile(file: LoadedFile<unknown>): void {
  process.stdout.write(`${hasErrors(file.issues) ? 'FAIL' : 'ok  '}  ${file.path}\n`);
  for (const issue of file.issues) {
    const where = issue.path === '' ? '' : `${issue.path}: `;
    process.stdout.write(`      ${issue.severity.padEnd(8)} ${where}${issue.message}\n`);
  }
}

/** T2.1. Exit 1 when any file has an error; warnings are printed and do not fail. */
const validate: Command = async (values) => {
  const scenarioArgs = stringList(values['scenario']);
  const configArgs = stringList(values['config']);
  const explicit = scenarioArgs.length > 0 || configArgs.length > 0;

  const files = await validateFiles({
    scenarios: explicit ? scenarioArgs : await listYamlFiles(SCENARIOS_DIR),
    configs: explicit ? configArgs : await listYamlFiles(CONFIGS_DIR),
  });
  const all = [...files.scenarios, ...files.configs];
  if (all.length === 0) {
    process.stderr.write('Nothing to validate.\n');
    process.exitCode = EXIT_USAGE;
    return;
  }

  let failed = 0;
  let warnings = 0;
  for (const file of all) {
    printFile(file);
    if (hasErrors(file.issues)) failed += 1;
    warnings += file.issues.filter((issue) => issue.severity === 'warning').length;
  }
  process.stdout.write(
    `\n${plural(all.length, 'file')} checked: ${all.length - failed} ok, ${failed} with errors, ${plural(warnings, 'warning')}.\n`,
  );
  process.exitCode = failed > 0 ? 1 : 0;
};

interface RunSelection {
  readonly groups: readonly RunGroup[];
  readonly suite?: string;
  readonly scenarioPaths: readonly string[];
  readonly configPaths: readonly string[];
  readonly repeat: number;
  readonly runId: string;
  readonly all: boolean;
}

async function runSelection(values: Record<string, unknown>): Promise<RunSelection> {
  const all = values['all'] === true;
  const suite = stringValue(values['suite']);
  const scenarios = stringList(values['scenario']);
  const configs = stringList(values['config']);
  if ((all && suite !== undefined) || ((all || suite !== undefined) && (scenarios.length > 0 || configs.length > 0))) {
    throw new CliError('Use one selection: --suite, --all, or explicit --scenario and --config.');
  }
  if (!all && suite === undefined && (scenarios.length === 0 || configs.length === 0)) {
    throw new CliError('Run needs --suite, --all, or at least one --scenario and one --config.');
  }

  const repeatText = stringValue(values['repeat']) ?? '1';
  if (!/^[1-9]\d*$/.test(repeatText)) {
    throw new CliError(`--repeat must be a positive integer, got "${repeatText}".`);
  }
  const repeat = Number(repeatText);
  if (!Number.isSafeInteger(repeat)) {
    throw new CliError(`--repeat is too large, got "${repeatText}".`);
  }

  const runId = stringValue(values['run-id']) ?? defaultRunId();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(runId)) {
    throw new CliError('--run-id must use lowercase letters, digits, "-" and "_".');
  }

  const groups = suite !== undefined ? suiteGroups(suite) : [{
    id: 'matrix',
    purpose: all ? 'All core scenario files against all config files.' : 'Explicit scenario/config selection.',
    scenarioPaths: all ? await listYamlFiles(SCENARIOS_DIR) : scenarios,
    configPaths: all ? await listYamlFiles(CONFIGS_DIR) : configs,
  }];
  return {
    groups,
    suite,
    scenarioPaths: [...new Set(groups.flatMap((group) => group.scenarioPaths))],
    configPaths: [...new Set(groups.flatMap((group) => group.configPaths))],
    repeat,
    runId,
    all,
  };
}

function requiredValues<T>(files: readonly LoadedFile<T>[]): T[] {
  return files.map((file) => {
    if (file.value === undefined || hasErrors(file.issues)) {
      throw new Error(`Cannot run invalid file ${file.path}`);
    }
    return file.value;
  });
}

function agentCallCount(scenarios: readonly Scenario[], configs: readonly Config[], repeat: number): number {
  const turns = scenarios.reduce(
    (total, scenario) => total + scenario.steps.filter((step) => step.type === 'agent_turn').length,
    0,
  );
  return turns * configs.length * repeat;
}

/** One judge call per judged expectation. An upper bound: probes an engine cannot serve skip. */
function judgeCallCount(
  scenarios: readonly Scenario[],
  configs: readonly Config[],
  repeat: number,
): number {
  const judged = scenarios.reduce((total, scenario) => {
    const turns = scenario.steps.reduce((count, step) => {
      if (step.type !== 'agent_turn' || step.expect === undefined) return count;
      const { uses, must_not_use, reply } = step.expect;
      return count + (uses?.length ?? 0) + (must_not_use?.length ?? 0) + (reply?.rubric === undefined ? 0 : 1);
    }, 0);
    const probes = (scenario.probes ?? []).reduce((count, probe) => {
      if (probe.type === 'documentation_proposals') return count + (probe.expect.proposes?.length ?? 0);
      return count + (probe.expect.recalls?.length ?? 0) + (probe.expect.must_not_recall?.length ?? 0);
    }, 0);
    return total + turns + probes;
  }, 0);
  return judged * configs.length * repeat;
}

const run: Command = async (values) => {
  const selection = await runSelection(values);
  const files = await validateFiles({
    scenarios: selection.scenarioPaths,
    configs: selection.configPaths,
  });
  const loaded = [...files.scenarios, ...files.configs];
  loaded.forEach(printFile);
  if (loaded.length === 0 || loaded.some((file) => file.value === undefined || hasErrors(file.issues))) {
    process.stderr.write('Run aborted: fix validation errors first.\n');
    process.exitCode = EXIT_USAGE;
    return;
  }

  const scenarios = requiredValues(files.scenarios);
  const configs = requiredValues(files.configs);
  const scenarioByPath = new Map(files.scenarios.map((file, index) => [file.path, scenarios[index]!]));
  const configByPath = new Map(files.configs.map((file, index) => [file.path, configs[index]!]));
  const groups = selection.groups.map((group) => ({
    id: group.id,
    purpose: group.purpose,
    scenarios: group.scenarioPaths.map((path) => scenarioByPath.get(path)!),
    configs: group.configPaths.map((path) => configByPath.get(path)!),
  }));

  const agentCalls = groups.reduce((count, group) => count + agentCallCount(group.scenarios, group.configs, selection.repeat), 0);
  const judgeCalls = groups.reduce((count, group) => count + judgeCallCount(group.scenarios, group.configs, selection.repeat), 0);
  const runCount = groups.reduce((count, group) => count + group.scenarios.length * group.configs.length * selection.repeat, 0);
  const cached = cacheDirFrom() !== undefined;
  for (const group of groups) {
    process.stdout.write(`\n${group.id}: ${group.purpose}\n` +
      `  scenarios: ${group.scenarios.map((scenario) => scenario.id).join(', ')}\n` +
      `  configs: ${group.configs.map((config) => config.id).join(', ')}\n`);
  }
  process.stdout.write(
    `\nPlan: ${runCount} scenario/config run(s), ${selection.repeat} repeat(s) per pair, ` +
      `${agentCalls} agent turn(s) and up to ` +
      `${judgeCalls} judge call(s). A turn is a tool loop: several model calls. ` +
      `LLM cache: ${cached ? 'on (identical calls replay)' : 'off'}.\n`,
  );
  if (values['dry-run'] === true) return;
  const cacheProblem = cachedRepeatsProblem({
    cached,
    repeat: selection.repeat,
    allowed: values['allow-cached-repeats'] === true,
  });
  if (cacheProblem !== undefined) throw new CliError(cacheProblem);
  if ((selection.all || selection.suite !== undefined) && values['yes'] !== true) {
    process.stderr.write('Suite and --all runs require --yes after reviewing the call estimate.\n');
    process.exitCode = EXIT_USAGE;
    return;
  }
  const outputDir = join(RESULTS_DIR, selection.runId);
  // A suite owns its directory and plan. Refuse collisions before any paid calls.
  if (selection.suite !== undefined) {
    await mkdir(RESULTS_DIR, { recursive: true });
    try {
      await mkdir(outputDir);
    } catch (error) {
      throw new CliError(`Suite needs a fresh results directory: ${outputDir}: ${(error as Error).message}`);
    }
    const plan = SuitePlanSchema.parse({
      version: 1,
      suite: selection.suite,
      repeat: selection.repeat,
      groups: groups.map((group) => ({
        id: group.id, purpose: group.purpose,
        scenarios: group.scenarios.map((scenario) => scenario.id),
        configs: group.configs.map((config) => config.id),
      })),
    });
    await writeFile(join(outputDir, SUITE_PLAN_FILE), stringifyYaml(plan), { flag: 'wx' });
  } else {
    // Do not accidentally append a flat matrix to a suite directory.
    try {
      await access(join(outputDir, SUITE_PLAN_FILE));
      throw new CliError(`Results directory belongs to a suite: ${outputDir}. Use a fresh --run-id.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // Build every engine and judge up front: a missing API key or an unimplemented engine
  // must stop the run before the first paid agent call, not half-way through the matrix.
  const runtimes = new Map<string, { engine: MemoryEngine; judge: Judge }>();
  const skippedConfigs = new Set<string>();
  for (const config of configs) {
    const { spec, warning } = resolveJudgeSpec(config.judge);
    if (warning !== undefined) process.stderr.write(`Config "${config.id}": ${warning}\n`);
    try {
      runtimes.set(config.id, {
        engine: createMemoryEngine(config),
        judge: createJudge(spec),
      });
    } catch (error) {
      if (error instanceof MissingCredentialError) {
        skippedConfigs.add(config.id);
        process.stderr.write(
          `skipped  Config "${config.id}": ${error.message}; no paid calls were made.\n`,
        );
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError(`Config "${config.id}" cannot run: ${message}`);
    }
  }

  await mkdir(outputDir, { recursive: true });
  let failed = 0;
  let written = 0;

  for (const group of groups) {
    const groupDir = selection.suite === undefined ? outputDir : join(outputDir, group.id);
    await mkdir(groupDir, { recursive: true });
    for (const scenario of group.scenarios) {
      for (const config of group.configs) {
        const runtime = runtimes.get(config.id);
        if (runtime === undefined && skippedConfigs.has(config.id)) continue;
        if (runtime === undefined) throw new Error(`No runtime built for config "${config.id}"`);
        try {
          const results = await runScenarioRepeats(scenario, config, selection.repeat, { ...runtime, cached });
          for (const result of results) {
            const parsed = RunResultSchema.parse(result);
            const path = join(groupDir, `${scenario.id}.${config.id}.${result.repeat}.json`);
            await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
            process.stdout.write(`${result.error === undefined ? 'ok  ' : 'FAIL'}  ${path}\n`);
            if (result.error !== undefined) {
              process.stderr.write(`      ${result.error}\n`);
              failed += 1;
            }
            written += 1;
          }
        } finally {
          await runtime.engine.cleanup?.();
        }
      }
    }
  }

  process.stdout.write(`\n${written} result file(s) written to ${outputDir}.\n`);
  const incomplete = selection.suite !== undefined && written !== runCount;
  if (incomplete) process.stderr.write(`Suite incomplete: ${written} / ${runCount} planned results written.\n`);
  process.exitCode = failed === 0 && !incomplete ? 0 : 1;
};

function defaultRunId(): string {
  return new Date().toISOString().toLowerCase().replace(/[-:.]/g, '');
}

function definedValues<T>(files: readonly LoadedFile<T>[]): T[] {
  return files.flatMap((file) => (file.value === undefined ? [] : [file.value]));
}

/**
 * T2.7. Scenarios and configs are read for titles, K items and column order only, so a file
 * that no longer parses is skipped rather than failing the aggregation: a report must stay
 * producible from a run directory whose sources have since been edited.
 */
const report: Command = async (values) => {
  const runIds = [...new Set(stringList(values['run']))];
  if (runIds.length > 1) {
    const markdown = await renderCampaignReport(runIds);
    const outPath = stringValue(values['out']) ?? join(RESULTS_DIR, 'RESEARCH-REPORT.md');
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, markdown, 'utf8');
    process.stdout.write(`${outPath}: research report from ${runIds.length} suite runs; core baselines reused for write paths.\n`);
    return;
  }
  const runId = runIds[0] ?? (await latestRunId());
  if (runId === undefined) {
    process.stderr.write(`No runs under ${RESULTS_DIR}. Run \`pnpm eval run\` first.\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }

  const runDir = join(RESULTS_DIR, runId);
  let suitePlan;
  try {
    suitePlan = SuitePlanSchema.parse(parseYaml(await readFile(join(runDir, SUITE_PLAN_FILE), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CliError(`Cannot read suite plan in ${runDir}: ${(error as Error).message}`);
    }
  }
  if (suitePlan !== undefined) {
    const outPath = stringValue(values['out']) ?? join(runDir, 'REPORT.md');
    const markdown = await renderSuiteReport(runId, runDir, suitePlan);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, markdown, 'utf8');
    process.stdout.write(`${outPath}: suite ${suitePlan.suite}, ${suitePlan.groups.length} separate comparisons.\n`);
    return;
  }
  let loaded;
  try {
    loaded = await loadRunResults(runDir);
  } catch (error) {
    throw new CliError(`Cannot read ${runDir}: ${(error as Error).message}`);
  }
  for (const file of loaded.unreadable) {
    process.stderr.write(`skipped  ${file.path}: ${file.problem}\n`);
  }
  if (loaded.results.length === 0) {
    process.stderr.write(`No result files in ${runDir}.\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }

  const files = await validateFiles({
    scenarios: await listYamlFiles(SCENARIOS_DIR),
    configs: await listYamlFiles(CONFIGS_DIR),
  });
  const model = buildReport({
    runId,
    results: loaded.results,
    scenarios: definedValues(files.scenarios),
    configs: definedValues(files.configs),
    unreadable: loaded.unreadable,
  });

  const outPath = stringValue(values['out']) ?? REPORT_FILE;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, renderReport(model), 'utf8');

  process.stdout.write(
    `${outPath}: run ${runId}, ${plural(model.resultCount, 'result')}, ` +
      `${plural(model.configs.length, 'config')}, ${plural(model.scenarios.length, 'scenario')}, ` +
      `${plural(model.findings.length, 'finding')}` +
      `${model.errors.length === 0 ? '' : `, ${plural(model.errors.length, 'run')} with errors`}.\n`,
  );
};

const HANDLERS: Record<CommandName, Command> = {
  validate,
  run,
  report,
  'lint-wiki': notImplemented('lint-wiki'),
};

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    throw error;
  }

  if (parsed.kind === 'help') {
    process.stdout.write(`${parsed.text}\n`);
    return;
  }
  try {
    await HANDLERS[parsed.name](parsed.values);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n\n${COMMANDS[parsed.name].usage}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    throw error;
  }
}

await main();
