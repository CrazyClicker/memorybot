/**
 * File IO for scenarios, configs and the wiki page list: read YAML, parse, validate, and
 * report every problem per file. The CLI prints what this returns; the runner (T2.5) loads
 * through the same functions so a file that validates is a file that runs.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { parse as parseYaml, YAMLParseError } from 'yaml';

import { loadWiki } from '../wiki/index.ts';
import type { Config, Scenario } from './schema.ts';
import { type Issue, parseConfig, parseScenario } from './validate.ts';

export const SCENARIOS_DIR = 'evals/scenarios';
export const CONFIGS_DIR = 'evals/configs';
export const WIKI_DIR = 'wiki';

export interface LoadedFile<T> {
  readonly path: string;
  /** Present when the shape is valid, even if semantic errors were found. */
  readonly value?: T;
  readonly issues: readonly Issue[];
}

export function fileStem(path: string): string {
  return basename(path, extname(path));
}

/** `*.yaml` and `*.yml` in a directory, sorted, as paths relative to the cwd. */
export async function listYamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => join(dir, name));
}

interface ReadYaml {
  readonly raw?: unknown;
  readonly issues: readonly Issue[];
}

async function readYaml(path: string): Promise<ReadYaml> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { issues: [{ severity: 'error', path: '', message: `cannot read file: ${(error as Error).message}` }] };
  }
  try {
    return { raw: parseYaml(text), issues: [] };
  } catch (error) {
    const line = error instanceof YAMLParseError ? error.linePos?.[0]?.line : undefined;
    const where = line === undefined ? '' : ` at line ${line}`;
    const summary = (error as Error).message.split('\n')[0] ?? 'unknown error';
    return { issues: [{ severity: 'error', path: '', message: `YAML syntax${where}: ${summary}` }] };
  }
}

export interface LoadOptions {
  /** Wiki page slugs `wiki_update.page` may name. Undefined skips that check. */
  readonly wikiSlugs?: ReadonlySet<string>;
}

export async function loadScenario(path: string, options: LoadOptions = {}): Promise<LoadedFile<Scenario>> {
  const read = await readYaml(path);
  if (read.issues.length > 0) return { path, issues: read.issues };
  const parsed = parseScenario(read.raw, { wikiSlugs: options.wikiSlugs, fileStem: fileStem(path) });
  return { path, value: parsed.value, issues: parsed.issues };
}

export async function loadConfig(path: string): Promise<LoadedFile<Config>> {
  const read = await readYaml(path);
  if (read.issues.length > 0) return { path, issues: read.issues };
  const parsed = parseConfig(read.raw, { fileStem: fileStem(path) });
  return { path, value: parsed.value, issues: parsed.issues };
}

/**
 * Slugs of the canonical wiki page index. Keeping validation on the same loader as the agent
 * prevents malformed or duplicate pages from being accepted here and failing at runtime.
 */
export async function wikiSlugs(dir: string = WIKI_DIR): Promise<Set<string>> {
  return new Set((await loadWiki(dir)).slugs);
}

export interface ValidateFilesOptions {
  readonly scenarios: readonly string[];
  readonly configs: readonly string[];
  readonly wikiDir?: string;
}

export interface ValidatedFiles {
  readonly scenarios: readonly LoadedFile<Scenario>[];
  readonly configs: readonly LoadedFile<Config>[];
}

/** Load and validate every listed file; the wiki page list is read once for all scenarios. */
export async function validateFiles(options: ValidateFilesOptions): Promise<ValidatedFiles> {
  const slugs = options.scenarios.length > 0 ? await wikiSlugs(options.wikiDir) : undefined;
  const scenarios = await Promise.all(
    options.scenarios.map((path) => loadScenario(path, { wikiSlugs: slugs })),
  );
  const configs = await Promise.all(options.configs.map((path) => loadConfig(path)));
  return { scenarios, configs };
}
