import { describe, expect, it } from 'vitest';

import { AgentDidNotFinishError, type TurnInput, type TurnResult } from '../agent/index.ts';
import type { Config } from '../evals/schema.ts';
import { ZERO_USAGE } from '../llm/index.ts';
import {
  cloneMemoryItem,
  type MemoryEngine,
  type MemoryEngineUsage,
  type MemoryItem,
  type ThreadTranscript,
} from '../memory/index.ts';
import { Wiki, wikiUpdateSection } from '../wiki/index.ts';
import { type LiveConfig, parseLiveConfig, sessionCustomers } from './config.ts';
import { FakeGithubClient } from './fake-github.ts';
import {
  abortableSleep,
  COACH_REACTION,
  githubIds,
  ISSUES_SINCE_KEY,
  LiveLoop,
  MAX_TURN_ATTEMPTS,
  type PollResult,
  PROPOSAL_BRANCH_PREFIX,
  threadIdFor,
} from './loop.ts';
import type { PageChoice } from './proposals.ts';
import { type LoopRenderer, plainRenderer, TRACE_SUMMARY } from './render.ts';
import { Session } from './session.ts';
import { LiveState } from './state.ts';

const WALL = '2026-09-06T10:00:00.000Z';
const HUMAN = 'CrazyClicker';
const MERCHANT = 'marina-dom';

const LIVE_CONFIG_INPUT = {
  repo: 'CrazyClicker/memorybot',
  poll_seconds: 1,
  humans: [HUMAN],
  customers: {
    dom_i_sad: { form: 'Дом и сад', name: 'Дом и сад', profile: 'Магазин товаров для дома.' },
    velo_dvor: { form: 'ВелоДвор', name: 'ВелоДвор', logins: ['velo-dvor'] },
  },
};
const LIVE_CONFIG: LiveConfig = parseLiveConfig(LIVE_CONFIG_INPUT);

const WIKI_PAGE = (text: string, slug = 'help', title = 'Помощь'): string =>
  ['---', `slug: ${slug}`, `title: ${title}`, 'summary: Основная справка.', '---', '', text, ''].join('\n');

const PAGE_CHOICE: PageChoice = {
  slug: 'help',
  why: 'Страница про импорт каталога.',
  title: 'BOM ломает заголовок sku',
  usage: ZERO_USAGE,
  costUsd: 0.0002,
};

function formBody(merchant: string, message: string): string {
  return `### Магазин\n\n${merchant}\n\n### Сообщение\n\n${message}\n`;
}

function evalConfig(overrides: Partial<Config['memory']> = {}): Config {
  return {
    id: 'test-config',
    agent: { provider: 'openai', model: 'gpt-4o-mini', temperature: 0 },
    memory: { engine: 'notes', read: 'both', write: 'both', ...overrides },
    judge: { provider: 'anthropic', model: 'claude-sonnet-5' },
  };
}

function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    outcome: 'answer',
    reply: 'Ответ агента.',
    memoryWrites: [],
    trace: [{ step: 1, toolCalls: [], usage: ZERO_USAGE }],
    usage: ZERO_USAGE,
    latencyMs: 10,
    costUsd: 0.001,
    ...overrides,
  };
}

function note(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'note',
    kind: 'undocumented',
    about: 'dom_i_sad',
    learnedFrom: 'dom_i_sad',
    scope: 'customer',
    statement: 'По состоянию на 2026-09-06: BOM ломает заголовок sku.',
    source: { thread: 'issue-1', via: 'consolidate' },
    createdAt: WALL,
    ...overrides,
  };
}

class RecordingEngine implements MemoryEngine {
  readonly id = 'recording';
  readonly consolidations: Array<{ thread: ThreadTranscript; now: string }> = [];
  readonly writes: MemoryItem[][] = [];
  /** Everything written or consolidated, in order: what `list()` serves the memory issue. */
  readonly items: MemoryItem[] = [];
  proposalItems: MemoryItem[] = [];

  async reset(): Promise<void> {}

  async recall(): Promise<MemoryItem[]> {
    return [];
  }

  async write(items: MemoryItem[]): Promise<void> {
    this.writes.push(items.map(cloneMemoryItem));
    this.items.push(...items.map(cloneMemoryItem));
  }

  async consolidate(thread: ThreadTranscript, now: string): Promise<MemoryItem[]> {
    this.consolidations.push({ thread: structuredClone(thread), now });
    const written = thread.events
      .filter((event) => event.type === 'coach_note')
      .map((event, index) =>
        note({
          id: `note-${this.consolidations.length}-${index + 1}`,
          scope: event.scope === 'product' ? 'shared' : 'customer',
          about: event.scope === 'product' ? 'product' : thread.customer,
          statement: event.content,
          createdAt: now,
        }),
      );
    this.items.push(...written.map(cloneMemoryItem));
    return written;
  }

  /** What the notes engine serves: the rows flagged as documentation candidates. */
  async proposals(): Promise<MemoryItem[]> {
    const items = [...this.proposalItems, ...this.items.filter((item) => item.documentationCandidate === true)];
    const byId = new Map(items.map((item) => [item.id, item]));
    return [...byId.values()].map(cloneMemoryItem);
  }

  async list(): Promise<MemoryItem[]> {
    return this.items.map(cloneMemoryItem);
  }

  usage(): MemoryEngineUsage {
    return { usage: ZERO_USAGE, costUsd: 0 };
  }
}

type Scripted = TurnResult | Error;

interface Fixture {
  readonly loop: LiveLoop;
  readonly github: FakeGithubClient;
  readonly session: Session;
  readonly state: LiveState;
  readonly engine: RecordingEngine;
  readonly calls: TurnInput[];
  readonly script: Scripted[];
  /** Page choices the loop's chooser returns, in order; the default repeats after them. */
  readonly pageChoices: (PageChoice | Error)[];
  readonly chooserCalls: MemoryItem[];
  readonly log: string[];
  wall: Date;
}

