import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { Wiki, type WikiOptions, type WikiPage } from './wiki.ts';

export const DEFAULT_WIKI_DIR = 'wiki';

export interface LoadWikiOptions extends WikiOptions {
  readonly directory?: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(data: Record<string, unknown>, field: string, path: string): string {
  const value = data[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path}: frontmatter field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

export function parseWikiPage(markdown: string, path = '<wiki page>'): WikiPage {
  const match = FRONTMATTER.exec(markdown);
  if (match === null) throw new Error(`${path}: expected YAML frontmatter at the start of the file`);

  let raw: unknown;
  try {
    raw = parseYaml(match[1] ?? '');
  } catch (error) {
    throw new Error(`${path}: invalid YAML frontmatter: ${(error as Error).message}`, { cause: error });
  }
  if (!isRecord(raw)) throw new Error(`${path}: frontmatter must be a YAML mapping`);

  const slug = requiredString(raw, 'slug', path);
  if (!SLUG.test(slug)) {
    throw new Error(`${path}: slug "${slug}" must use lowercase letters, digits, "-" or "_"`);
  }

  return {
    slug,
    title: requiredString(raw, 'title', path),
    summary: requiredString(raw, 'summary', path),
    content: markdown.slice(match[0].length).trim(),
  };
}

/** Read a fresh wiki snapshot. README.md is documentation, not an agent-readable page. */
export async function loadWiki(options: LoadWikiOptions | string = {}): Promise<Wiki> {
  const normalized = typeof options === 'string' ? { directory: options } : options;
  const directory = normalized.directory ?? DEFAULT_WIKI_DIR;
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md')
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const pages: WikiPage[] = [];
  const filesBySlug = new Map<string, string>();
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const page = parseWikiPage(await readFile(path, 'utf8'), path);
    const previous = filesBySlug.get(page.slug);
    if (previous !== undefined) {
      throw new Error(`${path}: duplicate wiki slug "${page.slug}" (already declared in ${previous})`);
    }
    filesBySlug.set(page.slug, basename(path));
    pages.push(page);
  }

  return new Wiki(pages, { search: normalized.search });
}
