import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { Wiki } from './wiki.ts';

export function createReadPageTool(wiki: Wiki) {
  return tool({
    description: 'Прочитать страницу базы знаний по её slug из доступного индекса.',
    inputSchema: z.strictObject({
      slug: z.string().min(1).describe('Slug страницы из индекса базы знаний'),
    }),
    execute: async ({ slug }) => wiki.readPage(slug),
  });
}

export function createSearchWikiTool(wiki: Wiki) {
  return tool({
    description: 'Найти релевантные страницы базы знаний по текстовому запросу.',
    inputSchema: z.strictObject({
      query: z.string().min(1).describe('Поисковый запрос'),
    }),
    execute: async ({ query }) => wiki.search(query),
  });
}

export interface WikiToolOptions {
  /** Defaults to the flag used by `loadWiki({ search })`. */
  readonly search?: boolean;
}

/** Tool names are the object keys, per AI SDK 7. */
export function createWikiTools(wiki: Wiki, options: WikiToolOptions = {}): ToolSet {
  const enableSearch = options.search ?? wiki.searchEnabled;
  if (enableSearch && !wiki.searchEnabled) {
    throw new Error('Cannot expose search_wiki: this wiki was loaded without { search: true }');
  }
  return enableSearch
    ? { read_page: createReadPageTool(wiki), search_wiki: createSearchWikiTool(wiki) }
    : { read_page: createReadPageTool(wiki) };
}