interface FixtureOptions {
  /** `plainRenderer` unless a test wants the loop's default (`render.ts`). */
  readonly render?: LoopRenderer | 'default';
  /** `memory_issue` in the live config; the test opens the issue itself when it should exist. */
  readonly memoryIssue?: number;
  /** The leak grep: off unless a test passes one, or `'readme'` for the loop's own default. */
  readonly leakPattern?: RegExp | 'readme';
}

function fixture(memory: Partial<Config['memory']> = {}, options: FixtureOptions = {}): Fixture {
  const config = options.memoryIssue === undefined
    ? LIVE_CONFIG
    : parseLiveConfig({ ...LIVE_CONFIG_INPUT, memory_issue: options.memoryIssue });
  const holder = { wall: new Date(WALL) } as Fixture;
  const clock = (): Date => holder.wall;
  const engine = new RecordingEngine();
  const state = new LiveState({ path: ':memory:', clock });
  const calls: TurnInput[] = [];
  const script: Scripted[] = [];
  const pageChoices: (PageChoice | Error)[] = [];
  const chooserCalls: MemoryItem[] = [];
  const log: string[] = [];
  const github = new FakeGithubClient({
    now: () => clock().toISOString(),
    files: {
      'wiki/help.md': WIKI_PAGE('Исходный текст.'),
      'wiki/dostavka.md': WIKI_PAGE('Зоны доставки.', 'dostavka', 'Доставка'),
      'wiki/README.md': '# Wiki\n',
    },
  });
  const session = new Session({
    config: evalConfig(memory),
    engine,
    wiki: new Wiki([
      { slug: 'help', title: 'Помощь', summary: 'Основная справка.', content: 'Исходный текст.' },
      { slug: 'dostavka', title: 'Доставка', summary: 'Основная справка.', content: 'Зоны доставки.' },
    ], { search: true }),
    state,
    customers: sessionCustomers(config),
    clock,
    runAgent: async (input) => {
      calls.push(input);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next ?? turn();
    },
  });
  const loop = new LiveLoop({
    session,
    github,
    config,
    ...(options.render === 'default' ? {} : { render: options.render ?? plainRenderer }),
    ...(options.leakPattern === 'readme' ? {} : { leakPattern: options.leakPattern ?? false }),
    choosePage: async (_wiki, item) => {
      chooserCalls.push(item);
      const next = pageChoices.shift();
      if (next instanceof Error) throw next;
      return next ?? PAGE_CHOICE;
    },
    log: (line) => {
      log.push(line);
    },
    sleep: async () => {},
  });
  Object.assign(holder, { loop, github, session, state, engine, calls, script, pageChoices, chooserCalls, log });
  return holder;
}

function openTicket(f: Fixture, merchant = 'Дом и сад', message = 'После импорта пропали 37 строк.', author = MERCHANT): number {
  return f.github.openIssue({ title: 'Импорт CSV', body: formBody(merchant, message), author, labels: ['support'] }).number;
}

function botComments(f: Fixture, issue: number): Promise<string[]> {
  return f.github.listComments(issue).then((comments) =>
    comments.filter((comment) => comment.author === f.github.login).map((comment) => comment.body),
  );
}

function sinceArgs(f: Fixture): (string | undefined)[] {
  return f.github.calls
    .filter((call) => call.method === 'listIssues')
    .map((call) => (call.args[0] as { since?: string }).since);
}

// ---------------------------------------------------------------------------------------------

describe('LiveLoop: issues opened through the form', () => {
  it('opens the thread for the form merchant, answers, labels and records the comment in one step', async () => {
    const f = fixture();
    const issue = openTicket(f);

    const result = await f.loop.poll();

    expect(result.errors).toEqual([]);
    expect(result.handled).toEqual([{ githubId: 'issue:1', issue, action: 'answer', comment: 1, detail: '0.0 s, $0.0010' }]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.customer.id).toBe('dom_i_sad');
    expect(f.calls[0]?.thread.events).toEqual([
      { type: 'customer_message', at: WALL, content: 'Импорт CSV\n\nПосле импорта пропали 37 строк.' },
    ]);
    expect(await botComments(f, issue)).toEqual(['Ответ агента.']);
    expect((await f.github.getIssue(issue)).labels).toEqual(['support', 'agent:answered']);

    const thread = f.state.threadByIssue(issue);
    expect(thread).toMatchObject({ id: threadIdFor(issue), customer: 'dom_i_sad', issueNumber: issue });
    const events = f.state.events(threadIdFor(issue));
    expect(events.map((event) => [event.type, event.githubId])).toEqual([
      ['customer_message', 'issue:1'],
      ['agent_reply', 'comment:1'],
    ]);
    expect(f.state.processed('issue:1')).toMatchObject({ issueNumber: issue, result: { comment: 1, turn: 'turn-1', outcome: 'answer' } });
  });

  it('is idempotent: a second poll re-lists the issue, skips the bot comment and posts nothing', async () => {
    const f = fixture();
    const issue = openTicket(f);
    const opened = (await f.github.getIssue(issue)).updatedAt;
    await f.loop.poll();
    // The bot's own comment and label moved updatedAt, so the issue is listed once more.
    const updated = (await f.github.getIssue(issue)).updatedAt;
    expect(Date.parse(updated)).toBeGreaterThan(Date.parse(opened));

    const again = await f.loop.poll();

    expect(again).toMatchObject({ issues: 1, handled: [], errors: [], since: updated });
    expect(f.calls).toHaveLength(1);
    expect(await botComments(f, issue)).toHaveLength(1);
    expect(sinceArgs(f)).toEqual([undefined, opened]);
    expect(f.state.get(ISSUES_SINCE_KEY)).toBe(updated);
  });

  it('falls back to the login map and skips issues with no merchant', async () => {
    const f = fixture();
    const byLogin = f.github.openIssue({ title: 'Вопрос', body: 'Можно ли отложить заказ?', author: 'Velo-Dvor', labels: ['support'] }).number;
    const stranger = f.github.openIssue({ title: 'Вопрос', body: formBody('Лаванда', 'Привет'), author: 'stranger', labels: ['support'] }).number;

    const result = await f.loop.poll();

    expect(result.errors).toEqual([]);
    expect(result.handled.map((event) => [event.issue, event.action])).toEqual([
      [byLogin, 'answer'],
      [stranger, 'skipped'],
    ]);
    expect(f.state.threadByIssue(byLogin)?.customer).toBe('velo_dvor');
    expect(f.calls[0]?.thread.events[0]?.content).toBe('Вопрос\n\nМожно ли отложить заказ?');
    expect(f.state.threadByIssue(stranger)).toBeUndefined();
    expect(f.state.processed(githubIds.issue(stranger))?.result).toEqual({ skipped: expect.stringMatching(/no merchant/) });
    expect(await botComments(f, stranger)).toEqual([]);

    f.github.commentAs(stranger, 'stranger', 'Ау?');
    const again = await f.loop.poll();
    expect(again.handled).toEqual([{ githubId: 'comment:2', issue: stranger, action: 'skipped', detail: 'the issue has no thread' }]);
    expect(f.calls).toHaveLength(1);
  });

  it('records an issue that is already closed without answering it, then consolidates it', async () => {
    const f = fixture();
    const issue = openTicket(f);
    f.github.closeIssue(issue);

    const result = await f.loop.poll();

    expect(f.calls).toEqual([]);
    expect(result.handled.map((event) => event.action)).toEqual(['skipped', 'close']);
    expect(f.state.threadByIssue(issue)?.closedAt).toBe(WALL);
    expect(f.engine.consolidations).toHaveLength(1);
    expect(f.engine.consolidations[0]?.thread.events.map((event) => event.type)).toEqual(['customer_message']);
    expect(await botComments(f, issue)).toEqual(['Консолидация: новых заметок нет (событий: 1).']);
  });
});

