import { describe, expect, it } from 'vitest';

import type { MemoryItem } from '../evals/schema.ts';
import { ZERO_USAGE } from '../llm/index.ts';
import { wikiUpdateSection } from '../wiki/index.ts';
import type { GithubPullRequest } from './github.ts';
import {
  createRenderer,
  formatTimestamp,
  isExpired,
  noteLine,
  plainRenderer,
  renderConsolidation,
  renderMemoryIssue,
  renderProposalPullRequest,
  renderReply,
  renderWikiUpdated,
  TRACE_SUMMARY,
} from './render.ts';
import type { SessionConsolidation, SessionTurn } from './session.ts';
import type { ProposalRecord } from './state.ts';

const AT = '2026-09-06T10:00:00.000Z';

const WIKI = {
  pages: [
    { slug: 'dostavka', title: 'Доставка и зоны' },
    { slug: 'import-eksport-csv', title: 'Импорт и экспорт товаров (CSV)' },
  ],
};

const CUSTOMERS = {
  dom_i_sad: { name: 'Дом и сад' },
  velo_dvor: { name: 'ВелоДвор' },
  kofe_tochka: { name: 'Кофе-точка' },
  lavanda: { name: 'Лаванда' },
};

function item(id: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    kind: 'personal',
    about: 'kofe_tochka',
    learnedFrom: 'kofe_tochka',
    scope: 'customer',
    statement: 'По состоянию на 2026-09-06: магазин использует двухстадийную оплату.',
    source: { thread: 'issue-7', via: 'agent' },
    createdAt: AT,
    ...overrides,
  };
}

const INCIDENT = item('notes-3', {
  kind: 'temporal',
  about: 'product',
  learnedFrom: 'kofe_tochka',
  scope: 'shared',
  statement: 'По состоянию на 2026-09-05: оплата картами не проходит, QR работает;\nожидаемое восстановление к 18:00.',
  validUntil: '2026-09-05T18:00:00+03:00',
  source: { thread: 'issue-5', via: 'consolidate' },
  createdAt: '2026-09-05T12:00:00.000Z',
});

function sessionTurn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    id: 'turn-1',
    thread: 'issue-7',
    at: AT,
    outcome: 'answer',
    reply: 'Заказ может подождать две недели.\n\nДля двухстадийной оплаты холд снимается через 7 дней, поэтому лучше списать сразу.',
    trace: [{ step: 1, toolCalls: [], usage: ZERO_USAGE }],
    memoryWrites: [],
    usage: ZERO_USAGE,
    costUsd: 0.0123,
    latencyMs: 3400,
    recalls: [],
    responseLatencyMs: 4210,
    ...overrides,
  };
}

function consolidation(overrides: Partial<SessionConsolidation> = {}): SessionConsolidation {
  return { thread: 'issue-7', at: AT, events: 3, wrote: [], ...overrides };
}

const PROPOSAL: ProposalRecord = {
  itemId: 'notes-4',
  pullNumber: 12,
  branch: 'wiki/proposal-notes-4',
  page: 'import-eksport-csv',
  sourceThread: 'issue-7',
  status: 'merged',
  createdAt: AT,
  updatedAt: AT,
};

const PULL: GithubPullRequest = {
  number: 12,
  nodeId: 'PR_12',
  title: 'wiki: BOM ломает заголовок sku',
  body: '',
  state: 'closed',
  merged: true,
  headRef: 'wiki/proposal-notes-4',
  baseRef: 'main',
  labels: ['proposal'],
  createdAt: AT,
  updatedAt: AT,
  url: 'https://github.com/CrazyClicker/memorybot/pull/12',
};

// ---------------------------------------------------------------------------------------------

