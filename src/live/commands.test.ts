import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockLanguageModelV4 } from 'ai/test';
import { stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import type { TurnInput, TurnResult } from '../agent/index.ts';
import { ZERO_USAGE } from '../llm/index.ts';
import type { MemoryItem } from '../memory/index.ts';
import { describeFakeCalls, describeOffset, type LiveCliOptions, runLiveCli } from './commands.ts';
import { FakeGithubClient } from './fake-github.ts';
import type { GithubClientOptions } from './github.ts';
import type { PageChoice } from './proposals.ts';

const WALL = '2026-09-07T10:00:00.000Z';
const HUMAN = 'CrazyClicker';
type MockGenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const LIVE_CONFIG = {
  repo: 'CrazyClicker/memorybot',
  poll_seconds: 1,
  config: 'evals/configs/notes-both.yaml',
  memory_issue: 1,
  humans: [HUMAN],
  customers: {
    kofe_tochka: { form: 'Кофе-точка', name: 'Кофе-точка', profile: 'Обжарщик кофе.' },
    lavanda: { form: 'Лаванда', name: 'Лаванда' },
  },
};

const FIXTURE = {
  events: [
    { issue: { title: '🧠 Память агента', author: HUMAN, body: '_Заметок нет._' } },
    {
      issue: {
        title: 'Нет способов доставки',
        author: 'anton-kofe',
        labels: ['support'],
        body: '### Магазин\n\nКофе-точка\n\n### Сообщение\n\nВозим только по Томской области.\n',
      },
    },
  ],
};

const PAGE_CHOICE: PageChoice = { slug: 'dostavka', why: 'Страница про доставку.', usage: ZERO_USAGE, costUsd: 0 };

const USAGE: MockGenerateResult['usage'] = {
  inputTokens: { total: 1_000, noCache: 800, cacheRead: 200, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

function extraction(notes: unknown[]): MockGenerateResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ notes: notes.map((note) => ({ valid_until: null, ...(note as object) })) }) }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    outcome: 'answer',
    reply: 'Адрес покупателя вне ваших зон доставки, поэтому способов доставки нет.',
    memoryWrites: [],
    trace: [{ step: 1, toolCalls: [{ tool: 'read_page', input: { slug: 'dostavka' } }], usage: ZERO_USAGE }],
    usage: ZERO_USAGE,
    latencyMs: 10,
    costUsd: 0.001,
    ...overrides,
  };
}

function write(statement: string): MemoryItem {
  return {
    id: 'agent-write',
    kind: 'personal',
    about: 'kofe_tochka',
    learnedFrom: 'kofe_tochka',
    scope: 'customer',
    statement,
    source: { thread: 'issue-2', via: 'agent' },
    createdAt: WALL,
  };
}

interface Harness {
  readonly dir: string;
  options: LiveCliOptions;
  out: string;
  err: string;
  readonly calls: TurnInput[];
  readonly script: TurnResult[];
  /** Extraction results for the notes engine, in order; an empty list after they run out. */
  readonly extractions: unknown[][];
  /** Options every client created through the `createGithub` seam was asked for. */
  readonly githubOptions: GithubClientOptions[];
  wall: Date;
}

const dirs: string[] = [];

