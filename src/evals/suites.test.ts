import { describe, expect, it } from 'vitest';

import { listYamlFiles, loadConfig } from './load.ts';
import { GROUPS, SUITES, suiteGroups } from './suites.ts';

describe('suite scope', () => {
  it('covers every input without multiplying the source control or repeating baselines', async () => {
    const groups = [...suiteGroups('research'), ...suiteGroups('write-paths')];
    const scenarios = [...new Set(groups.flatMap((group) => group.scenarioPaths))].sort();
    expect(scenarios).toEqual((await Promise.all([
      listYamlFiles('evals/scenarios'), listYamlFiles('evals/controls'), listYamlFiles('evals/stress'),
    ])).flat().sort());
    const configs = [...new Set(groups.flatMap((group) => group.configPaths))].sort();
    expect(configs).toEqual(await listYamlFiles('evals/configs'));
    const pairs = groups.flatMap((group) => group.scenarioPaths.flatMap((scenario) =>
      group.configPaths.map((config) => `${scenario}/${config}`)));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(GROUPS.controls.configs).toEqual(['none']);
    expect(SUITES.research).toEqual(['controls', 'core', 'stress']);
  });

  it('holds read/write fixed in engine comparisons and read fixed in the writing experiment', async () => {
    for (const group of suiteGroups('research')) {
      for (const path of group.configPaths) {
        const config = await loadConfig(path);
        expect(config.issues).toEqual([]);
        expect(config.value?.memory).toMatchObject({ read: 'hydrate', write: 'consolidate' });
      }
    }
    for (const path of suiteGroups('write-paths')[0]!.configPaths) {
      expect((await loadConfig(path)).value?.memory.read).toBe('hydrate');
    }
    expect(() => suiteGroups('typo')).toThrow('Unknown suite');
  });
});