describe('LiveLoop: comments', () => {
  it('asks, answers the merchant follow-up and swaps the agent labels', async () => {
    const f = fixture();
    const issue = openTicket(f);
    f.script.push(turn({ outcome: 'ask', reply: 'Уточните режим оплаты.' }));
    await f.loop.poll();
    expect((await f.github.getIssue(issue)).labels).toEqual(['support', 'agent:asked']);

    f.github.commentAs(issue, MERCHANT, 'Двухстадийная.');
    f.script.push(turn({ reply: 'Тогда заказ подождёт.' }));
    const result = await f.loop.poll();

    expect(result.handled).toEqual([{ githubId: 'comment:2', issue, action: 'answer', comment: 3, detail: '0.0 s, $0.0010' }]);
    expect(f.calls[1]?.thread.events.map((event) => [event.type, event.content])).toEqual([
      ['customer_message', 'Импорт CSV\n\nПосле импорта пропали 37 строк.'],
      ['agent_reply', 'Уточните режим оплаты.'],
      ['customer_message', 'Двухстадийная.'],
    ]);
    expect((await f.github.getIssue(issue)).labels).toEqual(['support', 'agent:answered']);
    expect(await botComments(f, issue)).toEqual(['Уточните режим оплаты.', 'Тогда заказ подождёт.']);
  });

  it('records a human reply without a turn and leaves the issue with the human', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    f.github.commentAs(issue, HUMAN, 'Посмотрю файл, отвечу через час.');

    const result = await f.loop.poll();

    expect(result.handled).toEqual([{ githubId: 'comment:2', issue, action: 'human_reply' }]);
    expect(f.calls).toHaveLength(1);
    expect(f.state.events(threadIdFor(issue)).at(-1)).toMatchObject({
      type: 'human_reply',
      author: HUMAN,
      content: 'Посмотрю файл, отвечу через час.',
      githubId: 'comment:2',
    });
    expect(await botComments(f, issue)).toHaveLength(1);
  });

  it('escalates once: label, assignees, and no further posts even when the merchant writes again', async () => {
    const f = fixture();
    const issue = openTicket(f);
    f.script.push(turn({ outcome: 'escalate', reply: 'Передаю инженеру.', escalationReason: 'Потеря данных при импорте.' }));
    await f.loop.poll();

    const escalated = await f.github.getIssue(issue);
    expect(escalated.labels).toEqual(['support', 'escalated']);
    expect(escalated.assignees).toEqual([HUMAN]);

    f.github.commentAs(issue, MERCHANT, 'Это срочно!');
    const result = await f.loop.poll();

    expect(result.handled).toEqual([
      { githubId: 'comment:2', issue, action: 'skipped', detail: 'escalated: recorded, the human answers' },
    ]);
    expect(f.calls).toHaveLength(1);
    expect(f.state.events(threadIdFor(issue)).map((event) => event.type)).toEqual([
      'customer_message',
      'agent_reply',
      'customer_message',
    ]);
    expect(await botComments(f, issue)).toEqual(['Передаю инженеру.']);
  });
});