async function harness(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'prilavok-live-cli-'));
  dirs.push(dir);
  await writeFile(join(dir, 'config.yaml'), stringifyYaml(LIVE_CONFIG));
  await writeFile(join(dir, 'fixture.yaml'), stringifyYaml(FIXTURE));
  const h = {
    dir, out: '', err: '', calls: [], script: [], extractions: [], githubOptions: [], wall: new Date(WALL),
  } as unknown as Harness;
  h.options = {
    env,
    out: (text) => { h.out += text; },
    err: (text) => { h.err += text; },
    clock: () => h.wall,
    paths: {
      config: join(dir, 'config.yaml'),
      fixture: join(dir, 'fixture.yaml'),
      state: join(dir, 'state.db'),
      memory: join(dir, 'memory.db'),
      fakeState: join(dir, 'fake-state.db'),
      fakeMemory: join(dir, 'fake-memory.db'),
    },
    runAgent: async (input) => {
      h.calls.push(input);
      return h.script.shift() ?? turn();
    },
    model: new MockLanguageModelV4({ doGenerate: async () => extraction(h.extractions.shift() ?? []) }),
    choosePage: async () => PAGE_CHOICE,
    createGithub: (options) => {
      h.githubOptions.push(options);
      // Stands for the repository: the pinned memory issue exists, no tickets yet.
      const fake = new FakeGithubClient({ repo: options.repo, now: () => h.wall.toISOString() });
      fake.openIssue({ title: '🧠 Память агента', author: HUMAN });
      return fake;
    },
    ownerToken: async () => 'owner-token',
    sleep: async () => {},
  };
  return h;
}

