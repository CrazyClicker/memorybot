/**
 * What the bot writes on GitHub (ROADMAP §6, T4.4): the reply comment with its collapsed
 * trace, the consolidation comment, the note on the source issue after a proposal PR merged
 * and the body of the pinned «🧠 Память агента» issue. Pure functions over the session records
 * (`SessionTurn`, `SessionConsolidation`, `MemoryItem`), snapshot-tested offline; the loop's
 * `LoopRenderer` is the thin object around them and `plainRenderer` the one-line variant the
 * loop tests read.
 *
 * Decisions:
 * - The customer-facing reply comes first and unchanged; everything a viewer must not mistake
 *   for the answer sits under `<details>`. The trace is read from the turn record, never
 *   recomputed: pages read and searches from the tool calls in `turn.trace`, recalled notes
 *   from `turn.recalls`, writes from `turn.memoryWrites`.
 * - Notes keep the project's vocabulary (`personal`/`temporal`/`undocumented`,
 *   `customer`/`shared`) in code spans, so a viewer can match them to the report and the
 *   scenarios; validity and everything else is Russian. One line per note everywhere.
 * - Expiry is judged against the clock the caller passes (the turn's clock in a reply, the
 *   session clock in the memory issue), never the wall clock; a bare `valid_until` date covers
 *   its whole day (`expiryMs`). Timestamps are shown as written, offset included: the coach
 *   wrote «до 18:00» in their own time zone.
 * - The memory issue lists every configured merchant, empty sections included, so isolation is
 *   visible at a glance; customer-scoped notes go under the merchant whose thread taught them
 *   (`learnedFrom`), shared ones in their own section, expired ones struck through.
 */
import { expiryMs, type MemoryItem, type Outcome } from '../evals/schema.ts';
import type { WikiPage } from '../wiki/index.ts';
import type { GithubIssue, GithubPullRequest } from './github.ts';
import type { SessionConsolidation, SessionTurn } from './session.ts';
import type { ProposalRecord } from './state.ts';

export const TRACE_SUMMARY = 'Как я отвечал';
export const READ_PAGE_TOOL = 'read_page';
export const SEARCH_WIKI_TOOL = 'search_wiki';

// ---------------------------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------------------------

export type ConsolidationTrigger = 'coach' | 'consolidate' | 'close';

/** Page titles for the trace; a `Wiki` satisfies it. */
export interface PageIndex {
  readonly pages: readonly Pick<WikiPage, 'slug' | 'title'>[];
}

export interface ReplyContext {
  readonly issue: GithubIssue;
  readonly thread: string;
  /** The snapshot the turn read; without it pages are named by slug only. */
  readonly wiki?: PageIndex;
}

/** A documentation-proposal pull request opened for a consolidation (T4.5). */
export interface ProposalLink {
  readonly number: number;
  /** Wiki page slug the proposal appends to. */
  readonly page: string;
  readonly url?: string;
}

export interface ConsolidationContext {
  readonly issueNumber: number;
  readonly thread: string;
  readonly trigger: ConsolidationTrigger;
  readonly proposals?: readonly ProposalLink[];
}

export interface WikiUpdatedContext {
  readonly wiki?: PageIndex;
}

export interface MemoryIssueContext {
  /** Session clock; decides what is struck through. */
  readonly now: string;
  /** Configured merchants by id, in config order; each gets a section. */
  readonly customers: Readonly<Record<string, { readonly name: string }>>;
}

export interface LoopRenderer {
  /** The bot comment for an agent turn. */
  reply(turn: SessionTurn, context: ReplyContext): string;
  /** The comment after a consolidation. */
  consolidation(result: SessionConsolidation, context: ConsolidationContext): string;
  /** The comment on the source issue after its proposal PR merged. */
  wikiUpdated(proposal: ProposalRecord, pull: GithubPullRequest, context?: WikiUpdatedContext): string;
  /** The whole body of the pinned memory issue. */
  memoryIssue(items: readonly MemoryItem[], context: MemoryIssueContext): string;
}

export interface RenderOptions {
  /** Number of the pinned memory issue; every trace links to it when set. */
  readonly memoryIssue?: number;
}

