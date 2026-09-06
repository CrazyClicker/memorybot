/**
 * Documentation proposals (ROADMAP §6, T4.5): the pure parts of turning a memory item the
 * engine flagged as a documentation candidate into a pull request that appends one dated
 * section to one wiki page, plus the small structured call that picks that page. The loop
 * (`loop.ts`) sequences them; the body is rendered in `render.ts`.
 *
 * Decisions:
 * - The text is `Wiki.update`'s by construction (`wikiUpdateSection`): what a human merges is
 *   what a `wiki_update` step would have produced. The statement goes in verbatim, «По
 *   состоянию на …» prefix included (dated statements, principle 5), and the date in the
 *   heading is the session clock, never the wall clock.
 * - The file committed on the branch is the raw page from `main`, so frontmatter and any human
 *   edit made since the loop last read the wiki survive the proposal.
 * - The chooser sees the page index and the statement only, and answers with a slug, one line
 *   of «почему» and a pull-request title. Its instructions name no scenario objects, the same
 *   rule the extractor follows, so a scenario the model never saw stays a valid check.
 * - The branch carries the item id (`wiki/proposal-<id>`) and the body carries a marker with
 *   the item id and the page: after a crash between `createPullRequest` and the state write,
 *   the loop finds the pull request by its branch and adopts it instead of opening a second.
 * - The `wiki/README.md` leak grep runs on the addition and lands in the body as a warning. It
 *   never blocks: a fact moving from memory into documentation is expected to match, and that
 *   list is what a human updates after merging.
 */
import { readFile } from 'node:fs/promises';

import { generateText, type LanguageModel, NoObjectGeneratedError, Output } from 'ai';
import { z } from 'zod';

import type { MemoryItem, ModelSpec } from '../evals/schema.ts';
import { costUsd as calculateCostUsd, resolveModel, type TokenUsage, tokenUsage } from '../llm/index.ts';
import { parseWikiPage, type Wiki, wikiUpdateSection } from '../wiki/index.ts';
import { WIKI_DIR } from './github.ts';

/** Head branch of every proposal pull request; the loop lists them by this prefix. */
export const PROPOSAL_BRANCH_PREFIX = 'wiki/proposal-';
export const DEFAULT_LEAK_README = `${WIKI_DIR}/README.md`;
/** Longer than this and the model ignored the instruction; the page title is used instead. */
export const MAX_PROPOSAL_TITLE = 80;

// ---------------------------------------------------------------------------------------------
// Branch, file and marker
// ---------------------------------------------------------------------------------------------

/** Ids are `notes-N` or `agent-issue-N-turn-N-N` today; the sanitising is a guard, not a transform. */
export function proposalBranch(itemId: string): string {
  const safe = itemId.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  if (safe === '') throw new Error(`Memory item id "${itemId}" has no characters a branch name can use`);
  return `${PROPOSAL_BRANCH_PREFIX}${safe}`;
}

export function proposalFilePath(slug: string): string {
  return `${WIKI_DIR}/${slug}.md`;
}

/** The page as it is on `main`, by path first and by frontmatter slug second. */
export function findWikiFile<T extends { readonly path: string; readonly content: string }>(
  files: readonly T[],
  slug: string,
): T | undefined {
  const path = proposalFilePath(slug);
  return files.find((file) => file.path === path) ?? files.find((file) => slugOf(file.content) === slug);
}

function slugOf(content: string): string | undefined {
  try {
    return parseWikiPage(content).slug;
  } catch {
    return undefined;
  }
}

/**
 * The raw file plus the section `Wiki.update` would append. `trimEnd` and the final newline
 * keep the file exactly as a hand-written page: frontmatter, body, one blank line, section.
 */
export function appendWikiUpdate(file: string, statement: string, at: string): string {
  return `${file.trimEnd()}\n\n${wikiUpdateSection(statement, at)}\n`;
}

const MARKER = /<!--\s*proposal:\s*item=(\S+)\s+page=(\S+?)\s*-->/;

/** Invisible on GitHub; the item id and page survive a crash before the state row is written. */
export function proposalMarker(itemId: string, page: string): string {
  return `<!-- proposal: item=${itemId} page=${page} -->`;
}

export function parseProposalMarker(body: string): { itemId: string; page: string } | undefined {
  const match = MARKER.exec(body);
  return match?.[1] === undefined || match[2] === undefined ? undefined : { itemId: match[1], page: match[2] };
}

// ---------------------------------------------------------------------------------------------
// The wiki/README.md leak grep
// ---------------------------------------------------------------------------------------------

