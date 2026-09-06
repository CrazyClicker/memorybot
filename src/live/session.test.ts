import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentDidNotFinishError, type TurnInput, type TurnResult } from '../agent/index.ts';
import type { Config } from '../evals/schema.ts';
import type { RunAgent } from '../evals/runner.ts';
import { ZERO_USAGE } from '../llm/index.ts';
import {
  cloneMemoryItem,
  type MemoryEngine,
  type MemoryEngineUsage,
  type MemoryItem,
  NotesMemoryEngine,
  type ThreadTranscript,
} from '../memory/index.ts';
import { Wiki } from '../wiki/index.ts';
import {
  ClockMovesForwardOnlyError,
  createSessionEngine,
  openSession,
  Session,
  SessionTurnSchema,
  wikiPagesFromFiles,
} from './session.ts';
import { LiveState } from './state.ts';

const WALL = '2026-09-06T10:00:00.000Z';
const DAY = '2026-09-06';

const CUSTOMERS = {
  dom_i_sad: { name: 'Дом и сад', profile: 'Магазин товаров для дома.' },
  velo_dvor: { name: 'ВелоДвор' },
};

function config(overrides: Partial<Config['memory']> = {}): Config {
  return {
    id: 'test-config',
    agent: { provider: 'openai', model: 'gpt-4o-mini', temperature: 0 },
    memory: { engine: 'notes', read: 'both', write: 'both', ...overrides },
    judge: { provider: 'anthropic', model: 'claude-sonnet-5' },
  };
}

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'shared-memory',
    kind: 'temporal',
    about: 'product',
    learnedFrom: 'velo_dvor',
    scope: 'shared',
    statement: `По состоянию на ${DAY}: Общий факт.`,
    validUntil: '2026-09-07',
    source: { thread: 'old-thread', via: 'consolidate' },
    createdAt: WALL,
    ...overrides,
  };
}

function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    outcome: 'answer',
    reply: 'Ответ агента.',
    memoryWrites: [],
    trace: [{ step: 1, toolCalls: [{ tool: 'read_page', input: { slug: 'help' } }], usage: ZERO_USAGE }],
    usage: ZERO_USAGE,
    latencyMs: 10,
    costUsd: 0.001,
    ...overrides,
  };
}

class RecordingEngine implements MemoryEngine {
  readonly id = 'recording';
  readonly recalls: Array<{ customer: string; query: string; now: string }> = [];
  readonly writes: Array<{ items: MemoryItem[]; now: string }> = [];
  readonly consolidations: Array<{ thread: ThreadTranscript; now: string }> = [];
  resetCount = 0;
  private cost = 0;
  proposalItems: MemoryItem[] = [];

  async reset(): Promise<void> {
    this.resetCount += 1;
  }

  async recall(customer: string, query: string, now: string): Promise<MemoryItem[]> {
    this.recalls.push({ customer, query, now });
    return [
      item(),
      item({ id: 'private-dom', kind: 'personal', about: 'dom_i_sad', learnedFrom: 'dom_i_sad', scope: 'customer' }),
      // Leaks from another customer must be dropped by the session, whatever the engine does.
      item({ id: 'leak', kind: 'personal', about: 'lavanda', learnedFrom: 'lavanda', scope: 'customer' }),
    ];
  }

  async write(items: MemoryItem[], now: string): Promise<void> {
    this.writes.push({ items: items.map(cloneMemoryItem), now });
  }

  async consolidate(thread: ThreadTranscript, now: string): Promise<MemoryItem[]> {
    this.consolidations.push({ thread: structuredClone(thread), now });
    this.cost += 0.01;
    return thread.events.map((event, index) =>
      item({ id: `consolidated-${this.consolidations.length}-${index + 1}`, statement: event.content, createdAt: now }),
    );
  }

  async proposals(): Promise<MemoryItem[]> {
    return this.proposalItems.map(cloneMemoryItem);
  }

  usage(): MemoryEngineUsage {
    return { usage: ZERO_USAGE, costUsd: this.cost };
  }
}

function wiki(): Wiki {
  return new Wiki(
    [{ slug: 'help', title: 'Помощь', summary: 'Основная справка.', content: 'Исходный текст.' }],
    { search: true },
  );
}

interface Fixture {
  readonly session: Session;
  readonly engine: RecordingEngine;
  readonly state: LiveState;
  readonly calls: Array<{ input: TurnInput; options: Parameters<RunAgent>[1] }>;
  wall: Date;
}