describe('renderReply', () => {
  it('answer: reply first, then the trace with pages, searches, recalls, writes and cost', async () => {
    const personal = item('agent-issue-2-turn-1-1');
    const turn = sessionTurn({
      trace: [
        {
          step: 1,
          toolCalls: [
            { tool: 'search_wiki', input: { query: 'зоны доставки' }, output: [{ slug: 'dostavka' }, { slug: 'zakazy-i-vozvraty' }] },
            { tool: 'recall_memory', input: { query: 'режим оплаты' }, output: [] },
          ],
          usage: ZERO_USAGE,
        },
        {
          step: 2,
          toolCalls: [
            { tool: 'read_page', input: { slug: 'dostavka' }, output: '## Зоны доставки …' },
            { tool: 'read_page', input: { slug: 'dostavka' }, output: '## Зоны доставки …' },
            { tool: 'read_page', input: { slug: 'oplata' }, output: { error: 'Unknown wiki page "oplata"' } },
          ],
          usage: ZERO_USAGE,
        },
        {
          step: 3,
          toolCalls: [
            { tool: 'remember', input: { kind: 'personal', statement: 'доставляет только по Томской области' } },
            { tool: 'finish', input: { outcome: 'answer', reply: '…' } },
          ],
          usage: ZERO_USAGE,
        },
      ],
      recalls: [
        { via: 'hydrate', query: 'Может ли заказ подождать две недели?', returned: [personal, INCIDENT], latencyMs: 12, estimatedTokens: 80 },
        { via: 'tool', query: 'режим оплаты', returned: [personal], latencyMs: 4, estimatedTokens: 40 },
      ],
      memoryWrites: [
        item('agent-issue-7-turn-1-1', {
          statement: 'По состоянию на 2026-09-06: доставляет только по Томской области.',
          source: { thread: 'issue-7', step: 'turn-1', via: 'agent' },
        }),
      ],
      usage: { ...ZERO_USAGE, inputTokens: 5120, uncachedInputTokens: 5120, outputTokens: 210 },
    });

    const text = renderReply(turn, { wiki: WIKI, memoryIssue: 1 });

    expect(text.startsWith(`${turn.reply}\n\n<details>\n<summary>${TRACE_SUMMARY}</summary>\n\n`)).toBe(true);
    expect(text.endsWith('\n\n</details>')).toBe(true);
    await expect(text).toMatchFileSnapshot('__snapshots__/reply-answer.md');
  });

  it('escalate: the reason on one line, an empty recall, no writes, an unpriced model', async () => {
    const turn = sessionTurn({
      outcome: 'escalate',
      reply: 'Передаю обращение инженеру: потеря строк при импорте требует проверки на нашей стороне.',
      escalationReason: 'После чистого импорта пропали 37 строк;\n  в базе знаний причины нет.',
      trace: [
        { step: 1, toolCalls: [{ tool: 'read_page', input: { slug: 'import-eksport-csv' }, output: '…' }], usage: ZERO_USAGE },
        { step: 2, toolCalls: [{ tool: 'finish', input: {} }], usage: ZERO_USAGE },
      ],
      recalls: [{ via: 'hydrate', query: 'пропали 37 строк', returned: [], latencyMs: 3, estimatedTokens: 0 }],
      costUsd: undefined,
      usage: { ...ZERO_USAGE, inputTokens: 2048, uncachedInputTokens: 2048, outputTokens: 96 },
    });

    await expect(renderReply(turn, { wiki: WIKI })).toMatchFileSnapshot('__snapshots__/reply-escalate.md');
  });

  it('ask: no wiki index and no memory access; pages fall back to their slug', async () => {
    const turn = sessionTurn({
      outcome: 'ask',
      reply: 'Уточните, пожалуйста, какой режим оплаты включён в настройках магазина?',
      trace: [{ step: 1, toolCalls: [{ tool: 'read_page', input: { slug: 'platezhi-i-vyplaty' }, output: '…' }], usage: ZERO_USAGE }],
    });

    await expect(renderReply(turn)).toMatchFileSnapshot('__snapshots__/reply-ask.md');
  });
});