/** The manual-check `grep -rniE '…' wiki/*.md` block of `wiki/README.md`; `-i` is why `gi`. */
export function parseLeakPattern(readme: string): RegExp | undefined {
  const match = /grep\b[^\n']*'([^']+)'/.exec(readme);
  if (match?.[1] === undefined) return undefined;
  try {
    return new RegExp(match[1], 'gi');
  } catch {
    return undefined;
  }
}

export async function loadLeakPattern(path: string = DEFAULT_LEAK_README): Promise<RegExp | undefined> {
  return parseLeakPattern(await readFile(path, 'utf8'));
}

export interface LeakFindings {
  /** Distinct terms of the README grep list found in the addition, first spelling kept. */
  readonly terms: string[];
  /** Configured merchant names or form values found in it; those must go before merging. */
  readonly merchants: string[];
}

/**
 * Runs on the addition only — that is the diff. Merchant names are checked separately from the
 * grep list: the engine anonymises product notes, so one here means the anonymising failed.
 */
export function leakMatches(
  text: string,
  pattern: RegExp | undefined,
  merchants: readonly string[] = [],
): LeakFindings {
  const terms = new Map<string, string>();
  if (pattern !== undefined) {
    const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of text.matchAll(global)) {
      const term = match[0];
      const key = term.toLocaleLowerCase('ru');
      if (term !== '' && !terms.has(key)) terms.set(key, term);
    }
  }
  const haystack = text.toLocaleLowerCase('ru');
  const found = new Map<string, string>();
  for (const merchant of merchants) {
    const name = merchant.trim();
    if (name !== '' && haystack.includes(name.toLocaleLowerCase('ru'))) found.set(name.toLocaleLowerCase('ru'), name);
  }
  return { terms: [...terms.values()], merchants: [...found.values()] };
}

// ---------------------------------------------------------------------------------------------
// Choosing the page
// ---------------------------------------------------------------------------------------------

export interface PageChoice {
  readonly slug: string;
  /** One line, Russian: why this page and not another. Goes into the pull-request body. */
  readonly why: string;
  /** Pull-request title without the `wiki: ` prefix; absent when the model gave none usable. */
  readonly title?: string;
  readonly usage: TokenUsage;
  readonly costUsd?: number;
}

export type PageChooser = (wiki: Wiki, item: MemoryItem) => Promise<PageChoice>;

export interface PageChooserOptions {
  readonly modelSpec: ModelSpec;
  /** Direct injection keeps unit tests offline. */
  readonly model?: LanguageModel;
}

/**
 * General instructions on purpose: nothing here names a scenario's objects, so a fact the model
 * never saw stays a valid check of the choice (the extractor follows the same rule).
 */
export const PAGE_CHOICE_INSTRUCTIONS = [
  'You maintain a Russian help-center wiki. A support agent learned a product fact that the',
  'documentation does not state, and it will be appended as one dated section to exactly one',
  'existing page. Choose the page whose subject already covers that fact, so a reader looking',
  'for this behaviour finds it where they would look for the rest of the topic. Prefer the page',
  'whose own rules the fact qualifies over a page that merely mentions the same words.',
  'Answer with: slug — the slug of an existing page, copied exactly; why — one sentence in',
  'Russian naming the page subject and the connection, for a human reviewing the pull request;',
  'title — a pull-request headline in Russian, at most 60 characters, naming the fact rather',
  'than the page, with no prefix.',
  'Never invent a page and never name a merchant, a person or merchant-specific software.',
].join(' ');

export function createPageChooser(options: PageChooserOptions): PageChooser {
  const model = options.model ?? resolveModel(options.modelSpec);
  return async (wiki, item) => {
    const slugs = wiki.pages.map((page) => page.slug);
    const [first, ...rest] = slugs;
    if (first === undefined) throw new Error('The wiki has no pages to propose an update to');

    const call = async (): Promise<PageChoice> => {
      const result = await generateText({
        model,
        ...(options.modelSpec.temperature === undefined ? {} : { temperature: options.modelSpec.temperature }),
        instructions: PAGE_CHOICE_INSTRUCTIONS,
        prompt: pageChoicePrompt(wiki, item),
        output: Output.object({
          schema: z.strictObject({
            slug: z.enum([first, ...rest]),
            why: z.string(),
            title: z.string(),
          }),
        }),
      });
      const usage = tokenUsage(result.usage);
      const costUsd = calculateCostUsd(options.modelSpec, usage);
      const title = proposalTitle(result.output.title);
      return {
        slug: result.output.slug,
        why: result.output.why.trim(),
        ...(title === undefined ? {} : { title }),
        usage,
        ...(costUsd === undefined ? {} : { costUsd }),
      };
    };
    try {
      return await call();
    } catch (error) {
      // Same as the extractor: a malformed object is a flake of a stochastic model, not a verdict.
      if (!NoObjectGeneratedError.isInstance(error)) throw error;
      return await call();
    }
  };
}

function proposalTitle(raw: string): string | undefined {
  const title = raw.trim().replace(/^wiki\s*:\s*/i, '').trim();
  return title === '' || title.length > MAX_PROPOSAL_TITLE ? undefined : title;
}

function pageChoicePrompt(wiki: Wiki, item: MemoryItem): string {
  return [
    wiki.indexText,
    '',
    'Факт, который надо задокументировать:',
    `- kind=${item.kind}${item.validUntil === undefined ? '' : `; действует до ${item.validUntil}`}`,
    `- ${item.statement}`,
  ].join('\n');
}