const fixtures: Fixture[] = [];
const tempDirs: string[] = [];

function fixture(
  memory: Partial<Config['memory']> = {},
  runAgent?: RunAgent,
  statePath = ':memory:',
): Fixture {
  const engine = new RecordingEngine();
  const calls: Fixture['calls'] = [];
  const holder = { wall: new Date(WALL) } as Fixture;
  const state = new LiveState({ path: statePath, clock: () => holder.wall });
  const session = new Session({
    config: config(memory),
    engine,
    wiki: wiki(),
    state,
    customers: CUSTOMERS,
    clock: () => holder.wall,
    runAgent: async (input, options) => {
      calls.push({ input, options });
      return runAgent === undefined ? turn() : runAgent(input, options);
    },
  });
  Object.assign(holder, { session, engine, state, calls });
  fixtures.push(holder);
  return holder;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'live-session-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const { session } of fixtures.splice(0)) session.dispose();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------------------------

describe('Session clock (D14)', () => {
  it('is the wall clock plus a stored offset that only moves forward', () => {
    const f = fixture();
    expect(f.session.now()).toBe(WALL);

    expect(f.session.setClock('2026-09-08T18:30:00Z')).toBe('2026-09-08T18:30:00.000Z');
    expect(f.state.clockOffsetMs()).toBe(Date.parse('2026-09-08T18:30:00Z') - Date.parse(WALL));
    f.wall = new Date('2026-09-06T10:05:00Z');
    expect(f.session.now()).toBe('2026-09-08T18:35:00.000Z');

    expect(() => f.session.setClock('2026-09-07T00:00:00Z')).toThrow(ClockMovesForwardOnlyError);
    expect(() => f.session.setClock('yesterday')).toThrow(/ISO timestamp/);
    expect(f.session.now()).toBe('2026-09-08T18:35:00.000Z');
  });
});

describe('Session events', () => {
  it('opens a thread on the first customer message and stamps events with the session clock', () => {
    const f = fixture();
    const first = f.session.customerMessage({
      thread: 'issue-5',
      customer: 'dom_i_sad',
      content: 'Пропали строки.',
      githubId: 'issue:5',
      issueNumber: 5,
    });
    expect(first).toMatchObject({ id: 1, thread: 'issue-5', type: 'customer_message', at: WALL, githubId: 'issue:5' });
    expect(f.session.thread('issue-5')).toMatchObject({ customer: 'dom_i_sad', issueNumber: 5, openedAt: WALL });

    f.session.setClock('2026-09-06T12:00:00Z');
    const reply = f.session.humanReply({ thread: 'issue-5', author: 'CrazyClicker', content: 'Смотрим.', githubId: 'comment:1' });
    const note = f.session.coachNote({ thread: 'issue-5', author: 'CrazyClicker', content: 'BOM.', scope: 'product', githubId: 'comment:2' });
    const dated = f.session.coachNote({ thread: 'issue-5', author: 'CrazyClicker', content: 'Позже.', at: '2026-09-06T13:00:00Z' });
    expect(reply).toMatchObject({ type: 'human_reply', at: '2026-09-06T12:00:00.000Z', author: 'CrazyClicker' });
    expect(note).toMatchObject({ type: 'coach_note', scope: 'product' });
    expect(dated).toMatchObject({ type: 'coach_note', scope: 'customer', at: '2026-09-06T13:00:00Z' });
    expect(f.session.transcript('issue-5').events.map((event) => event.type)).toEqual([
      'customer_message', 'human_reply', 'coach_note', 'coach_note',
    ]);
  });

  it('returns the recorded event for a GitHub id it has seen, without appending', () => {
    const f = fixture();
    const first = f.session.customerMessage({ thread: 'issue-5', customer: 'dom_i_sad', content: 'one', githubId: 'comment:1' });
    const again = f.session.customerMessage({ thread: 'issue-5', customer: 'dom_i_sad', content: 'two', githubId: 'comment:1' });
    expect(again).toEqual(first);
    expect(f.session.humanReply({ thread: 'issue-5', author: 'x', content: 'y', githubId: 'comment:1' })).toEqual(first);
    expect(f.session.coachNote({ thread: 'issue-5', author: 'x', content: 'y', githubId: 'comment:1' })).toEqual(first);
    expect(f.session.transcript('issue-5').events).toHaveLength(1);
  });

  it('keeps the runner rules: one customer per thread, no messages after close, notes allowed', () => {
    const f = fixture();
    f.session.customerMessage({ thread: 'issue-5', customer: 'dom_i_sad', content: 'one' });
    expect(() => f.session.customerMessage({ thread: 'issue-5', customer: 'velo_dvor', content: 'two' }))
      .toThrow(/belongs to "dom_i_sad"/);
    expect(() => f.session.humanReply({ thread: 'nope', author: 'x', content: 'y' })).toThrow(/Unknown thread/);

    expect(f.session.close('issue-5').closedAt).toBe(WALL);
    expect(() => f.session.close('issue-5')).toThrow(/already closed/);
    expect(() => f.session.customerMessage({ thread: 'issue-5', customer: 'dom_i_sad', content: 'x' })).toThrow(/already closed/);
    expect(() => f.session.humanReply({ thread: 'issue-5', author: 'x', content: 'y' })).toThrow(/already closed/);
    expect(f.session.coachNote({ thread: 'issue-5', author: 'x', content: 'after close' }).type).toBe('coach_note');
    expect(f.session.threads().map((thread) => thread.id)).toEqual(['issue-5']);
  });
});

describe('Session.agentTurn', () => {
  it('hydrates, runs the agent with the live recall, records the reply and writes the memory', async () => {
    const f = fixture({}, async (input, options) => {
      expect(input.wiki.readPage('help')).toContain('Исходный текст.');
      const recalled = await options?.recallMemory?.('dom_i_sad', 'запрос из инструмента', input.now);
      expect(recalled?.map((entry) => entry.id)).toEqual(['shared-memory', 'private-dom']);
      return turn({
        outcome: 'escalate',
        reply: 'Передаю инженеру.',
        escalationReason: 'Нужна проверка.',
        memoryWrites: [item({
          id: 'agent-write',
          kind: 'personal',
          about: 'dom_i_sad',
          learnedFrom: 'wrong-customer',
          scope: 'shared',
          statement: 'Импорт из 1С.',
          source: { thread: 'wrong-thread', via: 'consolidate' },
          createdAt: '2020-01-01T00:00:00Z',
        })],
      });
    });
    f.session.customerMessage({ thread: 'issue-5', customer: 'dom_i_sad', content: 'Пропали строки.', issueNumber: 5 });
    f.session.setClock('2026-09-06T11:00:00Z');
    const now = '2026-09-06T11:00:00.000Z';

    const result = await f.session.agentTurn('issue-5');

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.input).toMatchObject({
      now,
      customer: { id: 'dom_i_sad', name: 'Дом и сад', profile: 'Магазин товаров для дома.' },
      thread: { id: 'issue-5', customer: 'dom_i_sad', events: [{ type: 'customer_message', content: 'Пропали строки.' }] },
      memory: [expect.objectContaining({ id: 'shared-memory' }), expect.objectContaining({ id: 'private-dom' })],
      tools: { recallMemory: true, remember: true },
      model: config().agent,
    });
    expect(f.engine.recalls).toEqual([
      { customer: 'dom_i_sad', query: 'Пропали строки.', now },
      { customer: 'dom_i_sad', query: 'запрос из инструмента', now },
    ]);

    expect(SessionTurnSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      id: 'turn-1',
      thread: 'issue-5',
      at: now,
      outcome: 'escalate',
      reply: 'Передаю инженеру.',
      escalationReason: 'Нужна проверка.',
      costUsd: 0.001,
      latencyMs: 10,
    });
    expect(result.recalls.map((recall) => [recall.via, recall.query, recall.returned.length])).toEqual([
      ['hydrate', 'Пропали строки.', 2],
      ['tool', 'запрос из инструмента', 2],
    ]);
    expect(result.responseLatencyMs).toBe(10 + (result.recalls[0]?.latencyMs ?? Number.NaN));
    expect(result.memoryWrites).toEqual([
      expect.objectContaining({
        id: 'agent-issue-5-turn-1-1',
        about: 'dom_i_sad',
        learnedFrom: 'dom_i_sad',
        scope: 'customer',
        statement: `По состоянию на ${DAY}: Импорт из 1С.`,
        source: { thread: 'issue-5', step: 'turn-1', via: 'agent' },
        createdAt: now,
      }),
    ]);
    expect(f.engine.writes).toEqual([{ items: result.memoryWrites, now }]);

    // The reply is on the transcript and the turn is on its event, readable after a restart.
    expect(f.session.transcript('issue-5').events.at(-1)).toEqual({ type: 'agent_reply', at: now, content: 'Передаю инженеру.' });
    expect(f.session.turns('issue-5')).toEqual([result]);
    const replyEvent = f.state.events('issue-5').at(-1);
    expect(replyEvent?.turnId).toBe('turn-1');
    expect(replyEvent?.githubId).toBeUndefined();

    // A follow-up gets the next turn id and sees the whole thread.
    f.session.customerMessage({ thread: 'issue-5', customer: 'dom_i_sad', content: 'Ещё вопрос.' });
    const second = await f.session.agentTurn('issue-5');
    expect(second.id).toBe('turn-2');
    expect(f.calls[1]?.input.thread.events.map((event) => event.type)).toEqual([
      'customer_message', 'agent_reply', 'customer_message',
    ]);
    expect(f.engine.writes[1]?.items.map((entry) => entry.id)).toEqual(['agent-issue-5-turn-2-1']);
  });

  it('follows the config axes: no hydration under read: tool, no remember under write: consolidate', async () => {
    const toolOnly = fixture({ read: 'tool', write: 'consolidate' });
    toolOnly.session.customerMessage({ thread: 't', customer: 'velo_dvor', content: 'q' });
    await toolOnly.session.agentTurn('t');
    expect(toolOnly.calls[0]?.input).toMatchObject({ memory: [], tools: { recallMemory: true, remember: false } });
    expect(toolOnly.engine.recalls).toEqual([]);

    const hydrateOnly = fixture({ read: 'hydrate', write: 'agent' });
    hydrateOnly.session.customerMessage({ thread: 't', customer: 'velo_dvor', content: 'q' });
    const result = await hydrateOnly.session.agentTurn('t');
    expect(hydrateOnly.calls[0]?.input.tools).toEqual({ recallMemory: false, remember: true });
    expect(hydrateOnly.calls[0]?.input.memory.map((entry) => entry.id)).toEqual(['shared-memory']);
    expect(result.recalls.map((recall) => recall.via)).toEqual(['hydrate']);
  });

  it('records nothing when the agent throws, so the loop can retry the same turn', async () => {
    const f = fixture({}, async () => {
      throw new AgentDidNotFinishError(8, 'length');
    });
    f.session.customerMessage({ thread: 't', customer: 'dom_i_sad', content: 'q' });
    await expect(f.session.agentTurn('t')).rejects.toBeInstanceOf(AgentDidNotFinishError);
    expect(f.session.transcript('t').events.map((event) => event.type)).toEqual(['customer_message']);
    expect(f.session.turns('t')).toEqual([]);
    expect(f.engine.writes).toEqual([]);
  });

  it('refuses threads it cannot answer', async () => {
    const f = fixture();
    await expect(f.session.agentTurn('nope')).rejects.toThrow(/Unknown thread/);

    f.session.customerMessage({ thread: 'stranger', customer: 'lavanda', content: 'q' });
    await expect(f.session.agentTurn('stranger')).rejects.toThrow(/Unknown customer "lavanda"/);

    f.session.customerMessage({ thread: 't', customer: 'dom_i_sad', content: 'q' });
    f.session.close('t');
    await expect(f.session.agentTurn('t')).rejects.toThrow(/already closed/);

    f.state.openThread({ id: 'empty', customer: 'dom_i_sad', openedAt: WALL });
    await expect(f.session.agentTurn('empty')).rejects.toThrow(/no customer message/);
    expect(f.calls).toEqual([]);
  });
});

