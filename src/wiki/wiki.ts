import MiniSearch from 'minisearch';

export interface WikiPage {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  /** Markdown body without frontmatter. */
  readonly content: string;
}

export interface WikiSearchResult {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly score: number;
}

export interface WikiOptions {
  /** Build and expose full-text search. `read_page` does not require it. */
  readonly search?: boolean;
}

interface SearchDocument {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
}

export class WikiPageNotFoundError extends Error {
  constructor(
    readonly slug: string,
    readonly availableSlugs: readonly string[],
  ) {
    super(`Unknown wiki page "${slug}". Available pages: ${availableSlugs.join(', ') || '(none)'}`);
    this.name = 'WikiPageNotFoundError';
  }
}

/**
 * One isolated, mutable wiki snapshot. Loading it once per eval run keeps `wiki_update`
 * changes out of both the repository and other runs.
 */
export class Wiki {
  readonly searchEnabled: boolean;

  private readonly pageMap: Map<string, WikiPage>;
  private readonly searchIndex?: MiniSearch<SearchDocument>;

  constructor(pages: readonly WikiPage[], options: WikiOptions = {}) {
    this.pageMap = new Map(pages.map((page) => [page.slug, { ...page }]));
    this.searchEnabled = options.search ?? false;

    if (this.searchEnabled) {
      this.searchIndex = new MiniSearch<SearchDocument>({
        fields: ['title', 'summary', 'content'],
        storeFields: ['slug', 'title', 'summary'],
        searchOptions: {
          boost: { title: 3, summary: 2 },
          prefix: true,
        },
      });
      this.searchIndex.addAll([...this.pageMap.values()].map(searchDocument));
    }
  }

  /** Metadata sorted by slug, safe to put into prompts and UIs. */
  get pages(): readonly WikiPage[] {
    return [...this.pageMap.values()].sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
  }

  get slugs(): ReadonlySet<string> {
    return new Set(this.pageMap.keys());
  }

  /** Compact page catalogue for the agent's system prompt. */
  get indexText(): string {
    if (this.pageMap.size === 0) return 'В базе знаний нет страниц.';
    return [
      'Страницы базы знаний:',
      ...this.pages.map((page) => `- ${page.slug} — ${page.title}: ${page.summary}`),
    ].join('\n');
  }

  hasPage(slug: string): boolean {
    return this.pageMap.has(slug);
  }

  /** Returns a complete page for `read_page`, without implementation-only frontmatter. */
  readPage(slug: string): string {
    const page = this.requirePage(slug);
    return [`# ${page.title}`, page.content].filter((part) => part !== '').join('\n\n');
  }

  /**
   * Append a human-approved, dated section to this snapshot and refresh its search entry.
   * `at` is the scenario clock, not wall-clock time.
   */
  update(slug: string, text: string, at: string): WikiPage {
    const page = this.requirePage(slug);
    const addition = text.trim();
    if (addition === '') throw new Error('Wiki update text must not be empty');

    const date = scenarioDate(at);
    const section = `## Обновление от ${date}\n\n${addition}`;
    const updated: WikiPage = {
      ...page,
      content: [page.content.trimEnd(), section].filter((part) => part !== '').join('\n\n'),
    };
    this.pageMap.set(slug, updated);

    if (this.searchIndex !== undefined) {
      this.searchIndex.replace(searchDocument(updated));
    }
    return { ...updated };
  }

  search(query: string, limit = 5): WikiSearchResult[] {
    if (this.searchIndex === undefined) {
      throw new Error('Wiki search is disabled; load the wiki with { search: true }');
    }
    const normalized = query.trim();
    if (normalized === '' || limit <= 0) return [];

    return this.searchIndex.search(normalized).slice(0, Math.floor(limit)).map((result) => ({
      slug: String(result['slug'] ?? result.id),
      title: String(result['title'] ?? ''),
      summary: String(result['summary'] ?? ''),
      score: result.score,
    }));
  }

  private requirePage(slug: string): WikiPage {
    const page = this.pageMap.get(slug);
    if (page === undefined) throw new WikiPageNotFoundError(slug, [...this.slugs].sort());
    return page;
  }
}

function searchDocument(page: WikiPage): SearchDocument {
  return { id: page.slug, ...page };
}

function scenarioDate(at: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(at);
  if (match?.[1] === undefined || !Number.isFinite(Date.parse(at))) {
    throw new Error(`Wiki update date must be an ISO date or timestamp, got "${at}"`);
  }
  return match[1];
}
