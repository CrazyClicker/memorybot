import { describe, expect, it } from 'vitest';

import { CliError, COMMON_OPTIONS, helpText, LIVE_COMMANDS, parseLiveCli } from './args.ts';

describe('pnpm live grammar', () => {
  it('lists every command in the general help and the common options in each command help', () => {
    const general = helpText();
    for (const [name, spec] of Object.entries(LIVE_COMMANDS)) {
      expect(general).toContain(`  ${name.padEnd(8)} ${spec.summary}`);
      const own = helpText(name as keyof typeof LIVE_COMMANDS);
      expect(own).toContain(spec.usage);
      for (const flag of Object.keys(COMMON_OPTIONS)) expect(own).toContain(`--${flag}`);
    }
    expect(parseLiveCli([])).toEqual({ kind: 'help', text: general });
    expect(parseLiveCli(['coach', '12', 'text', '--help'])).toEqual({ kind: 'help', text: helpText('coach') });
  });

  it('parses coach with the issue, the flag anywhere and the note words as positionals', () => {
    expect(parseLiveCli(['coach', '12', '--product', 'Карты', 'не', 'проходят'])).toEqual({
      kind: 'command',
      name: 'coach',
      values: { product: true },
      positionals: ['12', 'Карты', 'не', 'проходят'],
    });
    expect(parseLiveCli(['clock'])).toMatchObject({ name: 'clock', positionals: [] });
    expect(parseLiveCli(['memory', '--customer', 'lavanda', '--json', '--fake', '--fixture', 'f.yaml'])).toMatchObject({
      name: 'memory',
      values: { customer: 'lavanda', json: true, fake: true, fixture: 'f.yaml' },
    });
  });

  it('rejects a coach without text, stray positionals, unknown flags and unknown commands', () => {
    expect(() => parseLiveCli(['coach', '12'])).toThrow(/coach takes at least 2 argument\(s\), got 1/);
    expect(() => parseLiveCli(['status', 'extra'])).toThrow(CliError);
    expect(() => parseLiveCli(['clock', 'a', 'b'])).toThrow(/clock takes 0 to 1 argument\(s\), got 2/);
    expect(() => parseLiveCli(['once', '--nope'])).toThrow(/Unknown option/);
    expect(() => parseLiveCli(['nope'])).toThrow(/Unknown command "nope"/);
  });
});