describe('Session.consolidate', () => {
  function story(f: Fixture): void {
    f.session.customerMessage({ thread: 'issue-5', customer: 'dom_i_sad', content: 'Пропали строки.' });
    f.session.humanReply({ thread: 'issue-5', author: 'CrazyClicker', content: 'Смотрим.' });
    f.session.coachNote({ thread: 'issue-5', author: 'CrazyClicker', content: 'BOM.', scope: 'product' });
  }

  it('hands new events to the engine, charges the extraction and advances the watermark', async () => {
    const f = fixture({ write: 'both' });
    story(f);
    f.session.setClock('2026-09-06T12:00:00Z');

    const first = await f.session.consolidate('issue-5');
    expect(first).toMatchObject({ thread: 'issue-5', at: '2026-09-06T12:00:00.000Z', events: 3, costUsd: 0.01 });
    expect(first.wrote.map((entry) => entry.id)).toEqual(['consolidated-1-1', 'consolidated-1-2', 'consolidated-1-3']);
    expect(f.engine.consolidations[0]?.thread.events.map((event) => event.type)).toEqual([
      'customer_message', 'human_reply', 'coach_note',
    ]);
    expect(f.session.thread('issue-5')?.consolidatedEvents).toBe(3);

    // Nothing new: the engine is not called.
    expect(await f.session.consolidate('issue-5')).toEqual({ thread: 'issue-5', at: '2026-09-06T12:00:00.000Z', events: 0, wrote: [] });
    expect(f.engine.consolidations).toHaveLength(1);

    // After close the whole thread goes again with closedAt, as in the runner.
    f.session.coachNote({ thread: 'issue-5', author: 'CrazyClicker', content: 'Починили.' });
    f.session.close('issue-5');
    const second = await f.session.consolidate('issue-5');
    expect(second.events).toBe(1);
    expect(f.engine.consolidations[1]?.thread).toMatchObject({ closedAt: '2026-09-06T12:00:00.000Z' });
    expect(f.engine.consolidations[1]?.thread.events).toHaveLength(4);
  });

  it('reduces the transcript to coach notes under write: agent', async () => {
    const f = fixture({ write: 'agent' });
    story(f);
    await f.session.consolidate('issue-5');
    expect(f.engine.consolidations[0]?.thread.events).toEqual([
      { type: 'coach_note', at: WALL, author: 'CrazyClicker', scope: 'product', content: 'BOM.' },
    ]);
    expect(f.session.thread('issue-5')?.consolidatedEvents).toBe(3);

    f.session.humanReply({ thread: 'issue-5', author: 'CrazyClicker', content: 'Без заметки.' });
    const again = await f.session.consolidate('issue-5');
    expect(again.events).toBe(1);
    expect(f.engine.consolidations[1]?.thread.events).toEqual([]);
  });

  it('propagates an engine failure and leaves the thread pending', async () => {
    const f = fixture();
    story(f);
    f.engine.consolidate = async () => {
      throw new Error('extraction failed');
    };
    await expect(f.session.consolidate('issue-5')).rejects.toThrow('extraction failed');
    expect(f.session.thread('issue-5')?.consolidatedEvents).toBe(0);
    await expect(f.session.consolidate('nope')).rejects.toThrow(/Unknown thread/);
  });
});

