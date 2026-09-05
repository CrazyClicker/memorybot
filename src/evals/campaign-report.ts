import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { CliError } from './args.ts';
import { buildReport, loadRunResults, renderReport, RESULTS_DIR } from './report.ts';
import type { RunResult } from './schema.ts';
import { expectedResultNames, SUITE_PLAN_FILE, SuitePlanSchema } from './suites.ts';

type Evidence = { result: RunResult; path: string };
const fileName = (result: RunResult) => `${result.scenario}.${result.config}.${result.repeat}.json`;
const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

function comparison(title: string, evidence: readonly Evidence[]): string {
  const heading = `## ${title}\n\n`;
  if (evidence.length === 0) return heading + 'Not run / no usable results. Insufficient evidence.\n';
  const results = evidence.map((item) => item.result);
  const problems: string[] = [];
  if (results.some((result) => result.definition === undefined)) {
    problems.push('Saved scenario/config definitions are missing. Legacy inputs cannot establish this comparison.');
  }
  const agents = new Set(results.map((result) => JSON.stringify(result.definition?.config.agent)));
  if (agents.size > 1) problems.push('Support-agent models/settings differ.');
  const judges = new Set(results.flatMap((result) => result.judge === undefined ? [] : [JSON.stringify(result.judge)]));
  if (judges.size > 1) problems.push('Actual judge models/settings differ.');
  const reads = new Set(results.map((result) => result.definition?.config.memory.read));
  if (reads.size > 1) problems.push('Memory read modes differ.');
  const cached = new Set(results.map((result) => result.cached === true));
  if (cached.size > 1) problems.push('Cached replays and fresh samples are mixed.');
  let report;
  try {
    report = buildReport({
      runId: title,
      results,
      sources: new Map(evidence.map((item) => [item.result, item.path])),
    });
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (problems.length > 0 || report === undefined) {
    return heading + '**Comparison blocked: incompatible or unverified recorded inputs.**\n\n' +
      problems.map((problem) => `- ${cell(problem)}`).join('\n') + '\n\n' +
      'Result files remain listed in the evidence index; inspect them individually.\n';
  }
  const unknownJudge = results.filter((result) => result.judge === undefined).length;
  const unknownCache = results.filter((result) => result.cached === undefined).length;
  return heading + (unknownJudge === 0 ? '' : `${unknownJudge} result(s) do not record an actual judge; judge equivalence is unverified for those results.\n\n`) +
    (unknownCache === 0 ? '' : `${unknownCache} result(s) do not record cache status; fresh sampling is unverified for those results.\n\n`) +
    renderReport(report).replace(/^(#{1,5}) /gm, '#$1 ');
}

/** Read-only aggregation. Baselines may appear in two comparisons, but spend counts each source once. */
export async function renderCampaignReport(runIds: readonly string[], resultsDir = RESULTS_DIR): Promise<string> {
  const ids = [...new Set(runIds)];
  const groups = new Map<string, Evidence[]>();
  const planned = new Map<string, Set<string>>();
  const allEvidence = new Map<string, Evidence>();
  const fingerprints = new Map<string, string>();
  const coverage: string[] = [];
  const issues: string[] = [];
  for (const id of ids) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new CliError(`Invalid report run id: ${id}.`);
    const runDir = join(resultsDir, id);
    let plan;
    try {
      plan = SuitePlanSchema.parse(parseYaml(await readFile(join(runDir, SUITE_PLAN_FILE), 'utf8')));
    } catch (error) {
      throw new CliError(`Cannot combine ${id}: a valid saved ${SUITE_PLAN_FILE} is required. ${(error as Error).message}`);
    }
    for (const group of plan.groups) {
      const expected = new Set(expectedResultNames(group, plan.repeat));
      const pairs = planned.get(group.id) ?? new Set<string>();
      for (const scenario of group.scenarios) for (const config of group.configs) pairs.add(`${scenario}/${config}`);
      planned.set(group.id, pairs);
      let loaded: Awaited<ReturnType<typeof loadRunResults>>;
      try {
        loaded = await loadRunResults(join(runDir, group.id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        loaded = { results: [], unreadable: [] };
      }
      const present = new Set<string>();
      const collected = groups.get(group.id) ?? [];
      for (const result of loaded.results) {
        const name = fileName(result);
        const path = loaded.sources?.get(result) ?? join(runDir, group.id, name);
        if (!expected.has(name) || path !== join(runDir, group.id, name)) {
          issues.push(`Unplanned result excluded: ${path}`);
          continue;
        }
        present.add(name);
        const fingerprint = JSON.stringify(result);
        const original = fingerprints.get(fingerprint);
        if (original !== undefined) {
          issues.push(`Duplicate evidence excluded: ${path}; same recorded result as ${original}.`);
          continue;
        }
        fingerprints.set(fingerprint, path);
        const item = { result, path };
        collected.push(item);
        allEvidence.set(path, item);
      }
      groups.set(group.id, collected);
      coverage.push(`| ${id}/${group.id} | ${present.size} / ${expected.size} | ${present.size === expected.size ? 'Present; inspect errors/checks' : 'Incomplete'} |`);
      for (const name of expected) {
        if (!present.has(name)) issues.push(`Missing planned result: ${join(runDir, group.id, name)}`);
      }
      for (const file of loaded.unreadable) issues.push(`Unreadable result: ${file.path}: ${file.problem}`);
    }
  }

  const core = groups.get('core') ?? [];
  const writes = groups.get('write-paths') ?? [];
  const sections: string[] = [];
  for (const name of ['controls', 'core', 'stress']) {
    const evidence = groups.get(name) ?? [];
    const unexpected = evidence.filter(({ result }) => result.definition !== undefined &&
      (result.definition.config.memory.read !== 'hydrate' || result.definition.config.memory.write !== 'consolidate'));
    sections.push(unexpected.length === 0 ? comparison(name, evidence) :
      `## ${name}\n\n**Comparison blocked:** this group requires hydrate/consolidate.\n`);
  }
  sections.push('## Write paths\n\nBaseline results below are reused from core, without new model calls. ' +
    'Their costs appear in the comparison tables but are counted only once in campaign spend.\n');
  const plannedWrites = planned.get('write-paths') ?? new Set<string>();
  if (plannedWrites.size === 0) sections.push('Not selected. Writing-mode superiority remains untested.\n');
  for (const engine of ['naive', 'notes']) {
    const variantIds = engine === 'naive' ? ['naive-agent'] : ['notes-agent', 'notes-both'];
    const scenarioIds = new Set([...plannedWrites].flatMap((pair) => {
      const [scenario, config] = pair.split('/');
      return scenario !== undefined && config !== undefined && variantIds.includes(config) ? [scenario] : [];
    }));
    if (scenarioIds.size === 0) continue;
    const baselines = core.filter(({ result }) => result.config === engine && scenarioIds.has(result.scenario));
    const variants = writes.filter(({ result }) => variantIds.includes(result.config) && scenarioIds.has(result.scenario));
    const evidence = [...baselines, ...variants];
    const absent = [...scenarioIds].filter((scenario) => !baselines.some(({ result }) => result.scenario === scenario));
    if (absent.length > 0) {
      sections.push(`Missing ${engine} core baseline for: ${absent.map((id) => `\`${id}\``).join(', ')}. ` +
        'These stories cannot establish a writing-mode effect.\n');
    }
    const wrongMode = evidence.some(({ result }) => {
      if (result.definition === undefined) return false; // comparison() reports missing definitions.
      const memory = result.definition.config.memory;
      const expectedWrite = result.config === engine ? 'consolidate' : result.config.endsWith('-both') ? 'both' : 'agent';
      return memory.engine !== engine || memory.read !== 'hydrate' || memory.write !== expectedWrite;
    });
    sections.push(wrongMode ? `## Write paths: ${engine}\n\n**Comparison blocked:** unexpected engine/read/write configuration.\n` :
      comparison(`Write paths: ${engine}`, evidence));
  }

  const unique = [...allEvidence.values()];
  const cost = unique.reduce((total, item) => total + item.result.costUsd, 0);
  const errors = unique.filter((item) => item.result.error !== undefined).length;
  const index = unique.map(({ result, path }) =>
    `| \`${cell(path)}\` | ${result.scenario} | ${result.config} | ${result.repeat} | ${result.error === undefined ? 'Recorded' : 'Error / incomplete'} |`);
  const unsupported = [...groups.keys()].filter((name) => !['controls', 'core', 'stress', 'write-paths'].includes(name));
  for (const name of unsupported) issues.push(`Group ${name} has no defined research comparison; included only in coverage, spend and evidence index.`);

  return '# Research report\n\n' +
    `Sources: ${ids.map((id) => `\`${id}\``).join(', ')}. No model calls were made to assemble this report.\n\n` +
    '## Campaign coverage and spend\n\n' +
    `Unique recorded results: **${unique.length}**. Observed spend: **$${cost.toFixed(4)}**. ` +
    `Results with execution errors: **${errors}**. Reused baseline rows are not new spend.\n\n` +
    'Observed spend is not the full bill: hosted internal usage and unrecorded failed calls remain unknown. ' +
    'Counts of present files do not establish successful checks or independent samples. Exact copied results are excluded.\n\n' +
    '| Source group | Present / planned results | Coverage |\n| --- | ---: | --- |\n' + coverage.join('\n') + '\n\n' +
    '## Comparability and interpretation\n\n' +
    'Each comparison checks saved scenario/config definitions, support-model settings, recorded actual judges, read modes and cache status. ' +
    'Incompatible comparisons are blocked locally; other sections remain available. ' +
    'Code, wiki, dependencies and provider settings are not fingerprinted in these results: verify their equivalence in the campaign record. ' +
    'Different repeat counts remain visible; follow-up selection and model variance require manual interpretation. ' +
    'There is no pooled score across source controls, engine comparisons and stress. ' +
    'For CSV fidelity, audit source-control and core branch checks together before attributing loss to memory.\n\n' +
    (issues.length === 0 ? '' : '## Input issues\n\n' + issues.map((issue) => `- ${cell(issue)}`).join('\n') + '\n\n') +
    sections.join('\n\n') + '\n\n' +
    '## Research decision record\n\n' +
    '| Question | Decision | Evidence / limitations |\n| --- | --- | --- |\n' +
    [
      ['Does memory improve later answers?', 'core / incidental-learning'],
      ['Does memory preserve technical meaning?', 'controls + core / semantic-fidelity'],
      ['Are expiry and recovery confirmation distinct?', 'core / incident timing'],
      ['Do updates survive old-ticket replay?', 'core / customer-setup-change'],
      ['Can memory learn from operator replies?', 'core / human-reply-only'],
      ['Are sharing boundaries respected?', 'core / isolation and publication'],
      ['Is old knowledge retained beyond the transcript budget?', 'stress'],
      ['Which writing mode is justified?', 'Write paths: naive / notes; or untested if omitted'],
    ].map(([question, evidence]) => `| ${question} | Review pending | ${evidence} |`).join('\n') + '\n\n' +
    'Record supported / not supported / insufficient evidence, exact check references, judge audit and disagreements. ' +
    'Then record the engine/write-path choice, quality/cost tradeoff, remaining unknowns and what would change the decision.\n\n' +
    '## Evidence index\n\nOriginal repeat numbers are local to their source runs. ' +
    'Every accepted result retains its original file path; baseline reuse does not create another sample.\n\n' +
    '| Source JSON | Scenario | Config | Original repeat | Execution |\n| --- | --- | --- | ---: | --- |\n' +
    index.join('\n') + '\n';
}