describe('LiveLoop: human commands', () => {
  it('/coach files the note, reacts, minimizes, consolidates and comments', async () => {
    const f = fixture();
    const issue = openTicket(f);
    f.script.push(turn({ outcome: 'escalate', reply: 'Передаю инженеру.', escalationReason: 'Импорт.' }));
    await f.loop.poll();
    const coach = f.github.commentAs(issue, HUMAN, '/coach product Причина — BOM в заголовке; фикс в релизе 12.09.');

    const result = await f.loop.poll();

    expect(result.errors).toEqual([]);
    expect(result.handled).toEqual([
      { githubId: `comment:${coach.id}`, issue, action: 'coach', comment: 3, detail: '3 event(s), 1 note(s)' },
    ]);
    expect(f.state.events(threadIdFor(issue)).at(-1)).toMatchObject({
      type: 'coach_note',
      author: HUMAN,
      scope: 'product',
      content: 'Причина — BOM в заголовке; фикс в релизе 12.09.',
      githubId: `comment:${coach.id}`,
    });
    expect(f.github.reactions).toEqual([{ commentId: coach.id, reaction: COACH_REACTION }]);
    expect(f.github.minimized.get(coach.nodeId)).toBe('OUTDATED');
    expect(f.engine.consolidations[0]?.thread.events.map((event) => event.type)).toEqual([
      'customer_message',
      'agent_reply',
      'coach_note',
    ]);
    expect(await botComments(f, issue)).toEqual([
      'Передаю инженеру.',
      'Консолидация: записано заметок — 1.\n- [undocumented, shared] Причина — BOM в заголовке; фикс в релизе 12.09.',
    ]);
    expect(f.state.processed(`comment:${coach.id}`)?.result).toEqual({ comment: 3, events: 3, wrote: 1 });
    expect(f.state.threadByIssue(issue)?.consolidatedEvents).toBe(3);
  });

  it('/coach without product stays customer-scoped and is allowed after the issue closed', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    f.github.closeIssue(issue);
    await f.loop.poll();
    expect(f.state.threadByIssue(issue)?.closedAt).toBeDefined();

    f.github.commentAs(issue, HUMAN, '/coach Клиент грузит CSV из 1С.');
    const result = await f.loop.poll();

    expect(result.handled.map((event) => event.action)).toEqual(['coach']);
    expect(f.state.events(threadIdFor(issue)).at(-1)).toMatchObject({ type: 'coach_note', scope: 'customer' });
    // Under write: both the engine sees the whole transcript again and dedups on its side.
    expect(f.engine.consolidations.at(-1)?.thread.events.map((event) => event.type)).toEqual([
      'customer_message',
      'agent_reply',
      'coach_note',
    ]);
    expect(f.engine.consolidations.at(-1)?.thread.closedAt).toBe(WALL);
  });

  it('/clock moves the session clock forward only; later events carry the jumped date', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();

    f.github.commentAs(issue, HUMAN, '/clock 2026-09-13T09:00:00Z');
    const forward = await f.loop.poll();
    expect(forward.handled).toEqual([{ githubId: 'comment:2', issue, action: 'clock', detail: '2026-09-13T09:00:00.000Z' }]);
    expect(f.session.now()).toBe('2026-09-13T09:00:00.000Z');

    f.github.commentAs(issue, HUMAN, '/clock 2026-09-01T00:00:00Z');
    const back = await f.loop.poll();
    expect(back.handled).toEqual([{ githubId: 'comment:3', issue, action: 'skipped', detail: expect.stringMatching(/forward only/) }]);
    expect(f.session.now()).toBe('2026-09-13T09:00:00.000Z');

    f.github.commentAs(issue, MERCHANT, 'Ещё вопрос.');
    await f.loop.poll();
    expect(f.calls[1]?.now).toBe('2026-09-13T09:00:00.000Z');
    expect(f.state.events(threadIdFor(issue)).at(-2)?.at).toBe('2026-09-13T09:00:00.000Z');
    expect(await botComments(f, issue)).toHaveLength(2);
  });

  it('/consolidate consolidates on demand; a malformed command is skipped with the reason', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    f.github.commentAs(issue, HUMAN, '/coach');
    f.github.commentAs(issue, HUMAN, '/consolidate');

    const result = await f.loop.poll();

    expect(result.handled).toEqual([
      { githubId: 'comment:2', issue, action: 'skipped', detail: '/coach: the note text is missing' },
      { githubId: 'comment:3', issue, action: 'consolidate', comment: 4, detail: '2 event(s), 0 note(s)' },
    ]);
    expect(f.engine.consolidations).toHaveLength(1);
    expect(f.state.events(threadIdFor(issue)).map((event) => event.type)).toEqual(['customer_message', 'agent_reply']);
  });
});

describe('LiveLoop: closing', () => {
  it('closes the thread and consolidates, commenting only when there was something new', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    f.github.closeIssue(issue);

    const closed = await f.loop.poll();

    expect(closed.handled).toEqual([{ githubId: 'close:1', issue, action: 'close', comment: 2, detail: '2 event(s), 0 note(s)' }]);
    expect(f.state.threadByIssue(issue)?.closedAt).toBe(WALL);
    expect(f.engine.consolidations[0]?.thread.closedAt).toBe(WALL);

    const quiet = fixture();
    const other = openTicket(quiet);
    await quiet.loop.poll();
    quiet.github.commentAs(other, HUMAN, '/consolidate');
    await quiet.loop.poll();
    quiet.github.closeIssue(other);
    const result = await quiet.loop.poll();
    expect(result.handled).toEqual([{ githubId: 'close:1', issue: other, action: 'close', detail: '0 event(s), 0 note(s)' }]);
    expect(quiet.engine.consolidations).toHaveLength(1);
    expect(await botComments(quiet, other)).toHaveLength(2);

    quiet.github.commentAs(other, MERCHANT, 'Спасибо!');
    quiet.github.commentAs(other, HUMAN, 'Пожалуйста.');
    const afterClose = await quiet.loop.poll();
    expect(afterClose.handled.map((event) => [event.action, event.detail])).toEqual([
      ['skipped', 'the thread is closed'],
      ['skipped', 'the thread is closed'],
    ]);
  });
});