describe('Session wiki and proposals', () => {
  it('swaps the wiki snapshot and keeps the search setting', () => {
    const f = fixture();
    const pages = wikiPagesFromFiles([
      { name: 'README.md', content: '# absent facts' },
      { name: 'notes.txt', content: 'not a page' },
      { name: 'dostavka.md', content: '---\nslug: dostavka\ntitle: Доставка\nsummary: Зоны.\n---\nТело.' },
    ]);
    expect(pages).toEqual([{ slug: 'dostavka', title: 'Доставка', summary: 'Зоны.', content: 'Тело.' }]);
    expect(() => wikiPagesFromFiles([
      { name: 'a.md', content: '---\nslug: x\ntitle: A\nsummary: a\n---' },
      { name: 'b.md', content: '---\nslug: x\ntitle: B\nsummary: b\n---' },
    ])).toThrow(/duplicate wiki slug "x"/);

    const reloaded = f.session.wikiReload(pages);
    expect(reloaded).toBe(f.session.wiki);
    expect(reloaded.searchEnabled).toBe(true);
    expect([...reloaded.slugs]).toEqual(['dostavka']);
    expect(reloaded.search('зоны').map((hit) => hit.slug)).toEqual(['dostavka']);
  });

  it('serves the proposals that have no pull request yet', async () => {
    const f = fixture();
    f.engine.proposalItems = [
      item({ id: 'notes-1', kind: 'undocumented', documentationCandidate: true }),
      item({ id: 'notes-2', kind: 'undocumented', documentationCandidate: true }),
    ];
    expect((await f.session.newProposals()).map((entry) => entry.id)).toEqual(['notes-1', 'notes-2']);
    f.state.recordProposal({ itemId: 'notes-1', pullNumber: 7, branch: 'wiki/proposal-notes-1', page: 'help', sourceThread: 'issue-5' });
    expect((await f.session.newProposals()).map((entry) => entry.id)).toEqual(['notes-2']);

    const noProposals = fixture();
    delete (noProposals.engine as { proposals?: unknown }).proposals;
    expect(await noProposals.session.newProposals()).toEqual([]);
  });

  it('resets the state and the engine together, and only when asked', async () => {
    const f = fixture();
    f.session.customerMessage({ thread: 't', customer: 'dom_i_sad', content: 'q' });
    f.session.setClock('2026-09-07T00:00:00Z');
    expect(f.engine.resetCount).toBe(0);
    await f.session.reset();
    expect(f.engine.resetCount).toBe(1);
    expect(f.session.threads()).toEqual([]);
    expect(f.session.now()).toBe(WALL);
  });
});

