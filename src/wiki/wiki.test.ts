import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWikiTools, loadWiki, parseWikiPage, WikiPageNotFoundError } from './index.ts';

const PAGE = `---
slug: test-page
title: Тестовая страница
summary: Как выполнить тестовую операцию.
---

## Инструкция

Подключите интеграцию «Курьерика» и сохраните настройки.
`;

describe('parseWikiPage', () => {
  it('extracts required frontmatter and keeps only the Markdown body', () => {
    expect(parseWikiPage(PAGE, 'test.md')).toEqual({
      slug: 'test-page',
      title: 'Тестовая страница',
      summary: 'Как выполнить тестовую операцию.',
      content: '## Инструкция\n\nПодключите интеграцию «Курьерика» и сохраните настройки.',
    });
  });

  it('rejects missing or malformed metadata', () => {
    expect(() => parseWikiPage('# no frontmatter', 'bad.md')).toThrow(/bad\.md: expected YAML frontmatter/);
    expect(() => parseWikiPage(PAGE.replace('summary: Как выполнить тестовую операцию.\n', ''), 'bad.md')).toThrow(
      /field "summary" must be a non-empty string/,
    );
    expect(() => parseWikiPage(PAGE.replace('test-page', 'Bad Slug'), 'bad.md')).toThrow(/slug "Bad Slug"/);
  });
});

describe('Wiki', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wiki-'));
    await writeFile(join(directory, 'page.md'), PAGE, 'utf8');
    await writeFile(join(directory, 'README.md'), '# Maintainer notes', 'utf8');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('loads pages, skips README, and renders the prompt index and read_page output', async () => {
    const wiki = await loadWiki(directory);
    expect([...wiki.slugs]).toEqual(['test-page']);
    expect(wiki.indexText).toContain('test-page — Тестовая страница: Как выполнить тестовую операцию.');
    expect(wiki.readPage('test-page')).toBe(
      '# Тестовая страница\n\n## Инструкция\n\nПодключите интеграцию «Курьерика» и сохраните настройки.',
    );
    expect(() => wiki.readPage('missing')).toThrow(WikiPageNotFoundError);
  });

  it('keeps updates in one snapshot, dates them with the scenario clock, and preserves source files', async () => {
    const first = await loadWiki(directory);
    const second = await loadWiki(directory);

    first.update('test-page', 'Новый подтверждённый факт.', '2026-09-03T14:30:00Z');
    expect(first.readPage('test-page')).toContain('## Обновление от 2026-09-03\n\nНовый подтверждённый факт.');
    expect(second.readPage('test-page')).not.toContain('Новый подтверждённый факт.');
    expect(await loadWiki(directory).then((wiki) => wiki.readPage('test-page'))).not.toContain('Новый подтверждённый факт.');
  });

  it('indexes page content and rebuilds that entry after an update when search is enabled', async () => {
    const wiki = await loadWiki({ directory, search: true });
    expect(wiki.search('Курьерика')[0]?.slug).toBe('test-page');
    expect(wiki.search('уникальныймаркер')).toEqual([]);

    wiki.update('test-page', 'Уникальныймаркер появился в документации.', '2026-09-03');
    expect(wiki.search('уникальныймаркер')[0]?.slug).toBe('test-page');
  });

  it('exposes search_wiki only behind the explicit flag', async () => {
    const plain = await loadWiki(directory);
    expect(Object.keys(createWikiTools(plain))).toEqual(['read_page']);
    expect(() => plain.search('интеграция')).toThrow(/search is disabled/);

    const searchable = await loadWiki({ directory, search: true });
    expect(Object.keys(createWikiTools(searchable))).toEqual(['read_page', 'search_wiki']);
  });

  it('rejects duplicate slugs', async () => {
    await writeFile(join(directory, 'duplicate.md'), PAGE, 'utf8');
    await expect(loadWiki(directory)).rejects.toThrow(/duplicate wiki slug "test-page"/);
  });
});
