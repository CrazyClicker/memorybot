#!/usr/bin/env tsx
/**
 * `pnpm eval <command>`. A command is a stub until the ROADMAP task that owns it lands; a
 * stub exits 2 and names the task, so a missing feature never looks like a passing run.
 */
import 'dotenv/config';

import { CliError, type CommandName, COMMANDS, parseCli } from './args.ts';
import { CONFIGS_DIR, listYamlFiles, type LoadedFile, SCENARIOS_DIR, validateFiles } from './load.ts';
import { hasErrors } from './validate.ts';

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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function printFile(file: LoadedFile<unknown>): void {
  process.stdout.write(`${hasErrors(file.issues) ? 'FAIL' : 'ok  '}  ${file.path}\n`);
  for (const issue of file.issues) {
    const where = issue.path === '' ? '' : `${issue.path}: `;
    process.stdout.write(`      ${issue.severity.padEnd(8)} ${where}${issue.message}\n`);
  }
}

/** T2.1. Exit 1 when any file has an error; warnings are printed and do not fail. */
const validate: Command = async (values) => {
  const scenarioArgs = stringList(values['scenario']);
  const configArgs = stringList(values['config']);
  const explicit = scenarioArgs.length > 0 || configArgs.length > 0;

  const files = await validateFiles({
    scenarios: explicit ? scenarioArgs : await listYamlFiles(SCENARIOS_DIR),
    configs: explicit ? configArgs : await listYamlFiles(CONFIGS_DIR),
  });
  const all = [...files.scenarios, ...files.configs];
  if (all.length === 0) {
    process.stderr.write('Nothing to validate.\n');
    process.exitCode = EXIT_USAGE;
    return;
  }

  let failed = 0;
  let warnings = 0;
  for (const file of all) {
    printFile(file);
    if (hasErrors(file.issues)) failed += 1;
    warnings += file.issues.filter((issue) => issue.severity === 'warning').length;
  }
  process.stdout.write(
    `\n${plural(all.length, 'file')} checked: ${all.length - failed} ok, ${failed} with errors, ${plural(warnings, 'warning')}.\n`,
  );
  process.exitCode = failed > 0 ? 1 : 0;
};

const HANDLERS: Record<CommandName, Command> = {
  validate,
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
