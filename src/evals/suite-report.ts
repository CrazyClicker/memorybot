import { join } from 'node:path';

import { buildReport, loadRunResults, renderReport } from './report.ts';
import { expectedResultNames, type SuitePlan } from './suites.ts';

/** Keep different experimental conditions out of a pooled engine ranking. */
export async function renderSuiteReport(runId: string, runDir: string, plan: SuitePlan): Promise<string> {
  const sections: string[] = [];
  const coverage: string[] = [];
  for (const group of plan.groups) {
    const expected = new Set(expectedResultNames(group, plan.repeat));
    let loaded: Awaited<ReturnType<typeof loadRunResults>>;
    try {
      loaded = await loadRunResults(join(runDir, group.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      loaded = { results: [], unreadable: [] };
    }
    const results = loaded.results.filter((result) =>
      expected.has(`${result.scenario}.${result.config}.${result.repeat}.json`));
    const present = new Set(results.map((result) => `${result.scenario}.${result.config}.${result.repeat}.json`));
    const missing = [...expected].filter((name) => !present.has(name));
    const unexpected = loaded.results.length - results.length;
    coverage.push(`| ${group.id} | ${present.size} / ${expected.size} | ${missing.length === 0 ? 'Present; inspect errors and checks' : 'Incomplete'} |`);
    const body = results.length === 0 ? 'No planned results are available. No hypothesis conclusion is supported.\n' :
      renderReport(buildReport({ runId: `${runId}/${group.id}`, results, unreadable: loaded.unreadable }))
        .replace(/^(#{1,5}) /gm, '#$1 ');
    sections.push(`## ${group.id}\n\n${group.purpose}\n\n` +
      (missing.length === 0 ? '' : `Missing planned results:\n\n${missing.map((name) => `- \`${name}\``).join('\n')}\n\n`) +
      (unexpected === 0 ? '' : `${unexpected} unplanned result(s) excluded from this comparison.\n\n`) +
      (loaded.unreadable.length === 0 ? '' : `Unreadable files:\n\n${loaded.unreadable.map((file) => `- ${file.path}: ${file.problem}`).join('\n')}\n\n`) +
      body);
  }
  return `# Eval suite: ${plan.suite}\n\nRun: \`${runId}\`. Planned repeats per pair: ${plan.repeat}.\n\n` +
    'Comparisons below are separate; there is no pooled engine score across groups. ' +
    'Source-control CSV branches must be compared manually with core branches. ' +
    'Write-path variants require the matching naive/notes core baselines. ' +
    'Complete the campaign decision record and record omitted comparisons.\n\n' +
    '| Group | Present / planned results | Coverage |\n| --- | ---: | --- |\n' +
    coverage.join('\n') + '\n\n' + sections.join('\n\n');
}
