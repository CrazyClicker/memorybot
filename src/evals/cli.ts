#!/usr/bin/env tsx
/**
 * `pnpm eval <command>`. Every command is a stub until the ROADMAP task that owns it lands;
 * a stub exits 2 and names the task, so a missing feature never looks like a passing run.
 */
import 'dotenv/config';

import { CliError, type CommandName, COMMANDS, parseCli } from './args.ts';

const EXIT_USAGE = 1;
const EXIT_NOT_IMPLEMENTED = 2;

type Command = (values: Record<string, unknown>) => Promise<void>;

const notImplemented =
  (name: CommandName): Command =>
  async () => {
    const { task, summary } = COMMANDS[name];
    process.stderr.write(
      `\`pnpm eval ${name}\` is not implemented yet.\n` +
        `  what it will do: ${summary}\n` +
        `  implemented by:  ROADMAP ${task}\n`,
    );
    process.exitCode = EXIT_NOT_IMPLEMENTED;
  };

const HANDLERS: Record<CommandName, Command> = {
  validate: notImplemented('validate'),
  run: notImplemented('run'),
  report: notImplemented('report'),
  'lint-wiki': notImplemented('lint-wiki'),
};

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    throw error;
  }

  if (parsed.kind === 'help') {
    process.stdout.write(`${parsed.text}\n`);
    return;
  }
  await HANDLERS[parsed.name](parsed.values);
}

await main();