describe('LiveLoop: failures and recovery', () => {
  it('retries an agent that does not finish on the next two polls, then labels agent:failed', async () => {
    const f = fixture();
    const issue = openTicket(f);
    const opened = (await f.github.getIssue(issue)).updatedAt;
    for (let attempt = 0; attempt < MAX_TURN_ATTEMPTS; attempt += 1) {
      f.script.push(new AgentDidNotFinishError(8, 'length'));
    }

    const first = await f.loop.poll();
    expect(first.handled).toEqual([]);
    expect(first.errors).toEqual([{ issue, message: expect.stringMatching(/attempt 1 of 3.*nothing posted/) }]);
    expect(first.since).toBe(opened);
    expect(f.state.isProcessed('issue:1')).toBe(false);

    const second = await f.loop.poll();
    expect(second.errors[0]?.message).toMatch(/attempt 2 of 3/);
    expect(sinceArgs(f)).toEqual([undefined, opened]);

    const third = await f.loop.poll();
    expect(third.errors).toEqual([]);
    expect(third.handled).toEqual([{ githubId: 'issue:1', issue, action: 'failed', detail: expect.stringMatching(/did not call finish/) }]);
    expect((await f.github.getIssue(issue)).labels).toEqual(['support', 'agent:failed']);
    expect(f.state.processed('issue:1')?.result).toMatchObject({ attempts: 3 });
    expect(f.state.get('attempts:issue:1')).toBeUndefined();
    expect(await botComments(f, issue)).toEqual([]);

    await f.loop.poll();
    expect(f.calls).toHaveLength(MAX_TURN_ATTEMPTS);
  });

  it('posts a reply recorded before a crash without calling the agent again', async () => {
    const f = fixture();
    const issue = openTicket(f);
    // The previous process got as far as the turn and died before createComment.
    f.session.customerMessage({
      thread: threadIdFor(issue),
      customer: 'dom_i_sad',
      content: 'Импорт CSV\n\nПосле импорта пропали 37 строк.',
      githubId: githubIds.issue(issue),
      issueNumber: issue,
    });
    await f.session.agentTurn(threadIdFor(issue));
    expect(f.calls).toHaveLength(1);

    const result = await f.loop.poll();

    expect(f.calls).toHaveLength(1);
    expect(result.handled).toEqual([{ githubId: 'issue:1', issue, action: 'answer', comment: 1, detail: '0.0 s, $0.0010' }]);
    expect(await botComments(f, issue)).toEqual(['Ответ агента.']);
    expect(f.state.events(threadIdFor(issue)).at(-1)?.githubId).toBe('comment:1');
    expect(f.log.some((line) => /recorded before a restart/.test(line))).toBe(true);
  });

  it('logs an error on one issue, carries on with the others and holds the cursor back', async () => {
    const f = fixture();
    const broken = openTicket(f);
    const fine = openTicket(f, 'ВелоДвор', 'Где настроить зоны?');
    const brokenUpdated = (await f.github.getIssue(broken)).updatedAt;
    f.script.push(new Error('model unavailable'));

    const result = await f.loop.poll();

    expect(result.errors).toEqual([{ issue: broken, message: 'model unavailable' }]);
    expect(result.handled).toEqual([{ githubId: 'issue:2', issue: fine, action: 'answer', comment: 1, detail: '0.0 s, $0.0010' }]);
    expect(result.since).toBe(brokenUpdated);
    expect(f.log).toContain(`#${broken}: model unavailable; will retry next poll`);

    const retry = await f.loop.poll();
    expect(retry.errors).toEqual([]);
    expect(retry.handled).toEqual([{ githubId: 'issue:1', issue: broken, action: 'answer', comment: 2, detail: '0.0 s, $0.0010' }]);
    expect(retry.since).toBe((await f.github.getIssue(fine)).updatedAt);
  });

  it('keeps the comment even when labelling fails afterwards', async () => {
    const f = fixture();
    const issue = openTicket(f);
    const addLabels = f.github.addLabels.bind(f.github);
    f.github.addLabels = async () => {
      throw new Error('labels are read-only today');
    };

    const result = await f.loop.poll();

    expect(result.errors).toEqual([]);
    expect(result.handled[0]).toMatchObject({ action: 'answer', comment: 1 });
    expect(f.state.isProcessed('issue:1')).toBe(true);
    expect(f.log).toContain(`#${issue}: comment posted but labels not applied: labels are read-only today`);
    f.github.addLabels = addLabels;
  });
});

