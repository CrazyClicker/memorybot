import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGS_DIR, fileStem, listYamlFiles, loadScenario, SCENARIOS_DIR, validateFiles, wikiSlugs } from './load.ts';

describe('the repository content', () => {
  it('validates every scenario and config without errors', async () => {
    const files = await validateFiles({
      scenarios: await listYamlFiles(SCENARIOS_DIR),
      configs: await listYamlFiles(CONFIGS_DIR),
    });
    const all = [...files.scenarios, ...files.configs];
    expect(all.length).toBeGreaterThanOrEqual(3);

    const errors = all.flatMap((file) =>
      file.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `${file.path} ${issue.path}: ${issue.message}`),
    );
    expect(errors).toEqual([]);
    for (const file of all) expect(file.value, file.path).toBeDefined();
  });

  it('lists the wiki pages by slug and skips the README', async () => {
    const slugs = await wikiSlugs();
    expect(slugs.has('import-eksport-csv')).toBe(true);
    expect(slugs.has('pravila-podderzhki')).toBe(true);
    expect(slugs.has('README')).toBe(false);
  });
});

describe('loading files', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-load-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a YAML syntax error with the line', async () => {
    const path = join(dir, 'broken.yaml');
    await writeFile(path, 'id: broken\ntitle: [unclosed\n', 'utf8');
    const loaded = await loadScenario(path);
    expect(loaded.value).toBeUndefined();
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0]?.message).toMatch(/^YAML syntax at line \d+:/);
  });

  it('reports a missing file instead of throwing', async () => {
    const loaded = await loadScenario(join(dir, 'missing.yaml'));
    expect(loaded.issues[0]?.message).toMatch(/cannot read file/);
  });

  it('checks the id against the file name', async () => {
    const path = join(dir, 'named.yaml');
    await writeFile(
      path,
      [
        'id: other',
        'title: T',
        'world: { knowledge_base: none, clock: 2026-09-01T09:00:00Z, customers: { alfa: { name: A } } }',
        'knowledge: {}',
        'steps:',
        '  - { id: s1, type: customer_message, thread: t1, customer: alfa, at: 2026-09-01T09:00:00Z, content: Привет }',
      ].join('\n'),
      'utf8',
    );
    const loaded = await loadScenario(path);
    expect(loaded.issues.map((issue) => issue.path)).toEqual(['id']);
  });

  it('lists yaml files sorted and ignores the rest', async () => {
    await writeFile(join(dir, 'b.yaml'), 'id: b\n');
    await writeFile(join(dir, 'a.yml'), 'id: a\n');
    await writeFile(join(dir, 'notes.md'), '# no\n');
    expect(await listYamlFiles(dir)).toEqual([join(dir, 'a.yml'), join(dir, 'b.yaml')]);
  });

  it('derives the file stem', () => {
    expect(fileStem('evals/scenarios/csv-import-dropped-rows.yaml')).toBe('csv-import-dropped-rows');
    expect(fileStem('x.yml')).toBe('x');
  });
});