export function createRenderer(options: RenderOptions = {}): LoopRenderer {
  return {
    reply: (turn, context) => renderReply(turn, { ...context, ...options }),
    consolidation: renderConsolidation,
    wikiUpdated: renderWikiUpdated,
    memoryIssue: renderMemoryIssue,
  };
}

/** One line per event, no markup: what the loop tests read and `pnpm live once` can print. */
export const plainRenderer: LoopRenderer = {
  reply: (turn) => turn.reply,
  consolidation: (result) => {
    if (result.wrote.length === 0) return `Консолидация: новых заметок нет (событий: ${result.events}).`;
    return [
      `Консолидация: записано заметок — ${result.wrote.length}.`,
      ...result.wrote.map((item) => {
        const validity = item.validUntil === undefined ? '' : `, до ${item.validUntil}`;
        return `- [${item.kind}, ${item.scope}${validity}] ${item.statement}`;
      }),
    ].join('\n');
  },
  wikiUpdated: (proposal, pull) => `Документация обновлена: страница \`${proposal.page}\` (#${pull.number}).`,
  memoryIssue: (items) =>
    items.length === 0
      ? 'Заметок нет.'
      : items.map((item) => `- [${item.kind}, ${item.scope}, ${item.learnedFrom}] ${item.statement}`).join('\n'),
};

// ---------------------------------------------------------------------------------------------
// The reply comment
// ---------------------------------------------------------------------------------------------

export interface ReplyRenderOptions {
  readonly wiki?: PageIndex;
  readonly memoryIssue?: number;
}

const OUTCOME_TEXT: Record<Outcome, string> = {
  answer: 'ответил сам',
  ask: 'задал уточняющий вопрос и жду ответа клиента',
  escalate: 'передал сотруднику поддержки',
};

/** The customer-facing reply, then the collapsed «Как я отвечал» block. */
export function renderReply(turn: SessionTurn, options: ReplyRenderOptions = {}): string {
  const lines = [`- **Итог:** ${OUTCOME_TEXT[turn.outcome]}.`];
  if (turn.escalationReason !== undefined) {
    lines.push(`- **Причина эскалации:** ${oneLine(turn.escalationReason)}`);
  }
  lines.push(`- **База знаний:** ${describeWikiUse(turn, options.wiki)}`);
  lines.push(...describeRecalls(turn));
  lines.push(...describeWrites(turn));
  lines.push(`- **Стоимость и время:** ${describeCost(turn)}`);
  if (options.memoryIssue !== undefined) lines.push(`- **Вся память агента:** #${options.memoryIssue}`);
  return [
    turn.reply.trim(),
    '',
    '<details>',
    `<summary>${TRACE_SUMMARY}</summary>`,
    '',
    ...lines,
    '',
    '</details>',
  ].join('\n');
}

