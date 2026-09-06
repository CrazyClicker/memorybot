import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import type { MemoryItem } from '../evals/schema.ts';
import { parseWikiPage, Wiki } from '../wiki/index.ts';
import {
  appendWikiUpdate,
  createPageChooser,
  DEFAULT_LEAK_README,
  findWikiFile,
  leakMatches,
  loadLeakPattern,
  parseLeakPattern,
  parseProposalMarker,
  proposalBranch,
  proposalFilePath,
  proposalMarker,
} from './proposals.ts';

const SPEC = { provider: 'openai', model: 'gpt-4o-mini', temperature: 0 } as const;
type MockGenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const USAGE: MockGenerateResult['usage'] = {
  inputTokens: { total: 1_000, noCache: 800, cacheRead: 200, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

const PAGE_FILE = [
  '---',
  'slug: import-eksport-csv',
  'title: Импорт и экспорт товаров (CSV)',
  'summary: Как загрузить каталог файлом.',
  '---',
  '',
  '## Формат файла',
  '',
  'UTF-8, разделитель определяется по первой строке.',
  '',
].join('\n');

const ITEM: MemoryItem = {
  id: 'notes-4',
  kind: 'undocumented',
  about: 'product',
  learnedFrom: 'dom_i_sad',
  scope: 'shared',
  statement: 'По состоянию на 2026-09-06: BOM в первой ячейке ломает заголовок sku, строка молча исчезает из отчёта.',
  documentationCandidate: true,
  source: { thread: 'issue-7', via: 'consolidate' },
  createdAt: '2026-09-06T10:00:00.000Z',
};

function wiki(): Wiki {
  return new Wiki([
    {
      slug: 'import-eksport-csv',
      title: 'Импорт и экспорт товаров (CSV)',
      summary: 'Как загрузить каталог файлом.',
      content: '## Формат файла\n\nUTF-8, разделитель определяется по первой строке.',
    },
    { slug: 'dostavka', title: 'Доставка и зоны', summary: 'Зоны, сроки и самовывоз.', content: 'Зоны.' },
  ]);
}

function choice(output: unknown): MockGenerateResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------------------------

describe('proposal branches, files and markers', () => {
  it('derives the branch from the item id and sanitises what a ref cannot carry', () => {
    expect(proposalBranch('notes-4')).toBe('wiki/proposal-notes-4');
    expect(proposalBranch('agent-issue-7-turn-7-1')).toBe('wiki/proposal-agent-issue-7-turn-7-1');
    expect(proposalBranch(' заметка про BOM ')).toBe('wiki/proposal-BOM');
    expect(() => proposalBranch('///')).toThrow(/no characters a branch name can use/);
  });

  it('appends exactly what a merged wiki update produces and keeps the frontmatter', () => {
    const updated = appendWikiUpdate(PAGE_FILE, ITEM.statement, '2026-09-06T10:00:00.000Z');

    expect(updated.startsWith('---\nslug: import-eksport-csv\n')).toBe(true);
    expect(updated.endsWith('строка молча исчезает из отчёта.\n')).toBe(true);
    expect(updated).toContain('\n\n## Обновление от 2026-09-06\n\nПо состоянию на 2026-09-06: BOM');
    // The page a reader gets after the merge is the page `Wiki.update` would have produced.
    const merged = wiki().update('import-eksport-csv', ITEM.statement, '2026-09-06T10:00:00.000Z');
    expect(parseWikiPage(updated).content).toBe(merged.content);
  });

  it('finds the page file by path and falls back to the frontmatter slug', () => {
    const files = [
      { path: 'wiki/README.md', content: '# Wiki' },
      { path: 'wiki/import-eksport-csv.md', content: PAGE_FILE },
      { path: 'wiki/renamed.md', content: PAGE_FILE.replace('import-eksport-csv', 'dostavka') },
    ];

    expect(proposalFilePath('dostavka')).toBe('wiki/dostavka.md');
    expect(findWikiFile(files, 'import-eksport-csv')?.path).toBe('wiki/import-eksport-csv.md');
    expect(findWikiFile(files, 'dostavka')?.path).toBe('wiki/renamed.md');
    expect(findWikiFile(files, 'tarify-i-oplata')).toBeUndefined();
  });

  it('round-trips the item id and the page through the invisible body marker', () => {
    const body = `Предложение.\n\n${proposalMarker('notes-4', 'import-eksport-csv')}`;

    expect(parseProposalMarker(body)).toEqual({ itemId: 'notes-4', page: 'import-eksport-csv' });
    expect(parseProposalMarker('Обычное описание без маркера')).toBeUndefined();
  });
});

describe('the wiki/README.md leak grep', () => {
  it('reads the grep list from the repository README and flags what an addition matches', async () => {
    const pattern = await loadLeakPattern();
    expect(pattern).toBeDefined();

    const addition = leakMatches(ITEM.statement, pattern, ['Дом и сад', 'ВелоДвор']);
    expect(addition.terms).toContain('BOM');
    expect(addition.terms).toContain('молча');
    expect(addition.merchants).toEqual([]);

    const leaked = leakMatches('Магазин «Дом и сад» пересохраняет файл.', pattern, ['Дом и сад', 'ВелоДвор']);
    expect(leaked.merchants).toEqual(['Дом и сад']);
    expect(leakMatches('Скидки настраиваются в разделе «Промокоды».', pattern, ['Дом и сад'])).toEqual({
      terms: [],
      merchants: [],
    });
  });

  it('turns the lint off when the README has no grep block, and never repeats a term', () => {
    expect(parseLeakPattern('# Wiki\n\nБез grep-блока.')).toBeUndefined();
    expect(parseLeakPattern("```\ngrep -rniE 'BOM|сентябр' wiki/*.md\n```")?.source).toBe('BOM|сентябр');
    expect(DEFAULT_LEAK_README).toBe('wiki/README.md');

    const pattern = parseLeakPattern("grep -rniE 'BOM|сентябр' wiki/*.md");
    expect(leakMatches('BOM и bom в сентябре и в сентябре', pattern)).toEqual({
      terms: ['BOM', 'сентябр'],
      merchants: [],
    });
    // A non-global pattern from `LoopOptions.leakPattern` is used without touching its state.
    expect(leakMatches('BOM ломает заголовок', /BOM/i).terms).toEqual(['BOM']);
  });
});

describe('createPageChooser', () => {
  it('asks the model for one page, its reason and a title, and prices the call', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [choice({
        slug: 'import-eksport-csv',
        why: 'Страница про импорт CSV: правило касается распознавания заголовка при загрузке.',
        title: 'wiki: BOM ломает заголовок sku',
      })],
    });

    const chosen = await createPageChooser({ modelSpec: SPEC, model })(wiki(), ITEM);

    expect(chosen).toEqual({
      slug: 'import-eksport-csv',
      why: 'Страница про импорт CSV: правило касается распознавания заголовка при загрузке.',
      title: 'BOM ломает заголовок sku',
      usage: {
        inputTokens: 1_000,
        uncachedInputTokens: 800,
        cacheReadTokens: 200,
        cacheWriteTokens: 0,
        outputTokens: 100,
      },
      // 800 @ $0.15/M + 200 @ $0.075/M + 100 @ $0.60/M
      costUsd: 0.000195,
    });
    expect(model.doGenerateCalls[0]?.temperature).toBe(0);

    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('import-eksport-csv — Импорт и экспорт товаров (CSV): Как загрузить каталог файлом.');
    expect(prompt).toContain('dostavka — Доставка и зоны');
    expect(prompt).toContain('BOM в первой ячейке ломает заголовок sku');
    expect(prompt).toContain('kind=undocumented');
    // Tripwire: like the extractor, the instructions must name no scenario object.
    const instructions = JSON.stringify(
      (model.doGenerateCalls[0]?.prompt ?? []).filter((message) => message.role === 'system'),
    );
    expect(instructions).not.toMatch(/BOM|sku|СкладУчёт|Дом и сад|Оплатим|10 сентября/i);
  });

  it('drops a title the model made too long and passes no temperature when the spec has none', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [choice({
        slug: 'dostavka',
        why: '  Про доставку.  ',
        title: `wiki: ${'очень длинный заголовок '.repeat(5)}`,
      })],
    });

    const chosen = await createPageChooser({ modelSpec: { provider: 'openai', model: 'gpt-4o-mini' }, model })(
      wiki(),
      ITEM,
    );

    expect(chosen.slug).toBe('dostavka');
    expect(chosen.why).toBe('Про доставку.');
    expect(chosen.title).toBeUndefined();
    expect(model.doGenerateCalls[0]?.temperature).toBeUndefined();
  });

  it('retries once when the answer does not parse, then lets the error through', async () => {
    const unknownPage = choice({ slug: 'novaya-stranica', why: 'Новая страница.', title: 'Заголовок' });
    const recovered = new MockLanguageModelV4({
      doGenerate: [unknownPage, choice({ slug: 'dostavka', why: 'Про доставку.', title: 'Заголовок' })],
    });
    expect((await createPageChooser({ modelSpec: SPEC, model: recovered })(wiki(), ITEM)).slug).toBe('dostavka');
    expect(recovered.doGenerateCalls).toHaveLength(2);

    const broken = new MockLanguageModelV4({ doGenerate: [unknownPage, unknownPage] });
    await expect(createPageChooser({ modelSpec: SPEC, model: broken })(wiki(), ITEM)).rejects.toThrow(
      /No object generated/,
    );
    expect(broken.doGenerateCalls).toHaveLength(2);
  });

  it('refuses to choose when the wiki has no pages', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [] });
    await expect(createPageChooser({ modelSpec: SPEC, model })(new Wiki([]), ITEM)).rejects.toThrow(
      /no pages to propose an update to/,
    );
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