describe('Session persistence and construction', () => {
  it('continues from the state file after a restart', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.db');
    const first = fixture({}, undefined, path);
    first.session.customerMessage({ thread: 'issue-5', customer: 'dom_i_sad', content: 'Пропали строки.', issueNumber: 5, githubId: 'issue:5' });
    const turnRecord = await first.session.agentTurn('issue-5');
    first.session.setClock('2026-09-07T09:00:00Z');
    first.session.dispose();
    fixtures.pop();

    const second = fixture({}, undefined, path);
    expect(second.session.now()).toBe('2026-09-07T09:00:00.000Z');
    expect(second.session.turns('issue-5')).toEqual([turnRecord]);
    expect(second.session.customerMessage({ thread: 'issue-5', customer: 'dom_i_sad', content: 'x', githubId: 'issue:5' }).id).toBe(1);
    second.session.customerMessage({ thread: 'issue-5', customer: 'dom_i_sad', content: 'Ещё.', githubId: 'comment:3' });
    expect((await second.session.agentTurn('issue-5')).id).toBe('turn-2');
  });

  it('opens the notes engine on a file and delegates the other engines to the runner factory', async () => {
    const dir = await tempDir();
    const memoryPath = join(dir, 'memory.db');
    const model = new MockLanguageModelV4();
    const notes = createSessionEngine(config(), { memoryPath, model });
    expect(notes).toBeInstanceOf(NotesMemoryEngine);
    await notes.write([item({ id: 'kept', scope: 'customer', about: 'dom_i_sad', learnedFrom: 'dom_i_sad' })], WALL);
    (notes as NotesMemoryEngine).close();
    expect((await stat(memoryPath)).isFile()).toBe(true);

    const reopened = createSessionEngine(config(), { memoryPath, model });
    expect((await reopened.recall('dom_i_sad', 'kept', WALL)).map((entry) => entry.id)).toEqual(['kept']);
    (reopened as NotesMemoryEngine).close();

    expect(createSessionEngine(config({ engine: 'naive' })).id).toBe('naive');
    expect(createSessionEngine(config({ engine: 'none' })).id).toBe('none');
  });

  it('opens a session from an eval config file, a wiki directory and the db paths', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'naive-live.yaml'), [
      'id: naive-live',
      'agent:  { provider: openai, model: gpt-4o-mini }',
      'memory: { engine: naive, read: hydrate, write: consolidate }',
      'judge:  { provider: anthropic, model: claude-sonnet-5 }',
    ].join('\n'));
    await writeFile(join(dir, 'help.md'), '---\nslug: help\ntitle: Помощь\nsummary: Справка.\n---\nТекст.');
    await writeFile(join(dir, 'README.md'), 'not a page');

    const session = await openSession({
      configPath: join(dir, 'naive-live.yaml'),
      statePath: join(dir, 'state.db'),
      wikiDir: dir,
      customers: CUSTOMERS,
      clock: () => new Date(WALL),
    });
    try {
      expect(session.config.id).toBe('naive-live');
      expect(session.engine.id).toBe('naive');
      expect([...session.wiki.slugs]).toEqual(['help']);
      expect(session.now()).toBe(WALL);
      expect(session.state.path).toBe(join(dir, 'state.db'));
    } finally {
      session.dispose();
    }

    await writeFile(join(dir, 'broken.yaml'), 'id: broken\nagent: { provider: openai }\n');
    await expect(openSession({ configPath: join(dir, 'broken.yaml'), statePath: ':memory:', wikiDir: dir, customers: CUSTOMERS }))
      .rejects.toThrow(/Invalid session config .*broken\.yaml/);
  });
});
