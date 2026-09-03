/**
 * CLI surface for `pnpm eval`. Parsing lives here, separate from the dispatcher, so the
 * command grammar can be unit-tested without running a command.
 */
import { parseArgs } from 'node:util';

export type CommandName = 'validate' | 'run' | 'report' | 'lint-wiki';

interface OptionSpec {
  readonly type: 'string' | 'boolean';
  readonly short?: string;
  readonly multiple?: boolean;
  readonly help: string;
}

export interface CommandSpec {
  readonly summary: string;
  readonly usage: string;
  readonly options: Readonly<Record<string, OptionSpec>>;
  /** The ROADMAP task that implements this command, quoted when it is still a stub. */
  readonly task: string;
}

export const COMMANDS: Readonly<Record<CommandName, CommandSpec>> = {
  validate: {
    summary: 'Check scenarios and configs against the schema.',
    usage: 'pnpm eval validate [--scenario <path>] [--config <path>]',
    options: {
      scenario: { type: 'string', multiple: true, help: 'Scenario file; repeatable.' },
      config: { type: 'string', multiple: true, help: 'Config file; repeatable. With neither flag, every file in evals/scenarios and evals/configs is checked.' },
    },
    task: 'T2.1',
  },
  run: {
    summary: 'Run scenarios against configs and write result JSON.',
    usage: 'pnpm eval run (--scenario <path> --config <path> | --all) [--repeat N] [--yes]',
    options: {
      scenario: { type: 'string', multiple: true, help: 'Scenario file; repeatable.' },
      config: { type: 'string', multiple: true, help: 'Config file; repeatable.' },
      all: { type: 'boolean', help: 'Every scenario against every config.' },
      repeat: { type: 'string', help: 'Repeats per scenario-config pair (default 1).' },
      yes: { type: 'boolean', short: 'y', help: 'Skip the cost confirmation prompt.' },
      'run-id': { type: 'string', help: 'Name of the results directory (default: a timestamp).' },
    },
    task: 'T2.5',
  },
  report: {
    summary: 'Aggregate a results directory into evals/results/REPORT.md.',
    usage: 'pnpm eval report [--run <run-id>]',
    options: {
      run: { type: 'string', help: 'Run id under evals/results (default: the newest).' },
    },
    task: 'T2.7',
  },
  'lint-wiki': {
    summary: 'Wiki leak lint: every `uses:` check must fail with engine `none`.',
    usage: 'pnpm eval lint-wiki [--scenario <path>]',
    options: {
      scenario: { type: 'string', multiple: true, help: 'Scenario file; repeatable. Default: all.' },
    },
    task: 'T1.6',
  },
};

export class CliError extends Error {}

export type ParsedCli =
  | { kind: 'help'; text: string }
  | { kind: 'command'; name: CommandName; values: Record<string, unknown> };

function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(COMMANDS, value);
}

export function helpText(name?: CommandName): string {
  if (name) {
    const spec = COMMANDS[name];
    const options = Object.entries(spec.options)
      .map(([flag, o]) => `  --${flag}${o.type === 'string' ? ' <value>' : ''}\n      ${o.help}`)
      .join('\n');
    return `${spec.summary}\n\n${spec.usage}\n\nOptions:\n${options}`;
  }
  const list = (Object.keys(COMMANDS) as CommandName[])
    .map((c) => `  ${c.padEnd(11)} ${COMMANDS[c].summary}`)
    .join('\n');
  return `Memory evals for the «Прилавок» support agent.\n\nUsage: pnpm eval <command> [options]\n\nCommands:\n${list}\n\nRun \`pnpm eval <command> --help\` for a command's options.`;
}

export function parseCli(argv: readonly string[]): ParsedCli {
  const [first, ...rest] = argv;

  if (first === undefined || first === '--help' || first === '-h') {
    return { kind: 'help', text: helpText() };
  }
  if (!isCommandName(first)) {
    throw new CliError(`Unknown command "${first}".\n\n${helpText()}`);
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    return { kind: 'help', text: helpText(first) };
  }

  const spec = COMMANDS[first];
  let parsed;
  try {
    parsed = parseArgs({ args: [...rest], options: spec.options, allowPositionals: false, strict: true });
  } catch (error) {
    throw new CliError(`${(error as Error).message}\n\n${helpText(first)}`);
  }
  return { kind: 'command', name: first, values: parsed.values };
}