describe('LiveLoop: opening proposal pull requests', () => {
  function candidate(overrides: Partial<MemoryItem> = {}): MemoryItem {
    return note({
      id: 'notes-1',
      about: 'product',
      scope: 'shared',
      statement: 'По состоянию на 2026-09-06: BOM ломает заголовок sku, строка исчезает из отчёта.',
      documentationCandidate: true,
      ...overrides,
    });
  }

  /** A coach note is the on-camera trigger: it consolidates and opens the proposals. */
  async function coach(f: Fixture, issue: number, text = '/coach product BOM ломает заголовок.'): Promise<PollResult> {
    f.github.commentAs(issue, HUMAN, text);
    return f.loop.poll();
  }

  function pulls(f: Fixture): Promise<Awaited<ReturnType<FakeGithubClient['listPullRequests']>>> {
    return f.github.listPullRequests({ headPrefix: PROPOSAL_BRANCH_PREFIX, state: 'all' });
  }

  it('opens one pull request per new candidate, records it and links it from the comment', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    f.engine.proposalItems = [candidate({ source: { thread: threadIdFor(issue), via: 'consolidate' } })];

    f.github.commentAs(issue, HUMAN, '/coach product BOM ломает заголовок.');
    const result = await f.loop.poll();

    const [pull] = await pulls(f);
    expect(result.errors).toEqual([]);
    expect(result.handled).toEqual([
      { githubId: 'comment:2', issue, action: 'coach', comment: 3, proposals: [pull?.number], detail: '3 event(s), 1 note(s), 1 PR(s)' },
    ]);
    expect(f.chooserCalls.map((item) => item.id)).toEqual(['notes-1']);
    expect(pull).toMatchObject({
      title: 'wiki: BOM ломает заголовок sku',
      headRef: `${PROPOSAL_BRANCH_PREFIX}notes-1`,
      baseRef: 'main',
      labels: ['proposal'],
      state: 'open',
    });
    expect(pull?.body).toContain(`#${issue}`);
    expect(pull?.body).toContain('<!-- proposal: item=notes-1 page=help -->');

    // The branch holds the page from `main` plus exactly the section a merged update writes.
    const [committed] = f.github.files(`${PROPOSAL_BRANCH_PREFIX}notes-1`).filter((file) => file.path === 'wiki/help.md');
    const addition = wikiUpdateSection(f.engine.proposalItems[0]!.statement, WALL);
    expect(committed?.content).toBe(`${WIKI_PAGE('Исходный текст.').trimEnd()}\n\n${addition}\n`);
    expect(f.github.files().find((file) => file.path === 'wiki/help.md')?.content).toBe(WIKI_PAGE('Исходный текст.'));

    expect(f.state.proposal('notes-1')).toMatchObject({
      pullNumber: pull?.number,
      branch: `${PROPOSAL_BRANCH_PREFIX}notes-1`,
      page: 'help',
      sourceThread: threadIdFor(issue),
      status: 'open',
    });
    expect(f.state.processed('comment:2')?.result).toMatchObject({ comment: 3, proposals: [pull?.number] });
    expect((await botComments(f, issue)).at(-1)).toContain(`Предложения в документацию: #${pull?.number} (help)`);
    expect(f.log).toContain(`#${issue}: proposal notes-1 → PR #${pull?.number} on \`help\` ($0.0002)`);
  });

  it('opens nothing for a candidate that already has a pull request', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    f.engine.proposalItems = [candidate({ source: { thread: threadIdFor(issue), via: 'consolidate' } })];
    await coach(f, issue);
    f.github.calls.length = 0;

    f.github.commentAs(issue, HUMAN, '/consolidate');
    const result = await f.loop.poll();
    // The one listing of this poll follows the open proposal; opening proposals listed nothing.
    const methods = f.github.calls.map((call) => call.method);

    expect(result.errors).toEqual([]);
    expect(result.handled[0]).toMatchObject({ action: 'consolidate', detail: '0 event(s), 0 note(s)' });
    expect(result.handled[0]?.proposals).toBeUndefined();
    expect(await pulls(f)).toHaveLength(1);
    expect(f.chooserCalls).toHaveLength(1);
    expect(methods).toEqual(['listPullRequests', 'listIssues', 'listComments', 'createComment']);
  });

  it('trusts the engine about what a candidate is and keeps a human edit made on main', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    // A customer-scoped row: the engine decides what `proposals()` serves, the loop does not re-filter.
    f.engine.proposalItems = [candidate({
      about: 'dom_i_sad',
      scope: 'customer',
      source: { thread: threadIdFor(issue), via: 'consolidate' },
    })];
    f.github.writeFile('wiki/help.md', WIKI_PAGE('Исходный текст.\n\n## Правка человека\n\nДобавлено вручную.'));

    await coach(f, issue);

    const branch = `${PROPOSAL_BRANCH_PREFIX}notes-1`;
    const committed = f.github.files(branch).find((file) => file.path === 'wiki/help.md')?.content ?? '';
    expect(committed).toContain('## Правка человека\n\nДобавлено вручную.');
    expect(committed.endsWith(`${wikiUpdateSection(f.engine.proposalItems[0]!.statement, WALL)}\n`)).toBe(true);
    expect(await pulls(f)).toHaveLength(1);
  });

  it('adopts a pull request opened before a crash and restarts a branch left without one', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    f.engine.proposalItems = [
      candidate({ id: 'notes-1', source: { thread: threadIdFor(issue), via: 'consolidate' } }),
      candidate({ id: 'notes-2', source: { thread: threadIdFor(issue), via: 'consolidate' } }),
    ];
    // notes-1: the pull request exists, the state row does not (a crash between the two).
    const crashed = `${PROPOSAL_BRANCH_PREFIX}notes-1`;
    await f.github.createBranch(crashed);
    await f.github.commitFile({ branch: crashed, path: 'wiki/help.md', content: WIKI_PAGE('Исходный текст.\n\nПредложение.'), message: 'wiki' });
    const orphan = await f.github.createPullRequest({
      head: crashed,
      title: 'wiki: BOM',
      body: `Тело без ссылок.\n\n<!-- proposal: item=notes-1 page=help -->`,
    });
    // notes-2: only the branch survived, so it is recreated from today's main.
    await f.github.createBranch(`${PROPOSAL_BRANCH_PREFIX}notes-2`);
    f.github.writeFile('wiki/help.md', WIKI_PAGE('Исходный текст с правкой.'));

    await coach(f, issue);

    expect((await pulls(f)).map((pull) => pull.number)).toEqual([orphan.number, orphan.number + 1]);
    expect(f.state.proposal('notes-1')).toMatchObject({ pullNumber: orphan.number, page: 'help', status: 'open' });
    expect(f.chooserCalls.map((item) => item.id)).toEqual(['notes-2']);
    expect(f.log).toContain(`proposal notes-1: adopted #${orphan.number} opened on ${crashed} before a restart`);
    expect(f.log).toContain(`branch ${PROPOSAL_BRANCH_PREFIX}notes-2 left by an earlier attempt was recreated from main`);
    expect(f.github.files(`${PROPOSAL_BRANCH_PREFIX}notes-2`).find((file) => file.path === 'wiki/help.md')?.content)
      .toContain('Исходный текст с правкой.');
  });

  it('adopts a pull request whose body lost the marker by looking at what its branch changed', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    f.engine.proposalItems = [candidate({ source: { thread: threadIdFor(issue), via: 'consolidate' } })];
    const branch = `${PROPOSAL_BRANCH_PREFIX}notes-1`;
    await f.github.createBranch(branch);
    await f.github.commitFile({ branch, path: 'wiki/dostavka.md', content: WIKI_PAGE('Зоны доставки. И ещё.', 'dostavka', 'Доставка'), message: 'wiki' });
    const orphan = await f.github.createPullRequest({ head: branch, title: 'wiki', body: 'Человек переписал описание.' });

    await coach(f, issue);

    expect(f.state.proposal('notes-1')).toMatchObject({ pullNumber: orphan.number, page: 'dostavka' });
    expect(await pulls(f)).toHaveLength(1);
    expect(f.chooserCalls).toEqual([]);
  });

  it('reports a chooser failure, still comments, and opens the pull request next time', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    f.engine.proposalItems = [candidate({ source: { thread: threadIdFor(issue), via: 'consolidate' } })];
    f.pageChoices.push(new Error('model unavailable'));

    const result = await coach(f, issue);

    expect(result.errors).toEqual([{ issue, message: 'proposal for notes-1 not opened: model unavailable' }]);
    expect(result.handled[0]).toMatchObject({ action: 'coach', comment: 3 });
    expect(result.handled[0]?.proposals).toBeUndefined();
    expect(await pulls(f)).toEqual([]);
    expect(f.state.proposal('notes-1')).toBeUndefined();
    expect((await botComments(f, issue)).at(-1)).not.toContain('Предложения в документацию');

    f.github.commentAs(issue, HUMAN, '/consolidate');
    const retried = await f.loop.poll();

    expect(retried.errors).toEqual([]);
    expect((await pulls(f)).map((pull) => pull.headRef)).toEqual([`${PROPOSAL_BRANCH_PREFIX}notes-1`]);
    expect(f.state.proposal('notes-1')?.status).toBe('open');
  });

  it('keeps the consolidation comment when the pull requests cannot be listed', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    f.engine.proposalItems = [candidate({ source: { thread: threadIdFor(issue), via: 'consolidate' } })];
    const listPullRequests = f.github.listPullRequests.bind(f.github);
    f.github.listPullRequests = async () => {
      throw new Error('GitHub is down');
    };

    const result = await coach(f, issue);
    f.github.listPullRequests = listPullRequests;

    expect(result.errors).toEqual([{ issue, message: 'proposal pull requests not listed: GitHub is down' }]);
    expect(result.handled[0]).toMatchObject({ action: 'coach', comment: 3, detail: '3 event(s), 1 note(s)' });
    expect(f.chooserCalls).toEqual([]);
    expect(f.state.proposal('notes-1')).toBeUndefined();
    expect((await botComments(f, issue)).at(-1)).toContain('Консолидация: записано заметок');
    expect(f.log).toContain(
      `#${issue}: proposal pull requests not listed: GitHub is down; proposals will be opened at the next consolidation`,
    );

    f.github.commentAs(issue, HUMAN, '/consolidate');
    await f.loop.poll();
    expect((await pulls(f)).map((pull) => pull.headRef)).toEqual([`${PROPOSAL_BRANCH_PREFIX}notes-1`]);
  });

  it('proposes what the agent wrote about the product under write: agent, and merging it updates the wiki', async () => {
    const f = fixture({ write: 'agent' }, { render: 'default', leakPattern: 'readme' });
    const issue = openTicket(f);
    f.script.push(turn({
      memoryWrites: [candidate({
        id: 'agent-issue-1-turn-1-1',
        source: { thread: threadIdFor(issue), step: 'turn-1', via: 'agent' },
      })],
    }));
    await f.loop.poll();
    expect(await pulls(f)).toEqual([]);

    f.github.commentAs(issue, HUMAN, '/consolidate');
    await f.loop.poll();

    const [pull] = await pulls(f);
    expect(pull?.headRef).toBe(`${PROPOSAL_BRANCH_PREFIX}agent-issue-1-turn-1-1`);
    expect(pull?.body).toContain('**Почему эта страница:** Страница про импорт каталога.');
    expect(pull?.body).toContain('заметка `agent-issue-1-turn-1-1`');
    // The leak grep of the repository README runs on the addition and warns without blocking.
    expect(pull?.body).toContain('совпадения — `BOM`');

    f.github.mergePullRequest(pull!.number);
    await f.loop.poll();

    expect(f.state.proposal('agent-issue-1-turn-1-1')?.status).toBe('merged');
    expect(f.session.wiki.readPage('help')).toContain('BOM ломает заголовок sku');
    expect((await botComments(f, issue)).at(-1)).toContain('Документация обновлена');
  });
});

