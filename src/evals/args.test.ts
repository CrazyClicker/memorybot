import { describe, expect, it } from 'vitest';

import { cachedRepeatsProblem, CliError, parseCli } from './args.ts';

describe('parseCli', () => {
  it('prints top-level help with no arguments', () => {
    const parsed = parseCli([]);
    expect(parsed.kind).toBe('help');
    expect(parsed.kind === 'help' && parsed.text).toContain('lint-wiki');
  });

  it('prints command help for --help after a command', () => {
    const parsed = parseCli(['run', '--help']);
    expect(parsed).toMatchObject({ kind: 'help' });
    expect(parsed.kind === 'help' && parsed.text).toContain('--repeat');
  });

  it('parses repeatable and boolean options', () => {
    const parsed = parseCli([
      'run',
      '--scenario',
      'evals/scenarios/a.yaml',
      '--scenario',
      'evals/scenarios/b.yaml',
      '--config',
      'evals/configs/none.yaml',
      '--repeat',
      '3',
      '--yes',
    ]);
    expect(parsed).toEqual({
      kind: 'command',
      name: 'run',
      values: {
        scenario: ['evals/scenarios/a.yaml', 'evals/scenarios/b.yaml'],
        config: ['evals/configs/none.yaml'],
        repeat: '3',
        yes: true,
      },
    });
  });

  it('rejects an unknown command', () => {
    expect(() => parseCli(['runn'])).toThrow(CliError);
  });

  it('rejects an unknown option', () => {
    expect(() => parseCli(['report', '--nope'])).toThrow(CliError);
  });

  it('rejects a positional argument', () => {
    expect(() => parseCli(['lint-wiki', 'evals/scenarios/a.yaml'])).toThrow(CliError);
  });

  it('parses the cached-repeats override', () => {
    const parsed = parseCli(['run', '--all', '--repeat', '2', '--allow-cached-repeats']);
    expect(parsed).toMatchObject({ kind: 'command', values: { 'allow-cached-repeats': true } });
  });
});

describe('cachedRepeatsProblem', () => {
  it('refuses repeats that would replay the cache', () => {
    expect(cachedRepeatsProblem({ cached: true, repeat: 3, allowed: false })).toContain(
      'grade one sample 3 times',
    );
  });

  it('allows a single repeat, a cold cache, or an explicit opt-in', () => {
    expect(cachedRepeatsProblem({ cached: true, repeat: 1, allowed: false })).toBeUndefined();
    expect(cachedRepeatsProblem({ cached: false, repeat: 3, allowed: false })).toBeUndefined();
    expect(cachedRepeatsProblem({ cached: true, repeat: 3, allowed: true })).toBeUndefined();
  });
});