describe('renderConsolidation', () => {
  it('lists the notes written and links the proposal pull requests', async () => {
    const result = consolidation({
      wrote: [
        item('notes-4', {
          kind: 'undocumented',
          about: 'product',
          learnedFrom: 'dom_i_sad',
          scope: 'shared',
          statement: 'По состоянию на 2026-09-06: BOM в первой ячейке ломает заголовок sku; пересохранить файл без BOM.',
          documentationCandidate: true,
          source: { thread: 'issue-7', via: 'consolidate' },
        }),
        item('notes-5', {
          kind: 'temporal',
          about: 'dom_i_sad',
          learnedFrom: 'dom_i_sad',
          statement: 'По состоянию на 2026-09-06: до релиза 12.09 файл загружает поддержка вручную.',
          validUntil: '2026-09-12',
          source: { thread: 'issue-7', via: 'consolidate' },
        }),
      ],
      costUsd: 0.0031,
    });

    const text = renderConsolidation(result, {
      trigger: 'coach',
      proposals: [{ number: 12, page: 'import-eksport-csv', url: PULL.url }],
    });

    await expect(text).toMatchFileSnapshot('__snapshots__/consolidation-coach.md');
  });

  it('says so when nothing was new or nothing was written', () => {
    expect(renderConsolidation(consolidation({ events: 1 }), { trigger: 'close' })).toBe(
      '🧠 **Консолидация при закрытии обращения:** обработано событий — 1, новых заметок нет.',
    );
    expect(renderConsolidation(consolidation({ events: 0 }), { trigger: 'consolidate' })).toBe(
      '🧠 **Консолидация по команде /consolidate:** новых событий нет, память не менялась.',
    );
    expect(renderConsolidation(consolidation({ events: 2, costUsd: 0 }), { trigger: 'coach', proposals: [{ number: 3, page: 'dostavka' }] })).toBe(
      [
        '🧠 **Консолидация после coach-заметки:** обработано событий — 2, новых заметок нет.',
        '',
        '📄 **Предложения в документацию:** #3 (`dostavka`).',
        '',
        '_Извлечение: $0.0000._',
      ].join('\n'),
    );
  });
});