describe('LiveLoop: proposal pull requests merged by a human', () => {
  async function proposal(f: Fixture, itemId: string, page: string, sourceThread: string, text: string): Promise<number> {
    const branch = `${PROPOSAL_BRANCH_PREFIX}${itemId}`;
    await f.github.createBranch(branch);
    await f.github.commitFile({ branch, path: `wiki/${page}.md`, content: WIKI_PAGE(text), message: 'wiki: proposal' });
    const pull = await f.github.createPullRequest({ head: branch, title: `wiki: ${itemId}`, body: 'proposal' });
    f.state.recordProposal({ itemId, pullNumber: pull.number, branch, page, sourceThread });
    return pull.number;
  }

  it('reloads the wiki from main and comments on the source issue when a proposal merges', async () => {
    const f = fixture();
    const issue = openTicket(f);
    await f.loop.poll();
    const merged = await proposal(f, 'bom', 'help', threadIdFor(issue), 'Исходный текст.\n\n## Обновление от 2026-09-06\n\nBOM ломает заголовок.');
    const dropped = await proposal(f, 'other', 'help', threadIdFor(issue), 'Другой текст.');
    f.github.calls.length = 0;

    const untouched = await f.loop.poll();
    expect(untouched.handled).toEqual([]);
    expect(f.github.calls.map((call) => call.method)).toEqual(['listPullRequests', 'listIssues', 'listComments']);

    f.github.mergePullRequest(merged);
    await f.github.closePullRequest(dropped);
    const result = await f.loop.poll();

    expect(result.errors).toEqual([]);
    expect(result.handled).toEqual([
      { githubId: `pr:${merged}:merged`, issue, action: 'wiki_update', comment: 2, detail: 'help' },
    ]);
    expect(f.session.wiki.readPage('help')).toContain('BOM ломает заголовок.');
    expect(await botComments(f, issue)).toEqual(['Ответ агента.', `Документация обновлена: страница \`help\` (#${merged}).`]);
    expect(f.state.proposal('bom')?.status).toBe('merged');
    expect(f.state.proposal('other')?.status).toBe('closed');
    expect(f.state.processed(`pr:${merged}:merged`)?.result).toEqual({ comment: 2, page: 'help' });

    f.github.calls.length = 0;
    await f.loop.poll();
    expect(f.github.calls.map((call) => call.method)).toEqual(['listIssues', 'listComments']);
  });
});