async function invoke(h: Harness, args: string[]): Promise<number> {
  h.out = '';
  h.err = '';
  return runLiveCli(args, h.options);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------------------------

describe('pnpm live: grammar at the command line', () => {
  it('prints help and usage errors without opening a session', async () => {
    const h = await harness();
    expect(await invoke(h, ['--help'])).toBe(0);
    expect(h.out).toContain('Usage: pnpm live <command> [options]');
    expect(await invoke(h, ['nope'])).toBe(1);
    expect(h.err).toContain('Unknown command "nope"');
    expect(await invoke(h, ['coach', '12'])).toBe(1);
    expect(h.err).toContain('coach takes at least 2 argument(s)');
    expect(await exists(join(h.dir, 'fake-state.db'))).toBe(false);
  });
});

describe('pnpm live: the fake mode', () => {
  it('once replays the fixture, answers, prints what the bot did, and a second poll does nothing', async () => {
    const h = await harness();
    h.script.push(turn({ memoryWrites: [write('Возим только по Томской области.')] }));

    expect(await invoke(h, ['once'])).toBe(0);
    expect(h.out).toContain(`GitHub: fake CrazyClicker/memorybot replaying ${join(h.dir, 'fixture.yaml')} (no bot identity in .env)`);
    expect(h.out).toContain('10:00:00 #2: kofe_tochka (via form) opened "Нет способов доставки"');
    expect(h.out).toContain('#2: issue:2 → answer (0.0 s, $0.0010), comment 1');
    expect(h.out).toContain('poll: 1 issue(s) listed, 1 handled, 0 error(s); cursor 2026-09-07T10:00:00.');
    expect(h.out).toContain('On the fake GitHub:');
    expect(h.out).toContain('  comment on #2:');
    expect(h.out).toContain('Адрес покупателя вне ваших зон доставки');
    expect(h.out).toContain('Как я отвечал');
    expect(h.out).toContain('  labels on #2: +agent:answered');
    expect(h.out).toContain('  body of #1:');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.customer.id).toBe('kofe_tochka');
    expect(await exists(join(h.dir, 'fake-state.db'))).toBe(true);
    expect(await exists(join(h.dir, 'state.db'))).toBe(false);

    expect(await invoke(h, ['once'])).toBe(0);
    expect(h.out).toContain('0 handled, 0 error(s)');
    expect(h.out).toContain('On the fake GitHub: nothing.');
    expect(h.calls).toHaveLength(1);
  });

  it('status and memory read the fake state; --customer keeps to what that merchant sees', async () => {
    const h = await harness();
    h.script.push(turn({ memoryWrites: [write('Возим только по Томской области.')] }));
    await invoke(h, ['once']);

    expect(await invoke(h, ['status'])).toBe(0);
    expect(h.out).toContain('Config: evals/configs/notes-both.yaml — notes, read hydrate, write both; agent openai:gpt-5.6-terra');
    expect(h.out).toContain('Clock:  2026-09-07T10:00:00.000Z (wall clock)');
    expect(h.out).toContain('Cursor: 2026-09-07T10:00:00.');
    expect(h.out).toContain('Notes:  1 (0 shared, 0 expired)');
    expect(h.out).toContain('Threads: 1');
    expect(h.out).toMatch(/#2\s+kofe_tochka\s+open\s+2 event\(s\)\s+turns: answer\s+2 to consolidate\s+\$0\.0010/);
    expect(h.out).toContain('Proposals: 0');

    expect(await invoke(h, ['status', '--json'])).toBe(0);
    expect(JSON.parse(h.out)).toMatchObject({
      mode: 'fake',
      clockOffsetMs: 0,
      notes: { total: 1, shared: 0, expired: 0 },
      threads: [{ id: 'issue-2', issue: 2, customer: 'kofe_tochka', state: 'open', events: 2, pendingEvents: 2, costUsd: 0.001 }],
    });

    expect(await invoke(h, ['memory'])).toBe(0);
    expect(h.out).toContain(`Notes: 1; clock 2026-09-07T10:00:00.000Z; ${join(h.dir, 'fake-memory.db')}`);
    expect(h.out).toContain('  agent-issue-2-turn-1-1  `personal` · `customer` · бессрочно — По состоянию на 2026-09-07: Возим только по Томской области. · #2');
    expect(await invoke(h, ['memory', '--customer', 'lavanda'])).toBe(0);
    expect(h.out).toBe(`Notes visible to lavanda: 0; clock 2026-09-07T10:00:00.000Z; ${join(h.dir, 'fake-memory.db')}\n`);
    expect(await invoke(h, ['memory', '--customer', 'kofe_tochka', '--json'])).toBe(0);
    expect(JSON.parse(h.out)).toEqual([expect.objectContaining({ id: 'agent-issue-2-turn-1-1', learnedFrom: 'kofe_tochka' })]);
    expect(await invoke(h, ['memory', '--customer', 'nobody'])).toBe(1);
    expect(h.err).toContain(`Unknown customer "nobody"; ${join(h.dir, 'config.yaml')} configures kofe_tochka, lavanda.`);
  });

  it('coach files the note privately, consolidates, shares a product note and posts only the consolidation comment', async () => {
    const h = await harness();
    await invoke(h, ['once']);
    h.extractions.push([{
      kind: 'temporal',
      about: 'product',
      statement: 'Карты не проходят до 18:00, QR работает.',
      valid_until: '2026-09-07T18:00:00+03:00',
      source_events: [3],
    }]);

    expect(await invoke(h, ['coach', '2', '--product', 'Карты', 'не', 'проходят', 'до', '18:00,', 'QR', 'работает'])).toBe(0);
    expect(h.out).toContain('#2: product coach note by CrazyClicker recorded privately');
    // Every invocation rebuilds the fake from the fixture, so its comment ids start over at 1.
    expect(h.out).toContain('#2: product note → 3 event(s), 1 note(s), comment 1');
    expect(h.out).toContain('#2: product coach note filed privately as CrazyClicker; 1 note(s) written, consolidation comment 1');
    expect(h.out).toContain('  notes-1  `temporal` · `shared` · до 2026-09-07 18:00 (+03:00) — По состоянию на 2026-09-07: Карты не проходят до 18:00, QR работает. · #2');
    expect(h.out).toContain('  comment on #2:');
    expect(h.out).toContain('Консолидация после coach-заметки');
    expect(h.out).toContain('  body of #1:');
    expect(h.out).not.toContain('reaction');
    expect(h.out).not.toContain('minimized');
    // The private path posts one comment: the consolidation. The note itself stays in the state.
    expect(h.out.match(/comment on #2:/g)).toHaveLength(1);

    expect(await invoke(h, ['memory', '--customer', 'lavanda'])).toBe(0);
    expect(h.out).toContain('notes-1');
    expect(h.out).toContain('Карты не проходят до 18:00');
    expect(await invoke(h, ['status'])).toBe(0);
    expect(h.out).toMatch(/#2\s+kofe_tochka\s+open\s+3 event\(s\)\s+turns: answer\s+consolidated/);

    expect(await invoke(h, ['coach', '99', 'Заметка', 'в', 'никуда'])).toBe(1);
    expect(h.err).toContain('Issue #99 has no thread yet');
    expect(await invoke(h, ['coach', 'two', 'Заметка'])).toBe(1);
    expect(h.err).toContain('Expected an issue number, got "two"');
  });

  it('clock shows the scenario clock, moves it forward only and repaints the memory issue', async () => {
    const h = await harness();
    expect(await invoke(h, ['clock'])).toBe(0);
    expect(h.out).toBe('clock: 2026-09-07T10:00:00.000Z (wall clock)\n');

    expect(await invoke(h, ['clock', '2026-09-14T10:00:00Z'])).toBe(0);
    expect(h.out).toContain('10:00:00 clock → 2026-09-14T10:00:00.000Z');
    expect(h.out).toContain('memory issue #1 repainted after the clock move: 0 note(s)');
    expect(h.out).toContain('clock: 2026-09-14T10:00:00.000Z (+7d against the wall clock)');
    expect(h.out).toContain('  body of #1:');

    expect(await invoke(h, ['clock', '2026-09-01T00:00:00Z'])).toBe(1);
    expect(h.err).toContain('moves forward only');
    expect(await invoke(h, ['clock', 'yesterday'])).toBe(1);
    expect(h.err).toContain('clock needs an ISO timestamp, got "yesterday"');

    expect(await invoke(h, ['status'])).toBe(0);
    expect(h.out).toContain('Clock:  2026-09-14T10:00:00.000Z (+7d against the wall clock)');
  });

  it('reset clears the fake state; --issues prints the plan without --yes and executes it with', async () => {
    const h = await harness();
    await invoke(h, ['once']);
    expect(await invoke(h, ['reset'])).toBe(0);
    expect(h.out).toContain(`cleared ${join(h.dir, 'fake-state.db')} and ${join(h.dir, 'fake-memory.db')}`);
    expect(await invoke(h, ['status'])).toBe(0);
    expect(h.out).toContain('Threads: 0');

    await invoke(h, ['once']);
    expect(h.calls).toHaveLength(2);
    expect(await invoke(h, ['reset', '--issues'])).toBe(0);
    expect(h.out).toContain('Plan for CrazyClicker/memorybot:');
    expect(h.out).toContain('  delete 1 issue(s): #2 «Нет способов доставки»');
    expect(h.out).toContain('  close 0 open proposal pull request(s), delete 0 proposal branch(es)');
    expect(h.out).toContain('  empty the memory issue #1');
    expect(h.out).toContain('Nothing changed. Re-run with --yes to execute.');
    expect(h.out).not.toContain('deleted');
    expect(await invoke(h, ['status'])).toBe(0);
    expect(h.out).toContain('Threads: 1');

    expect(await invoke(h, ['reset', '--issues', '--yes'])).toBe(0);
    expect(h.out).toContain('issue #2 deleted');
    expect(h.out).not.toContain('issue #1 deleted');
    expect(h.out).toContain('memory issue #1 emptied');
    expect(await invoke(h, ['status'])).toBe(0);
    expect(h.out).toContain('Threads: 0');
  });

  it('run polls until the signal aborts', async () => {
    const h = await harness();
    const controller = new AbortController();
    h.options = { ...h.options, signal: controller.signal, sleep: async () => { controller.abort(); } };

    expect(await invoke(h, ['run'])).toBe(0);
    expect(h.out).toContain('polling CrazyClicker/memorybot for "support" every 1 s');
    expect(h.out).toContain('#2: issue:2 → answer');
    expect(h.out).toContain('stopping after the current poll');
    expect(h.out).toContain('10:00:00 stopped');
    expect(h.out).toContain('On the fake GitHub:');
    expect(h.calls).toHaveLength(1);
  });

  it('once --json keeps stdout for the result and sends the log to stderr', async () => {
    const h = await harness();
    expect(await invoke(h, ['once', '--json'])).toBe(0);
    expect(JSON.parse(h.out)).toMatchObject({
      issues: 1,
      handled: [{ githubId: 'issue:2', issue: 2, action: 'answer', comment: 1 }],
      errors: [],
    });
    expect(h.err).toContain('#2: issue:2 → answer');
  });
});

describe('pnpm live: with a bot identity', () => {
  it('acts on the client built from the token and keeps state in the real files', async () => {
    const h = await harness({ GITHUB_TOKEN: 'ghp_test' });
    expect(await invoke(h, ['once', '--fixture', 'other.yaml'])).toBe(1);
    expect(h.err).toContain('--fixture applies to the fake mode only');

    expect(await invoke(h, ['once'])).toBe(0);
    expect(h.out).toContain(`GitHub: CrazyClicker/memorybot as the bot token; state ${join(h.dir, 'state.db')}, memory ${join(h.dir, 'memory.db')}`);
    expect(h.out).toContain('poll: 0 issue(s) listed, 0 handled, 0 error(s)');
    expect(h.out).not.toContain('On the fake GitHub');
    expect(h.githubOptions).toEqual([{ repo: 'CrazyClicker/memorybot', auth: { kind: 'token', token: 'ghp_test' } }]);
    expect(await exists(join(h.dir, 'state.db'))).toBe(true);
    expect(await exists(join(h.dir, 'fake-state.db'))).toBe(false);

    expect(await invoke(h, ['reset', '--issues', '--yes'])).toBe(0);
    expect(h.githubOptions.at(-1)).toEqual({ repo: 'CrazyClicker/memorybot', auth: { kind: 'token', token: 'owner-token' } });
    expect(h.out).toContain('delete 0 issue(s)');
    expect(h.out).toContain('memory issue #1 emptied');

    expect(await invoke(h, ['status', '--fake'])).toBe(0);
    expect(h.out).toContain('(--fake)');
    expect(await exists(join(h.dir, 'fake-state.db'))).toBe(true);
  });

  it('refuses a half-configured GitHub App and a failing owner token with a plain message', async () => {
    const partial = await harness({ GITHUB_APP_ID: '42' });
    expect(await invoke(partial, ['status'])).toBe(1);
    expect(partial.err).toContain('GitHub App auth needs');

    const h = await harness({ GITHUB_TOKEN: 'ghp_test' });
    h.options = { ...h.options, ownerToken: async () => { throw new Error('not logged in'); } };
    expect(await invoke(h, ['reset', '--issues'])).toBe(1);
    expect(h.err).toContain('needs `gh auth token`: not logged in. Run `gh auth login` first.');
  });
});

describe('pnpm live: helpers', () => {
  it('describes the clock offset and the fake calls', () => {
    expect(describeOffset(0)).toBe('wall clock');
    expect(describeOffset(7 * 86_400_000 + 90_000)).toBe('+7d 1m 30s against the wall clock');
    expect(describeOffset(-3_600_000)).toBe('-1h against the wall clock');
    expect(describeFakeCalls([
      { method: 'listIssues', args: [{ label: 'support' }] },
      { method: 'createComment', args: [2, 'Ответ\nвторая строка'] },
      { method: 'addLabels', args: [2, ['agent:answered']] },
      { method: 'createPullRequest', args: [{ head: 'wiki/proposal-notes-1', title: 'wiki: BOM', body: 'тело' }] },
      { method: 'deleteIssue', args: [2] },
    ])).toEqual([
      'comment on #2:',
      '    Ответ',
      '    вторая строка',
      'labels on #2: +agent:answered',
      'pull request "wiki: BOM" from wiki/proposal-notes-1:',
      '    тело',
      'issue #2 deleted',
    ]);
  });
});