describe('renderProposalPullRequest', () => {
  const CANDIDATE = item('notes-4', {
    kind: 'undocumented',
    about: 'product',
    learnedFrom: 'dom_i_sad',
    scope: 'shared',
    statement:
      'По состоянию на 2026-09-06: при BOM в первой ячейке заголовок sku не распознаётся,\nи строка молча исчезает из отчёта.',
    documentationCandidate: true,
    source: { thread: 'issue-7', via: 'consolidate' },
  });

  it('shows the addition, the reason, the source note and the leak warning', async () => {
    const { title, body } = renderProposalPullRequest({
      item: CANDIDATE,
      page: { slug: 'import-eksport-csv', title: 'Импорт и экспорт товаров (CSV)' },
      why: 'Страница описывает разбор файла и сопоставление по sku,\n  то есть ровно то, что нарушает BOM.',
      title: 'BOM ломает заголовок sku',
      sourceIssue: 7,
      addition: wikiUpdateSection(CANDIDATE.statement, AT),
      at: AT,
      leak: { terms: ['BOM', 'молча'], merchants: [] },
    });

    expect(title).toBe('wiki: BOM ломает заголовок sku');
    expect(body).toContain('#7');
    await expect(body).toMatchFileSnapshot('__snapshots__/proposal-import.md');
  });

  it('falls back to the page title, keeps a thread without an issue, and calls out a merchant name', async () => {
    const leaked = { ...CANDIDATE, statement: 'По состоянию на 2026-09-06: «Дом и сад» теряет строки при импорте.' };
    const { title, body } = renderProposalPullRequest({
      item: leaked,
      page: { slug: 'import-eksport-csv', title: 'Импорт и экспорт товаров (CSV)' },
      addition: wikiUpdateSection(leaked.statement, AT),
      at: AT,
      leak: { terms: ['Дом и сад', 'пропуск'], merchants: ['Дом и сад'] },
    });

    expect(title).toBe('wiki: Импорт и экспорт товаров (CSV)');
    expect(body).not.toMatch(/#\d/);
    await expect(body).toMatchFileSnapshot('__snapshots__/proposal-merchant.md');
  });

  it('says when the lint did not run, and keeps a fenced statement inside the block', () => {
    const withFence = { ...CANDIDATE, statement: 'Заголовок пишется как ```sku```.' };
    const body = renderProposalPullRequest({
      item: withFence,
      page: { slug: 'dostavka', title: 'Доставка и зоны' },
      addition: wikiUpdateSection(withFence.statement, AT),
      at: AT,
    }).body;

    expect(body).toContain('````markdown\n## Обновление от 2026-09-06\n\nЗаголовок пишется как ```sku```.\n````');
    expect(body).toContain('**Проверка на утечку** (`wiki/README.md`): не выполнялась.');
    expect(body).toContain('**Источник:** заметка `notes-4` · `undocumented` · `shared` · бессрочно');
  });

  it('adds the pull-request links to the plain consolidation line the loop tests read', () => {
    const context = { issueNumber: 7, thread: 'issue-7', trigger: 'coach' } as const;
    expect(plainRenderer.consolidation(consolidation({ events: 2 }), context)).toBe(
      'Консолидация: новых заметок нет (событий: 2).',
    );
    expect(plainRenderer.consolidation(consolidation({ events: 2 }), {
      ...context,
      proposals: [{ number: 12, page: 'import-eksport-csv' }],
    })).toBe(
      'Консолидация: новых заметок нет (событий: 2).\nПредложения в документацию: #12 (import-eksport-csv).',
    );
  });

  it('is one line in the plain renderer the loop tests read', () => {
    expect(plainRenderer.proposal({
      item: CANDIDATE,
      page: { slug: 'import-eksport-csv', title: 'Импорт и экспорт товаров (CSV)' },
      title: 'BOM ломает заголовок sku',
      sourceIssue: 7,
      addition: 'unused',
      at: AT,
    })).toEqual({
      title: 'wiki: BOM ломает заголовок sku',
      body:
        'Предложение в `import-eksport-csv` из #7: По состоянию на 2026-09-06: при BOM в первой ячейке ' +
        'заголовок sku не распознаётся, и строка молча исчезает из отчёта.',
    });
  });
});

describe('renderWikiUpdated', () => {
  it('names the page by title when the wiki is known, by slug otherwise', () => {
    expect(renderWikiUpdated(PROPOSAL, PULL, { wiki: WIKI })).toBe(
      '📚 **Документация обновлена:** [#12](https://github.com/CrazyClicker/memorybot/pull/12) влит, страница ' +
        '«Импорт и экспорт товаров (CSV)» (`import-eksport-csv`) перечитана с `main`. Следующие ответы опираются на новую версию.',
    );
    expect(renderWikiUpdated(PROPOSAL, PULL)).toContain('страница `import-eksport-csv` перечитана');
  });
});

describe('renderMemoryIssue', () => {
  it('one section per merchant plus the shared notes, expired ones struck through', async () => {
    const items: MemoryItem[] = [
      INCIDENT,
      item('notes-6', {
        kind: 'temporal',
        about: 'product',
        learnedFrom: 'lavanda',
        scope: 'shared',
        statement: 'По состоянию на 2026-09-06: выплаты за выходные придут во вторник.',
        validUntil: '2026-09-08',
        source: { thread: 'issue-9', via: 'consolidate' },
        createdAt: '2026-09-06T09:00:00.000Z',
      }),
      item('agent-issue-2-turn-1-1', { createdAt: '2026-09-04T08:00:00.000Z', source: { thread: 'issue-2', step: 'turn-1', via: 'agent' } }),
      item('agent-issue-2-turn-1-2', {
        statement: 'По состоянию на 2026-09-04: доставляет только по Томской области.',
        createdAt: '2026-09-04T08:00:00.000Z',
        source: { thread: 'issue-2', step: 'turn-1', via: 'agent' },
      }),
      item('notes-4', {
        kind: 'undocumented',
        about: 'product',
        learnedFrom: 'dom_i_sad',
        statement: 'По состоянию на 2026-09-05: BOM в первой ячейке ломает заголовок sku.',
        documentationCandidate: true,
        source: { thread: 'issue-7', via: 'consolidate' },
        createdAt: '2026-09-05T15:00:00.000Z',
      }),
      item('notes-5', {
        kind: 'temporal',
        about: 'dom_i_sad',
        learnedFrom: 'dom_i_sad',
        statement: 'По состоянию на 2026-09-01: до релиза 05.09 файл загружает поддержка вручную.',
        validUntil: '2026-09-05',
        source: { thread: 'issue-7', via: 'consolidate' },
        createdAt: '2026-09-01T15:00:00.000Z',
      }),
      item('notes-9', {
        kind: 'other',
        about: 'ghost',
        learnedFrom: 'ghost',
        statement: 'По состоянию на 2026-09-06: клиент вне конфигурации.',
        source: { thread: 'ticket-x', via: 'consolidate' },
      }),
    ];

    const text = renderMemoryIssue(items, { now: '2026-09-06T12:30:00.000Z', customers: CUSTOMERS });

    expect(text).toContain('Заметок: 7, общих: 2, истёкших: 2.');
    await expect(text).toMatchFileSnapshot('__snapshots__/memory-issue.md');
  });

  it('renders every configured merchant even with nothing to show', () => {
    const text = renderMemoryIssue([], { now: AT, customers: { dom_i_sad: { name: 'Дом и сад' } } });
    expect(text).toContain('часы сценария: 2026-09-06 10:00 UTC');
    expect(text).toContain('Заметок: 0, общих: 0, истёкших: 0.');
    expect(text.split('_Заметок нет._')).toHaveLength(3);
    expect(text).toContain('## Дом и сад (`dom_i_sad`)');
  });
});

describe('noteLine and the helpers', () => {
  it('formats validity against the clock given, a bare date covering its whole day', () => {
    const dated = item('n', { kind: 'temporal', validUntil: '2026-09-06' });
    expect(isExpired(dated, '2026-09-06T23:59:00Z')).toBe(false);
    expect(isExpired(dated, '2026-09-07T00:00:00Z')).toBe(true);
    expect(noteLine(dated, '2026-09-06T12:00:00Z')).toBe(
      '`temporal` · до 2026-09-06 — По состоянию на 2026-09-06: магазин использует двухстадийную оплату. · #7',
    );
    expect(noteLine(dated, '2026-09-07T12:00:00Z', { scope: true })).toBe(
      '`temporal` · `customer` · до 2026-09-06, истекла — По состоянию на 2026-09-06: магазин использует двухстадийную оплату. · #7',
    );
    expect(noteLine(dated, '2026-09-07T12:00:00Z', { strike: true })).toBe(
      '~~`temporal` · до 2026-09-06 — По состоянию на 2026-09-06: магазин использует двухстадийную оплату.~~ · истекла · #7',
    );
  });

  it('calls out notes about something other than the section owner', () => {
    const product = item('n', { kind: 'undocumented', about: 'product', documentationCandidate: true, source: { thread: 'ticket-1', via: 'consolidate' } });
    expect(noteLine(product, AT, { customer: 'kofe_tochka' })).toBe(
      '`undocumented` · о продукте · бессрочно — По состоянию на 2026-09-06: магазин использует двухстадийную оплату. · кандидат в документацию',
    );
    expect(noteLine(item('n', { about: 'lavanda' }), AT, { customer: 'kofe_tochka' })).toContain('· о `lavanda` ·');
  });

  it('shows timestamps as written, offset included', () => {
    expect(formatTimestamp('2026-09-05T18:00:00+03:00')).toBe('2026-09-05 18:00 (+03:00)');
    expect(formatTimestamp('2026-09-06T10:00:00.000Z')).toBe('2026-09-06 10:00 UTC');
    expect(formatTimestamp('2026-09-06T10:00')).toBe('2026-09-06 10:00');
    expect(formatTimestamp(' 2026-09-12 ')).toBe('2026-09-12');
  });

  it('createRenderer threads the memory issue into every reply; plainRenderer stays one line per event', () => {
    const rich = createRenderer({ memoryIssue: 1 });
    const turn = sessionTurn();
    const issue = { number: 7 } as never;
    expect(rich.reply(turn, { issue, thread: 'issue-7' })).toContain('- **Вся память агента:** #1');
    expect(createRenderer().reply(turn, { issue, thread: 'issue-7' })).not.toContain('Вся память агента');
    expect(plainRenderer.reply(turn, { issue, thread: 'issue-7' })).toBe(turn.reply);
    expect(plainRenderer.memoryIssue([], { now: AT, customers: {} })).toBe('Заметок нет.');
    expect(plainRenderer.memoryIssue([INCIDENT], { now: AT, customers: {} })).toBe(
      `- [temporal, shared, kofe_tochka] ${INCIDENT.statement}`,
    );
  });
});
