/**
 * CLI surface for `pnpm live` (ROADMAP §6, T4.6). Parsing lives here, separate from the
 * commands, so the grammar can be unit-tested without opening a session or a client.
 */
import { parseArgs } from 'node:util';

export type LiveCommandName = 'run' | 'once' | 'status' | 'memory' | 'coach' | 'clock' | 'reset';

interface OptionSpec {
  readonly type: 'string' | 'boolean';
  readonly help: string;
}

interface PositionalSpec {
  readonly min: number;
  /** Absent: any number, e.g. the words of a coach note. */
  readonly max?: number;
}

export interface LiveCommandSpec {
  readonly summary: string;
  readonly usage: string;
  readonly options: Readonly<Record<string, OptionSpec>>;
  readonly positionals?: PositionalSpec;
}

/** Accepted by every command. */
export const COMMON_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  config: {
    type: 'string',
    help: 'Live config file (default live/config.yaml); the eval config it runs is its `config:` key.',
  },
  fake: {
    type: 'boolean',
    help: 'Replay the recorded fixture onto an in-memory GitHub even when .env holds a bot identity.',
  },
  fixture: { type: 'string', help: 'The recording to replay in the fake mode (default live/fixture.yaml).' },
};

export const LIVE_COMMANDS: Readonly<Record<LiveCommandName, LiveCommandSpec>> = {
  run: {
    summary: 'Poll GitHub until Ctrl-C: the poller log the demo keeps on screen.',
    usage: 'pnpm live run',
    options: {},
  },
  once: {
    summary: 'One poll, then exit (tests, rehearsals).',
    usage: 'pnpm live once [--json]',
    options: { json: { type: 'boolean', help: 'The poll result as JSON on stdout; the log goes to stderr.' } },
  },
  status: {
    summary: 'Threads, proposals, the scenario clock and the cursor, from the local state alone.',
    usage: 'pnpm live status [--json]',
    options: { json: { type: 'boolean', help: 'Machine-readable output.' } },
  },
  memory: {
    summary: 'Dump the notes the agent holds.',
    usage: 'pnpm live memory [--customer <id>] [--json]',
    options: {
      customer: {
        type: 'string',
        help: "Only what this merchant's threads can see: their own notes plus the shared ones.",
      },
      json: { type: 'boolean', help: 'Raw memory items as JSON.' },
    },
  },
  coach: {
    summary: 'File a coach note privately (nothing is posted), then consolidate the thread.',
    usage: 'pnpm live coach <issue> [--product] <text…>',
    options: {
      product: {
        type: 'boolean',
        help: 'A product-level note: the memory it produces is shared with every merchant (D7).',
      },
    },
    positionals: { min: 2 },
  },
  clock: {
    summary: 'Show the scenario clock, or move it forward to an ISO timestamp.',
    usage: 'pnpm live clock [<ISO timestamp>]',
    options: {},
    positionals: { min: 0, max: 1 },
  },
  reset: {
    summary: 'Clear the local state and memory; --issues also cleans the repository.',
    usage: 'pnpm live reset [--issues [--yes]]',
    options: {
      issues: {
        type: 'boolean',
        help:
          'Also delete every issue with the support label except the memory issue, close the proposal ' +
          'pull requests and delete their branches, as the repository owner (`gh auth token`).',
      },
      yes: { type: 'boolean', help: 'Execute --issues; without it the plan is printed and nothing changes.' },
    },
  },
};

export class CliError extends Error {}

export type ParsedLiveCli =
  | { readonly kind: 'help'; readonly text: string }
  | {
      readonly kind: 'command';
      readonly name: LiveCommandName;
      readonly values: Record<string, unknown>;
      readonly positionals: string[];
    };

function isCommandName(value: string): value is LiveCommandName {
  return Object.hasOwn(LIVE_COMMANDS, value);
}

function optionLines(options: Readonly<Record<string, OptionSpec>>): string {
  return Object.entries(options)
    .map(([flag, option]) => `  --${flag}${option.type === 'string' ? ' <value>' : ''}\n      ${option.help}`)
    .join('\n');
}

export function helpText(name?: LiveCommandName): string {
  if (name !== undefined) {
    const spec = LIVE_COMMANDS[name];
    const own = Object.keys(spec.options).length === 0 ? '' : `\n\nOptions:\n${optionLines(spec.options)}`;
    return `${spec.summary}\n\n${spec.usage}${own}\n\nCommon options:\n${optionLines(COMMON_OPTIONS)}`;
  }
  const list = (Object.keys(LIVE_COMMANDS) as LiveCommandName[])
    .map((command) => `  ${command.padEnd(8)} ${LIVE_COMMANDS[command].summary}`)
    .join('\n');
  return (
    'Live GitHub Issues loop for the «Прилавок» support agent (ROADMAP §6).\n\n' +
    'Usage: pnpm live <command> [options]\n\n' +
    `Commands:\n${list}\n\n` +
    'With a bot identity in .env (GITHUB_TOKEN or the GITHUB_APP_* variables) the commands act on the\n' +
    'repository in live/config.yaml and keep state in live/state.db and live/memory.db. Without one, or\n' +
    'with --fake, they replay the recorded fixture live/fixture.yaml onto an in-memory GitHub, keep state\n' +
    'in live/fake-*.db and print what the bot would have done.\n\n' +
    'Run `pnpm live <command> --help` for a command\'s options.'
  );
}

export function parseLiveCli(argv: readonly string[]): ParsedLiveCli {
  const [first, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h') return { kind: 'help', text: helpText() };
  if (!isCommandName(first)) throw new CliError(`Unknown command "${first}".\n\n${helpText()}`);
  if (rest.includes('--help') || rest.includes('-h')) return { kind: 'help', text: helpText(first) };

  const spec = LIVE_COMMANDS[first];
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      options: { ...COMMON_OPTIONS, ...spec.options },
      allowPositionals: spec.positionals !== undefined,
      strict: true,
    });
  } catch (error) {
    throw new CliError(`${(error as Error).message}\n\n${helpText(first)}`);
  }
  const positionals = parsed.positionals;
  const wanted = spec.positionals ?? { min: 0, max: 0 };
  if (positionals.length < wanted.min || (wanted.max !== undefined && positionals.length > wanted.max)) {
    const expected = wanted.max === undefined
      ? `at least ${wanted.min}`
      : wanted.min === wanted.max ? `${wanted.min}` : `${wanted.min} to ${wanted.max}`;
    throw new CliError(
      `${first} takes ${expected} argument(s), got ${positionals.length}.\n\n${helpText(first)}`,
    );
  }
  return { kind: 'command', name: first, values: parsed.values, positionals };
}