function describeWikiUse(turn: SessionTurn, wiki: PageIndex | undefined): string {
  const titles = new Map((wiki?.pages ?? []).map((page) => [page.slug, page.title]));
  const read: string[] = [];
  const seen = new Set<string>();
  const searches: string[] = [];
  for (const step of turn.trace) {
    for (const call of step.toolCalls) {
      if (call.tool === READ_PAGE_TOOL) {
        const slug = stringField(call.input, 'slug');
        if (slug === undefined || seen.has(slug)) continue;
        seen.add(slug);
        const title = titles.get(slug);
        const missing = isToolError(call.output) ? ' — не найдена' : '';
        read.push(`${title === undefined ? `\`${slug}\`` : `«${title}» (\`${slug}\`)`}${missing}`);
      } else if (call.tool === SEARCH_WIKI_TOOL) {
        const query = stringField(call.input, 'query');
        if (query === undefined) continue;
        const hits = Array.isArray(call.output) ? ` → ${call.output.length}` : '';
        searches.push(`«${oneLine(query)}»${hits}`);
      }
    }
  }
  const parts = [read.length === 0 ? 'страницы не читал' : `читал ${read.join(', ')}`];
  if (searches.length > 0) parts.push(`поиск: ${searches.join(', ')}`);
  return `${parts.join('; ')}.`;
}

function describeRecalls(turn: SessionTurn): string[] {
  if (turn.recalls.length === 0) return ['- **Память:** не обращался.'];
  const via = [
    turn.recalls.some((observation) => observation.via === 'hydrate') ? 'в промпте' : undefined,
    turn.recalls.some((observation) => observation.via === 'tool') ? 'через recall_memory' : undefined,
  ].filter((part) => part !== undefined).join(' и ');
  const items = uniqueById(turn.recalls.flatMap((observation) => observation.returned));
  const head = `- **Вспомнил из памяти** (${via}):`;
  if (items.length === 0) return [`${head} подходящих заметок нет.`];
  return [head, ...items.map((item) => `  - ${noteLine(item, turn.at, { scope: true })}`)];
}

function describeWrites(turn: SessionTurn): string[] {
  if (turn.memoryWrites.length === 0) return ['- **Записал в память:** ничего.'];
  return ['- **Записал в память:**', ...turn.memoryWrites.map((item) => `  - ${noteLine(item, turn.at, { scope: true })}`)];
}

function describeCost(turn: SessionTurn): string {
  const cost = turn.costUsd === undefined ? 'стоимость неизвестна' : `$${turn.costUsd.toFixed(4)}`;
  const seconds = `${(turn.responseLatencyMs / 1000).toFixed(1)} с`;
  const tokens = `${groupDigits(turn.usage.inputTokens)} на входе и ${groupDigits(turn.usage.outputTokens)} на выходе`;
  return `${cost}, ${seconds}, шагов модели: ${turn.trace.length}, токенов: ${tokens}.`;
}

// ---------------------------------------------------------------------------------------------
// The consolidation comment and the wiki-updated note
// ---------------------------------------------------------------------------------------------

const TRIGGER_TEXT: Record<ConsolidationTrigger, string> = {
  coach: 'после coach-заметки',
  consolidate: 'по команде /consolidate',
  close: 'при закрытии обращения',
};

export function renderConsolidation(
  result: SessionConsolidation,
  context: Pick<ConsolidationContext, 'trigger' | 'proposals'>,
): string {
  const title = `🧠 **Консолидация ${TRIGGER_TEXT[context.trigger]}:**`;
  if (result.events === 0) return `${title} новых событий нет, память не менялась.`;
  const count = result.wrote.length === 0 ? 'новых заметок нет' : `новых заметок — ${result.wrote.length}`;
  const lines = [`${title} обработано событий — ${result.events}, ${count}.`];
  if (result.wrote.length > 0) {
    lines.push('', ...result.wrote.map((item) => `- ${noteLine(item, result.at, { scope: true })}`));
  }
  const proposals = context.proposals ?? [];
  if (proposals.length > 0) {
    lines.push('', `📄 **Предложения в документацию:** ${proposals.map(describeProposal).join(', ')}.`);
  }
  if (result.costUsd !== undefined) lines.push('', `_Извлечение: $${result.costUsd.toFixed(4)}._`);
  return lines.join('\n');
}

function describeProposal(link: ProposalLink): string {
  const ref = link.url === undefined ? `#${link.number}` : `[#${link.number}](${link.url})`;
  return `${ref} (\`${link.page}\`)`;
}

export function renderWikiUpdated(
  proposal: ProposalRecord,
  pull: GithubPullRequest,
  context: WikiUpdatedContext = {},
): string {
  const title = context.wiki?.pages.find((page) => page.slug === proposal.page)?.title;
  const page = title === undefined ? `\`${proposal.page}\`` : `«${title}» (\`${proposal.page}\`)`;
  return (
    `📚 **Документация обновлена:** [#${pull.number}](${pull.url}) влит, страница ${page} ` +
    'перечитана с `main`. Следующие ответы опираются на новую версию.'
  );
}

// ---------------------------------------------------------------------------------------------
// The pinned memory issue
// ---------------------------------------------------------------------------------------------

export function renderMemoryIssue(items: readonly MemoryItem[], context: MemoryIssueContext): string {
  const sorted = [...items].sort(byCreation);
  const shared = sorted.filter((item) => item.scope === 'shared');
  const expired = sorted.filter((item) => isExpired(item, context.now)).length;
  const byCustomer = new Map<string, MemoryItem[]>(Object.keys(context.customers).map((id) => [id, []]));
  for (const item of sorted) {
    if (item.scope === 'shared') continue;
    const bucket = byCustomer.get(item.learnedFrom);
    if (bucket === undefined) byCustomer.set(item.learnedFrom, [item]);
    else bucket.push(item);
  }
  const lines = [
    '_Что агент запомнил из обращений. Обновляется после каждой записи и каждого сдвига часов; ' +
      `часы сценария: ${formatTimestamp(context.now)}._`,
    '',
    `Заметок: ${sorted.length}, общих: ${shared.length}, истёкших: ${expired}. Заметки клиента видны только ` +
      'в его обращениях; общие видны всем и появляются только из coach-заметки со `scope: product`.',
    '',
    '## Общие заметки',
    '',
    ...memorySection(shared, context.now, {}),
  ];
  for (const [id, bucket] of byCustomer) {
    const name = context.customers[id]?.name;
    lines.push('', name === undefined ? `## \`${id}\`` : `## ${name} (\`${id}\`)`, '');
    lines.push(...memorySection(bucket, context.now, { customer: id }));
  }
  return lines.join('\n');
}

function memorySection(items: readonly MemoryItem[], now: string, options: NoteLineOptions): string[] {
  if (items.length === 0) return ['_Заметок нет._'];
  return items.map((item) => `- ${noteLine(item, now, { ...options, strike: true })}`);
}

// ---------------------------------------------------------------------------------------------
// One note, one line
// ---------------------------------------------------------------------------------------------

export interface NoteLineOptions {
  /** Show the `customer`/`shared` scope; the memory issue's sections make it redundant. */
  readonly scope?: boolean;
  /** The merchant the section belongs to; a note about something else says so. */
  readonly customer?: string;
  /** Strike an expired note through (memory issue) instead of only saying so. */
  readonly strike?: boolean;
}

/** `` `kind` · `scope` · validity — statement · flags · #issue ``. */
export function noteLine(item: MemoryItem, now: string, options: NoteLineOptions = {}): string {
  const expired = isExpired(item, now);
  const strike = expired && options.strike === true;
  const head = [`\`${item.kind}\``];
  if (options.scope === true) head.push(`\`${item.scope}\``);
  if (options.customer !== undefined && item.about !== options.customer) {
    head.push(item.about === 'product' ? 'о продукте' : `о \`${item.about}\``);
  }
  const validity = item.validUntil === undefined ? 'бессрочно' : `до ${formatTimestamp(item.validUntil)}`;
  head.push(expired && !strike ? `${validity}, истекла` : validity);
  const body = `${head.join(' · ')} — ${oneLine(item.statement)}`;
  const tail = [
    strike ? 'истекла' : undefined,
    item.documentationCandidate === true ? 'кандидат в документацию' : undefined,
    issueRef(item.source.thread),
  ].filter((part) => part !== undefined);
  return [strike ? `~~${body}~~` : body, ...tail].join(' · ');
}

export function isExpired(item: Pick<MemoryItem, 'validUntil'>, now: string): boolean {
  return item.validUntil !== undefined && expiryMs(item.validUntil) < Date.parse(now);
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** `2026-09-05T18:00:00+03:00` → `2026-09-05 18:00 (+03:00)`; a bare date stays as it is. */
export function formatTimestamp(value: string): string {
  const trimmed = value.trim();
  const match = TIMESTAMP.exec(trimmed);
  if (match?.[1] === undefined || match[2] === undefined) return trimmed;
  const zone = match[3] === undefined ? '' : match[3] === 'Z' ? ' UTC' : ` (${match[3]})`;
  return `${match[1]} ${match[2]}${zone}`;
}

/** The loop names threads `issue-N`; GitHub links `#N` by itself. */
function issueRef(thread: string): string | undefined {
  const match = /^issue-(\d+)$/.exec(thread);
  return match?.[1] === undefined ? undefined : `#${match[1]}`;
}

function byCreation(a: MemoryItem, b: MemoryItem): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id, 'en', { numeric: true });
}

function uniqueById(items: readonly MemoryItem[]): MemoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isToolError(output: unknown): boolean {
  return typeof output === 'object' && output !== null && 'error' in output;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