describe('LiveLoop: rendering and the memory issue', () => {
  function repaints(f: Fixture): number {
    return f.github.calls.filter((call) => call.method === 'updateIssueBody').length;
  }

  it('posts the reply with the collapsed trace by default and links the memory issue', async () => {
    const f = fixture({}, { render: 'default', memoryIssue: 1 });
    f.github.openIssue({ title: 'Память агента', author: HUMAN });
    const issue = openTicket(f);
    f.script.push(turn({
      trace: [
        { step: 1, toolCalls: [{ tool: 'read_page', input: { slug: 'help' }, output: 'Исходный текст.' }], usage: ZERO_USAGE },
        { step: 2, toolCalls: [{ tool: 'finish', input: {} }], usage: ZERO_USAGE },
      ],
    }));

    await f.loop.poll();

    const [comment] = await botComments(f, issue);
    expect(comment?.startsWith(`Ответ агента.\n\n<details>\n<summary>${TRACE_SUMMARY}</summary>\n\n`)).toBe(true);
    expect(comment).toContain('- **Итог:** ответил сам.');
    expect(comment).toContain('- **База знаний:** читал «Помощь» (`help`).');
    expect(comment).toContain('- **Вспомнил из памяти** (в промпте): подходящих заметок нет.');
    expect(comment).toContain('- **Вся память агента:** #1');
    expect(comment?.endsWith('\n</details>')).toBe(true);
  });

  it('repaints the memory issue after agent writes, consolidation writes and clock moves, and only then', async () => {
    const f = fixture({}, { memoryIssue: 1 });
    const memory = f.github.openIssue({ title: 'Память агента', author: HUMAN }).number;
    const issue = openTicket(f);
    f.script.push(turn({ memoryWrites: [note({ id: 'w1', kind: 'personal', statement: 'Оплата двухстадийная.' })] }));

    await f.loop.poll();
    expect(repaints(f)).toBe(1);
    expect((await f.github.getIssue(memory)).body).toBe(
      '- [personal, customer, dom_i_sad] По состоянию на 2026-09-06: Оплата двухстадийная.',
    );
    expect(f.log).toContain(`memory issue #${memory} repainted after #${issue} turn-1: 1 note(s)`);

    f.github.commentAs(issue, MERCHANT, 'Спасибо.');
    await f.loop.poll();
    expect(repaints(f)).toBe(1);

    f.github.commentAs(issue, HUMAN, '/coach product BOM ломает заголовок.');
    await f.loop.poll();
    expect(repaints(f)).toBe(2);
    expect((await f.github.getIssue(memory)).body.split('\n')).toEqual([
      '- [personal, customer, dom_i_sad] По состоянию на 2026-09-06: Оплата двухстадийная.',
      '- [undocumented, shared, dom_i_sad] BOM ломает заголовок.',
    ]);

    f.github.commentAs(issue, HUMAN, '/consolidate');
    await f.loop.poll();
    expect(repaints(f)).toBe(2);

    f.github.commentAs(issue, HUMAN, '/clock 2026-09-07T10:00:00Z');
    await f.loop.poll();
    expect(repaints(f)).toBe(3);
    expect(f.log).toContain(`memory issue #${memory} repainted after the clock move: 2 note(s)`);
  });

  it('does nothing without memory_issue, logs a failed repaint, and never handles the memory issue as a ticket', async () => {
    const unset = fixture();
    openTicket(unset);
    unset.script.push(turn({ memoryWrites: [note()] }));
    await unset.loop.poll();
    expect(repaints(unset)).toBe(0);

    const missing = fixture({}, { memoryIssue: 99 });
    const issue = openTicket(missing);
    missing.script.push(turn({ memoryWrites: [note()] }));
    const result = await missing.loop.poll();
    expect(result.errors).toEqual([]);
    expect(result.handled.map((event) => event.action)).toEqual(['answer']);
    expect(missing.log.some((line) => line.startsWith(`memory issue #99 not repainted after #${issue} turn-1:`))).toBe(true);

    const labelled = fixture({}, { memoryIssue: 1 });
    labelled.github.openIssue({ title: 'Память агента', author: HUMAN, labels: ['support'] });
    const ticket = openTicket(labelled);
    const polled = await labelled.loop.poll();
    expect(polled.issues).toBe(2);
    expect(polled.handled.map((event) => event.issue)).toEqual([ticket]);
    expect(await botComments(labelled, 1)).toEqual([]);
    expect(labelled.state.threadByIssue(1)).toBeUndefined();
  });
});

describe('LiveLoop.run', () => {
  it('polls, sleeps for poll_seconds and stops when aborted', async () => {
    const f = fixture();
    const controller = new AbortController();
    const sleeps: number[] = [];
    const loop = new LiveLoop({
      session: f.session,
      github: f.github,
      config: LIVE_CONFIG,
      log: (line) => {
        f.log.push(line);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) controller.abort();
      },
    });

    await loop.run(controller.signal);

    expect(sleeps).toEqual([1000, 1000]);
    expect(f.github.calls.filter((call) => call.method === 'listIssues')).toHaveLength(2);
    expect(f.log[0]).toBe('polling CrazyClicker/memorybot for "support" every 1 s');
    expect(f.log.at(-1)).toBe('stopped');
  });

  it('survives a poll that throws as a whole', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.github.listIssues = async () => {
      throw new Error('GitHub is down');
    };
    const loop = new LiveLoop({
      session: f.session,
      github: f.github,
      config: LIVE_CONFIG,
      log: (line) => {
        f.log.push(line);
      },
      sleep: async () => {
        controller.abort();
      },
    });
    await loop.run(controller.signal);
    expect(f.log).toContain('poll failed: GitHub is down');
  });

  it('abortableSleep resolves early on abort', async () => {
    const controller = new AbortController();
    const started = performance.now();
    const sleeping = abortableSleep(10_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(performance.now() - started).toBeLessThan(1_000);
    await abortableSleep(1);
    const aborted = new AbortController();
    aborted.abort();
    await abortableSleep(10_000, aborted.signal);
  });
});
