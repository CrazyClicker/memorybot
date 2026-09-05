import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config, Scenario } from './schema.ts';

// Exercise actual planning, dispatch, serialization and reporting with no model/provider calls.
const fake = vi.hoisted(() => ({ engine: vi.fn(), run: vi.fn(), judge: vi.fn() }));
vi.mock('./runner.ts', () => ({ createMemoryEngine: fake.engine, runScenarioRepeats: fake.run }));
vi.mock('./judge.ts', () => ({
  createJudge: fake.judge,
  resolveJudgeSpec: (spec: unknown) => ({ spec }),
}));

let runId: string;
let output: string;
let errors: string;
const originalArgv = process.argv;
const originalExit = process.exitCode;

async function invoke(args: string[]) {
  vi.resetModules();
  process.exitCode = 0;
  process.argv = ['node', 'cli.ts', ...args];
  await import('./cli.ts');
  return process.exitCode;
}

beforeEach(() => {
  runId = `test-suite-${randomUUID()}`;
  output = ''; errors = '';
  vi.stubEnv('LLM_CACHE', '0');
  vi.spyOn(process.stdout, 'write').mockImplementation((value) => { output += String(value); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((value) => { errors += String(value); return true; });
  fake.engine.mockReset().mockReturnValue({ cleanup: async () => {} });
  fake.judge.mockReset().mockReturnValue({});
  fake.run.mockReset().mockImplementation(async (scenario: Scenario, config: Config, repeat: number) =>
    Array.from({ length: repeat }, (_, index) => ({
      scenario: scenario.id, config: config.id, repeat: index + 1,
      definition: { scenario, config }, startedAt: '2026-09-05T10:00:00Z',
      steps: [], consolidations: [], probes: [],
      score: { pass: 0, partial: 0, fail: 0, skipped: 0 }, costUsd: 0,
      error: 'Offline fixture: deliberately stopped before the first turn.',
    })));
});

afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(join('evals/results', runId), { recursive: true, force: true });
  await rm(join('evals/results', `${runId}-writes`), { recursive: true, force: true });
});

describe('suite CLI', () => {
  it('combines two suite runs offline with the repeatable --run option', async () => {
    await invoke(['run', '--suite', 'research', '--yes', '--run-id', runId]);
    await invoke(['run', '--suite', 'write-paths', '--yes', '--run-id', `${runId}-writes`]);
    const calls = fake.run.mock.calls.length;
    const engines = fake.engine.mock.calls.length;
    const out = join('evals/results', runId, 'COMBINED.md');
    expect(await invoke(['report', '--run', runId, '--run', `${runId}-writes`, '--out', out])).toBe(0);
    const report = await readFile(out, 'utf8');
    expect(report).toContain('Unique recorded results: **46**');
    expect(report).toContain('## Write paths: naive');
    expect(report).toContain('## Write paths: notes');
    expect(fake.run).toHaveBeenCalledTimes(calls);
    expect(fake.engine).toHaveBeenCalledTimes(engines);
  });
  it('dry-runs the exact 31-pair research plan even with --yes, without runtimes or files', async () => {
    expect(await invoke(['run', '--suite', 'research', '--dry-run', '--yes', '--run-id', runId])).toBe(0);
    expect(output).toContain('31 scenario/config run(s)');
    expect(output).toContain('143 agent turn(s) and up to 373 judge call(s)');
    expect(output).not.toContain('notes-agent');
    expect(fake.engine).not.toHaveBeenCalled();
    expect(fake.judge).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
    await expect(access(join('evals/results', runId))).rejects.toThrow();
  });

  it('keeps write paths explicit and multiplies only fresh repeats', async () => {
    expect(await invoke(['run', '--suite', 'write-paths', '--repeat', '2', '--dry-run'])).toBe(0);
    expect(output).toContain('30 scenario/config run(s)');
    expect(output).toContain('156 agent turn(s) and up to 420 judge call(s)');
    expect(fake.run).not.toHaveBeenCalled();
  });

  it.each([
    ['--suite', 'research'],
    ['--suite', 'unknown', '--yes'],
    ['--suite', 'core', '--all', '--yes'],
    ['--suite', 'core', '--scenario', 'evals/scenarios/human-reply-only.yaml', '--yes'],
    ['--suite', 'core', '--config', 'evals/configs/none.yaml', '--yes'],
  ])('refuses an unconfirmed or ambiguous selection: %j', async (...args) => {
    expect(await invoke(['run', ...args, '--run-id', runId])).toBe(1);
    expect(errors).not.toBe('');
    expect(fake.engine).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('saves only planned pairs, reports groups separately and rejects reruns before paid work', async () => {
    expect(await invoke(['run', '--suite', 'research', '--yes', '--run-id', runId])).toBe(1);
    expect(fake.run).toHaveBeenCalledTimes(31);
    const pairs = fake.run.mock.calls.map(([s, c]) => `${s.id}/${c.id}`);
    expect(new Set(pairs).size).toBe(31);
    const dir = join('evals/results', runId);
    const plan = parse(await readFile(join(dir, 'PLAN.yaml'), 'utf8'));
    expect(plan.groups.map((g: { id: string }) => g.id)).toEqual(['controls', 'core', 'stress']);
    expect(await invoke(['report', '--run', runId])).toBe(0);
    const report = await readFile(join(dir, 'REPORT.md'), 'utf8');
    expect(report).toContain('| controls | 1 / 1 |');
    expect(report).toContain('| core | 25 / 25 |');
    expect(report).toContain('| stress | 5 / 5 |');
    expect(report).toContain('no pooled engine score');
    expect(report).toContain('Offline fixture: deliberately stopped');
    const runtimeCount = fake.engine.mock.calls.length;
    expect(await invoke(['run', '--suite', 'research', '--yes', '--run-id', runId])).toBe(1);
    expect(fake.run).toHaveBeenCalledTimes(31);
    expect(fake.engine).toHaveBeenCalledTimes(runtimeCount);

    await rm(join(dir, 'stress'), { recursive: true });
    expect(await invoke(['report', '--run', runId])).toBe(0);
    const incomplete = await readFile(join(dir, 'REPORT.md'), 'utf8');
    expect(incomplete).toContain('| stress | 0 / 5 | Incomplete |');
    expect(incomplete).toContain('recall-under-noise.xmemory.1.json');
    expect(incomplete).toContain('No planned results are available.');
  });
});
