import { describe, expect, it } from 'vitest';

import { CliError, parseCli } from './args.ts';

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
});
