/**
 * `pnpm live` commands (ROADMAP §6, T4.6): the thin shell around `LiveLoop`, `Session` and the
 * GitHub client. `cli.ts` is the executable; this module is the testable part, with every
 * external dependency — environment, output, the GitHub client, the agent, the owner's token —
 * injectable through `LiveCliOptions`.
 *
 * Decisions:
 * - Two modes, chosen once per invocation. With a bot identity in the environment (D13) the
 *   commands act on the repository named in `live/config.yaml` and keep state in
 *   `live/state.db` and `live/memory.db`. Without one, or with `--fake`, they replay the
 *   recorded fixture onto the in-memory fake and keep state in `live/fake-state.db` and
 *   `live/fake-memory.db`: the fixture's issue numbers would otherwise be marked processed in
 *   the real state and the real issues carrying those numbers skipped. Nothing the bot does on
 *   the fake is visible anywhere, so the commands print it (`describeFakeCalls`).
 * - `status`, `memory` and a bare `clock` read the local databases only: they work without
 *   network in either mode. The other commands write to the client of the mode.
 * - `coach` and `clock <ISO>` are the private forms of the `/coach` and `/clock` comments
 *   (D12): the same session calls through `LiveLoop`, no GitHub object, nothing in `processed`.
 * - `reset --issues` acts as the repository owner (`gh auth token`): deleting an issue is beyond
 *   the bot's rights (D13). It prints its plan and changes nothing without `--yes`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { LanguageModel } from 'ai';

import type { RunAgent } from '../evals/runner.ts';
import { canRecall } from '../memory/index.ts';
import { DEFAULT_WIKI_DIR } from '../wiki/index.ts';
import { CliError, helpText, type LiveCommandName, type ParsedLiveCli, parseLiveCli } from './args.ts';
import { DEFAULT_LIVE_CONFIG_PATH, type LiveConfig, loadLiveConfig, sessionCustomers } from './config.ts';
import type { FakeCall, FakeGithubClient } from './fake-github.ts';
import { DEFAULT_FIXTURE_PATH, fakeFromFixture, loadFixture, readWikiFiles } from './fixture.ts';
import {
  type CommitFileInput,
  createGithubClient,
  type CreatePullRequestInput,
  type GithubAuth,
  type GithubClient,
  type GithubClientOptions,
  githubAuthFromEnv,
} from './github.ts';
import { ISSUES_SINCE_KEY, LiveLoop, type Logger, type PollError, PROPOSAL_BRANCH_PREFIX, type Sleep } from './loop.ts';
import type { PageChooser } from './proposals.ts';
import { createRenderer, isExpired, noteLine } from './render.ts';
import { ClockMovesForwardOnlyError, DEFAULT_MEMORY_PATH, openSession, type Session } from './session.ts';
import { DEFAULT_STATE_PATH, type ProposalRecord } from './state.ts';

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const execFileAsync = promisify(execFile);

export type Writer = (text: string) => void;

export interface LivePaths {
  /** `live/config.yaml`; `--config` overrides it. */
  readonly config: string;
  /** The recording the fake mode replays; `--fixture` overrides it. */
  readonly fixture: string;
  /** Local wiki directory: the session's first snapshot and the fake's `main`. */
  readonly wiki: string;
  readonly state: string;
  readonly memory: string;
  readonly fakeState: string;
  readonly fakeMemory: string;
}

export const DEFAULT_LIVE_PATHS: LivePaths = {
  config: DEFAULT_LIVE_CONFIG_PATH,
  fixture: DEFAULT_FIXTURE_PATH,
  wiki: DEFAULT_WIKI_DIR,
  state: DEFAULT_STATE_PATH,
  memory: DEFAULT_MEMORY_PATH,
  fakeState: 'live/fake-state.db',
  fakeMemory: 'live/fake-memory.db',
};

export interface LiveCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: Writer;
  readonly err?: Writer;
  /** Stops `run`; the executable wires SIGINT and SIGTERM to it when this is absent. */
  readonly signal?: AbortSignal;
  readonly clock?: () => Date;
  readonly paths?: Partial<LivePaths>;
  /** Test seams: the agent, the extraction and page-choice model, the clients, the owner token. */
  readonly runAgent?: RunAgent;
  readonly model?: LanguageModel;
  readonly choosePage?: PageChooser;
  readonly createGithub?: (options: GithubClientOptions) => GithubClient;
  readonly ownerToken?: () => Promise<string>;
  readonly sleep?: Sleep;
}

type ParsedCommand = Extract<ParsedLiveCli, { kind: 'command' }>;

interface Io {
  readonly out: Writer;
  readonly err: Writer;
}

type Handler = (parsed: ParsedCommand, io: Io, options: LiveCliOptions) => Promise<number>;

/** Parse and run; the exit code comes back, and the errors a user can fix never throw. */
export async function runLiveCli(argv: readonly string[], options: LiveCliOptions = {}): Promise<number> {
  const io: Io = {
    out: options.out ?? ((text) => { process.stdout.write(text); }),
    err: options.err ?? ((text) => { process.stderr.write(text); }),
  };
  let parsed: ParsedLiveCli;
  try {
    parsed = parseLiveCli(argv);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    io.err(`${error.message}\n`);
    return EXIT_FAILURE;
  }
  if (parsed.kind === 'help') {
    io.out(`${parsed.text}\n`);
    return EXIT_OK;
  }
  try {
    return await HANDLERS[parsed.name](parsed, io, options);
  } catch (error) {
    if (error instanceof CliError) {
      io.err(`${error.message}\n\n${helpText(parsed.name)}\n`);
      return EXIT_FAILURE;
    }
    io.err(`${parsed.name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }
}

// ---------------------------------------------------------------------------------------------
// Context: the mode, the session, the client and the loop of one invocation
// ---------------------------------------------------------------------------------------------

interface LiveContext {
  readonly mode: 'github' | 'fake';
  readonly config: LiveConfig;
  readonly configPath: string;
  readonly session: Session;
  readonly github: GithubClient;
  /** Set in the fake mode: the same object as `github`, with its recorded calls. */
  readonly fake?: FakeGithubClient;
  readonly loop: LiveLoop;
  readonly statePath: string;
  readonly memoryPath: string;
  /** One line saying what the command acts on. */
  readonly header: string;
  dispose(): void;
}

async function openLive(
  parsed: ParsedCommand,
  io: Io,
  options: LiveCliOptions,
  logTo: 'out' | 'err' = 'out',
): Promise<LiveContext> {
  const env = options.env ?? process.env;
  const paths: LivePaths = { ...DEFAULT_LIVE_PATHS, ...options.paths };
  const clock = options.clock ?? (() => new Date());
  const configPath = stringValue(parsed.values['config']) ?? paths.config;
  const config = await loadLiveConfig(configPath);

  let auth: GithubAuth | undefined;
  try {
    auth = githubAuthFromEnv(env);
  } catch (error) {
    throw new CliError(describe(error));
  }
  const forcedFake = parsed.values['fake'] === true;
  const fixtureOption = stringValue(parsed.values['fixture']);

  let github: GithubClient;
  let fake: FakeGithubClient | undefined;
  let statePath: string;
  let memoryPath: string;
  let header: string;
  if (auth === undefined || forcedFake) {
    const fixturePath = fixtureOption ?? paths.fixture;
    fake = fakeFromFixture(await loadFixture(fixturePath), {
      repo: config.repo,
      files: await readWikiFiles(paths.wiki),
      now: () => clock().toISOString(),
    });
    github = fake;
    statePath = paths.fakeState;
    memoryPath = paths.fakeMemory;
    header =
      `GitHub: fake ${config.repo} replaying ${fixturePath} ` +
      `(${forcedFake ? '--fake' : 'no bot identity in .env'}); state ${statePath}, memory ${memoryPath}`;
  } else {
    if (fixtureOption !== undefined) {
      throw new CliError('--fixture applies to the fake mode only; add --fake or drop the bot identity from .env.');
    }
    github = (options.createGithub ?? createGithubClient)({ repo: config.repo, auth });
    statePath = paths.state;
    memoryPath = paths.memory;
    header =
      `GitHub: ${config.repo} as the ${auth.kind === 'token' ? 'bot token' : 'GitHub App'}; ` +
      `state ${statePath}, memory ${memoryPath}`;
  }

  const session = await openSession({
    configPath: config.config,
    statePath,
    memoryPath,
    wikiDir: paths.wiki,
    customers: sessionCustomers(config),
    clock,
    ...(options.runAgent === undefined ? {} : { runAgent: options.runAgent }),
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  const write = logTo === 'out' ? io.out : io.err;
  const log: Logger = (line) => {
    write(`${clock().toISOString().slice(11, 19)} ${line}\n`);
  };
  const loop = new LiveLoop({
    session,
    github,
    config,
    log,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.choosePage === undefined ? {} : { choosePage: options.choosePage }),
  });
  return {
    mode: fake === undefined ? 'github' : 'fake',
    config,
    configPath,
    session,
    github,
    ...(fake === undefined ? {} : { fake }),
    loop,
    statePath,
    memoryPath,
    header,
    dispose: () => {
      session.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// run, once
// ---------------------------------------------------------------------------------------------

const run: Handler = async (parsed, io, options) => {
  const ctx = await openLive(parsed, io, options);
  try {
    io.out(`${ctx.header}\n`);
    if (ctx.fake !== undefined) {
      io.out('The fake GitHub changes only through this process: after the first poll nothing new arrives. Ctrl-C stops.\n');
    }
    const controller = new AbortController();
    const stop = (): void => {
      if (controller.signal.aborted) return;
      io.out('stopping after the current poll\n');
      controller.abort();
    };
    const external = options.signal;
    if (external === undefined) {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } else if (external.aborted) {
      stop();
    } else {
      external.addEventListener('abort', stop, { once: true });
    }
    try {
      await ctx.loop.run(controller.signal);
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      external?.removeEventListener('abort', stop);
    }
    if (ctx.fake !== undefined) printFakeActivity(io, ctx.fake.calls);
    return EXIT_OK;
  } finally {
    ctx.dispose();
  }
};

const once: Handler = async (parsed, io, options) => {
  const json = parsed.values['json'] === true;
  const ctx = await openLive(parsed, io, options, json ? 'err' : 'out');
  try {
    if (!json) io.out(`${ctx.header}\n`);
    const before = ctx.fake?.calls.length ?? 0;
    const result = await ctx.loop.poll();
    if (json) {
      io.out(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.out(
        `poll: ${result.issues} issue(s) listed, ${result.handled.length} handled, ${result.errors.length} error(s)` +
          `${result.since === undefined ? '' : `; cursor ${result.since}`}\n`,
      );
      for (const error of result.errors) io.out(`  error${where(error)}: ${error.message}\n`);
      if (ctx.fake !== undefined) printFakeActivity(io, ctx.fake.calls.slice(before));
    }
    return result.errors.length === 0 ? EXIT_OK : EXIT_FAILURE;
  } finally {
    ctx.dispose();
  }
};

function where(error: PollError): string {
  return `${error.issue === undefined ? '' : ` #${error.issue}`}${error.githubId === undefined ? '' : ` ${error.githubId}`}`;
}

// ---------------------------------------------------------------------------------------------
// status, memory
// ---------------------------------------------------------------------------------------------

export interface ThreadStatus {
  readonly id: string;
  readonly issue?: number;
  readonly customer: string;
  readonly state: 'open' | 'closed';
  readonly events: number;
  /** Events not yet handed to the engine. */
  readonly pendingEvents: number;
  readonly turns: { readonly id: string; readonly outcome: string; readonly costUsd?: number }[];
  readonly costUsd: number;
}

export interface StatusReport {
  readonly mode: 'github' | 'fake';
  readonly repo: string;
  readonly config: {
    readonly path: string;
    readonly engine: string;
    readonly read: string;
    readonly write: string;
    readonly agent: string;
  };
  readonly clock: string;
  readonly clockOffsetMs: number;
  readonly since?: string;
  readonly notes: { readonly total: number; readonly shared: number; readonly expired: number };
  readonly threads: ThreadStatus[];
  readonly proposals: ProposalRecord[];
}

async function statusReport(ctx: LiveContext): Promise<StatusReport> {
  const { session, config } = ctx;
  const state = session.state;
  const now = session.now();
  const items = await session.memoryItems();
  const since = state.get(ISSUES_SINCE_KEY);
  const threads = session.threads().map((thread): ThreadStatus => {
    const events = state.events(thread.id).length;
    const turns = session.turns(thread.id);
    return {
      id: thread.id,
      ...(thread.issueNumber === undefined ? {} : { issue: thread.issueNumber }),
      customer: thread.customer,
      state: thread.closedAt === undefined ? 'open' : 'closed',
      events,
      pendingEvents: Math.max(0, events - thread.consolidatedEvents),
      turns: turns.map((turn) => ({
        id: turn.id,
        outcome: turn.outcome,
        ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
      })),
      costUsd: turns.reduce((total, turn) => total + (turn.costUsd ?? 0), 0),
    };
  });
  return {
    mode: ctx.mode,
    repo: config.repo,
    config: {
      path: config.config,
      engine: session.config.memory.engine,
      read: session.config.memory.read,
      write: session.config.memory.write,
      agent: `${session.config.agent.provider}:${session.config.agent.model}`,
    },
    clock: now,
    clockOffsetMs: state.clockOffsetMs(),
    ...(since === undefined ? {} : { since }),
    notes: {
      total: items.length,
      shared: items.filter((item) => item.scope === 'shared').length,
      expired: items.filter((item) => isExpired(item, now)).length,
    },
    threads,
    proposals: state.proposals(),
  };
}

function renderStatus(ctx: LiveContext, report: StatusReport): string {
  const { config } = report;
  return [
    ctx.header,
    `Config: ${config.path} — ${config.engine}, read ${config.read}, write ${config.write}; agent ${config.agent}`,
    `Clock:  ${report.clock} (${describeOffset(report.clockOffsetMs)})`,
    `Cursor: ${report.since ?? 'none; the next poll lists every support issue'}`,
    `Notes:  ${report.notes.total} (${report.notes.shared} shared, ${report.notes.expired} expired)`,
    '',
    `Threads: ${report.threads.length}`,
    ...columns(
      report.threads.map((thread) => [
        thread.issue === undefined ? thread.id : `#${thread.issue}`,
        thread.customer,
        thread.state,
        `${thread.events} event(s)`,
        thread.turns.length === 0 ? 'no turns' : `turns: ${thread.turns.map((turn) => turn.outcome).join(', ')}`,
        thread.pendingEvents === 0 ? 'consolidated' : `${thread.pendingEvents} to consolidate`,
        `$${thread.costUsd.toFixed(4)}`,
      ]),
    ),
    '',
    `Proposals: ${report.proposals.length}`,
    ...columns(
      report.proposals.map((proposal) => [
        proposal.itemId,
        `→ PR #${proposal.pullNumber}`,
        proposal.status,
        proposal.page,
        `from ${proposal.sourceThread}`,
      ]),
    ),
  ].join('\n');
}

const status: Handler = async (parsed, io, options) => {
  const ctx = await openLive(parsed, io, options, 'err');
  try {
    const report = await statusReport(ctx);
    io.out(parsed.values['json'] === true ? `${JSON.stringify(report, null, 2)}\n` : `${renderStatus(ctx, report)}\n`);
    return EXIT_OK;
  } finally {
    ctx.dispose();
  }
};

const memory: Handler = async (parsed, io, options) => {
  const ctx = await openLive(parsed, io, options, 'err');
  try {
    const customer = stringValue(parsed.values['customer']);
    if (customer !== undefined && !Object.hasOwn(ctx.config.customers, customer)) {
      throw new CliError(
        `Unknown customer "${customer}"; ${ctx.configPath} configures ${Object.keys(ctx.config.customers).join(', ')}.`,
      );
    }
    const now = ctx.session.now();
    const items = (await ctx.session.memoryItems()).filter(
      (item) => customer === undefined || canRecall(item, customer),
    );
    if (parsed.values['json'] === true) {
      io.out(`${JSON.stringify(items, null, 2)}\n`);
      return EXIT_OK;
    }
    io.out(`Notes${customer === undefined ? '' : ` visible to ${customer}`}: ${items.length}; clock ${now}; ${ctx.memoryPath}\n`);
    for (const item of items) io.out(`  ${item.id}  ${noteLine(item, now, { scope: true })}\n`);
    return EXIT_OK;
  } finally {
    ctx.dispose();
  }
};

// ---------------------------------------------------------------------------------------------
// coach, clock
// ---------------------------------------------------------------------------------------------

const coach: Handler = async (parsed, io, options) => {
  const [issueArg = '', ...words] = parsed.positionals;
  const issue = parseIssueNumber(issueArg);
  const text = words.join(' ').trim();
  if (text === '') throw new CliError('coach needs the note text after the issue number.');
  const scope = parsed.values['product'] === true ? 'product' : 'customer';
  const ctx = await openLive(parsed, io, options);
  try {
    io.out(`${ctx.header}\n`);
    const author = ctx.config.humans[0];
    if (author === undefined) throw new Error(`${ctx.configPath} lists no humans`);
    if (ctx.session.state.threadByIssue(issue) === undefined) {
      throw new CliError(
        `Issue #${issue} has no thread yet: the loop records an issue when it polls it (pnpm live once or run).`,
      );
    }
    const before = ctx.fake?.calls.length ?? 0;
    const result = await ctx.loop.coach({ issue, author, text, scope });
    const { wrote, at } = result.result;
    const tail = [
      `${wrote.length} note(s) written`,
      ...(result.comment === undefined ? [] : [`consolidation comment ${result.comment}`]),
      ...(result.proposals.length === 0 ? [] : [`PR ${result.proposals.map((link) => `#${link.number}`).join(', ')}`]),
    ].join(', ');
    io.out(`#${issue}: ${scope} coach note filed privately as ${author}; ${tail}\n`);
    for (const item of wrote) io.out(`  ${item.id}  ${noteLine(item, at, { scope: true })}\n`);
    for (const error of result.errors) io.out(`  error: ${error.message}\n`);
    if (ctx.fake !== undefined) printFakeActivity(io, ctx.fake.calls.slice(before));
    return result.errors.length === 0 ? EXIT_OK : EXIT_FAILURE;
  } finally {
    ctx.dispose();
  }
};

const clock: Handler = async (parsed, io, options) => {
  const target = parsed.positionals[0];
  if (target !== undefined && !Number.isFinite(Date.parse(target))) {
    throw new CliError(`clock needs an ISO timestamp, got "${target}".`);
  }
  const ctx = await openLive(parsed, io, options, target === undefined ? 'err' : 'out');
  try {
    if (target === undefined) {
      io.out(`clock: ${ctx.session.now()} (${describeOffset(ctx.session.state.clockOffsetMs())})\n`);
      return EXIT_OK;
    }
    io.out(`${ctx.header}\n`);
    const before = ctx.fake?.calls.length ?? 0;
    let now: string;
    try {
      now = await ctx.loop.moveClock(target);
    } catch (error) {
      if (error instanceof ClockMovesForwardOnlyError) throw new CliError(error.message);
      throw error;
    }
    io.out(`clock: ${now} (${describeOffset(ctx.session.state.clockOffsetMs())})\n`);
    if (ctx.fake !== undefined) printFakeActivity(io, ctx.fake.calls.slice(before));
    return EXIT_OK;
  } finally {
    ctx.dispose();
  }
};

// ---------------------------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------------------------

const reset: Handler = async (parsed, io, options) => {
  const ctx = await openLive(parsed, io, options);
  try {
    io.out(`${ctx.header}\n`);
    if (parsed.values['issues'] !== true) {
      await ctx.session.reset();
      io.out(`cleared ${ctx.statePath} and ${ctx.memoryPath}\n`);
      return EXIT_OK;
    }
    const owner = await ownerClient(ctx, options);
    const { labels, memory_issue: memoryIssue } = ctx.config;
    const issues = (await owner.listIssues({ label: labels.support })).filter((issue) => issue.number !== memoryIssue);
    const pulls = await owner.listPullRequests({ headPrefix: PROPOSAL_BRANCH_PREFIX, state: 'all' });
    const open = pulls.filter((pull) => pull.state === 'open');
    io.out(`Plan for ${ctx.config.repo}:\n`);
    io.out(
      `  delete ${issues.length} issue(s)` +
        `${issues.length === 0 ? '' : `: ${issues.map((issue) => `#${issue.number} «${issue.title}»`).join(', ')}`}\n`,
    );
    io.out(`  close ${open.length} open proposal pull request(s), delete ${pulls.length} proposal branch(es)\n`);
    if (memoryIssue !== undefined) io.out(`  empty the memory issue #${memoryIssue}\n`);
    io.out(`  clear ${ctx.statePath} and ${ctx.memoryPath}\n`);
    if (parsed.values['yes'] !== true) {
      io.out('Nothing changed. Re-run with --yes to execute.\n');
      return EXIT_OK;
    }

    let failures = 0;
    for (const issue of issues) {
      try {
        await owner.deleteIssue(issue.number);
        io.out(`issue #${issue.number} deleted\n`);
      } catch (error) {
        failures += 1;
        io.err(`issue #${issue.number} not deleted: ${describe(error)}\n`);
      }
    }
    for (const pull of pulls) {
      try {
        if (pull.state === 'open') {
          await owner.closePullRequest(pull.number);
          io.out(`pull request #${pull.number} closed\n`);
        }
        await owner.deleteBranch(pull.headRef);
      } catch (error) {
        failures += 1;
        io.err(`pull request #${pull.number}: ${describe(error)}\n`);
      }
    }
    await ctx.session.reset();
    io.out(`cleared ${ctx.statePath} and ${ctx.memoryPath}\n`);
    if (memoryIssue !== undefined) {
      try {
        await owner.updateIssueBody(
          memoryIssue,
          createRenderer().memoryIssue([], { now: ctx.session.now(), customers: sessionCustomers(ctx.config) }),
        );
        io.out(`memory issue #${memoryIssue} emptied\n`);
      } catch (error) {
        failures += 1;
        io.err(`memory issue #${memoryIssue} not emptied: ${describe(error)}\n`);
      }
    }
    return failures === 0 ? EXIT_OK : EXIT_FAILURE;
  } finally {
    ctx.dispose();
  }
};

/** The fake stands for the owner too; on GitHub the owner is whoever `gh` is logged in as. */
async function ownerClient(ctx: LiveContext, options: LiveCliOptions): Promise<GithubClient> {
  if (ctx.fake !== undefined) return ctx.fake;
  let token: string;
  try {
    token = await (options.ownerToken ?? ghAuthToken)();
  } catch (error) {
    throw new CliError(
      `reset --issues acts as the repository owner and needs \`gh auth token\`: ${describe(error)}. ` +
        'Run `gh auth login` first.',
    );
  }
  return (options.createGithub ?? createGithubClient)({ repo: ctx.config.repo, auth: { kind: 'token', token } });
}

async function ghAuthToken(): Promise<string> {
  const { stdout } = await execFileAsync('gh', ['auth', 'token']);
  const token = stdout.trim();
  if (token === '') throw new Error('`gh auth token` printed nothing');
  return token;
}

const HANDLERS: Readonly<Record<LiveCommandName, Handler>> = { run, once, status, memory, coach, clock, reset };

// ---------------------------------------------------------------------------------------------
// What happened on the fake
// ---------------------------------------------------------------------------------------------

/** What the bot did on the fake, one entry per write (reads are skipped), for the terminal. */
export function describeFakeCalls(calls: readonly FakeCall[]): string[] {
  const lines: string[] = [];
  for (const { method, args } of calls) {
    switch (method) {
      case 'createComment': {
        const [number, body] = args as [number, string];
        lines.push(`comment on #${number}:`, ...indent(body));
        break;
      }
      case 'updateIssueBody': {
        const [number, body] = args as [number, string];
        lines.push(`body of #${number}:`, ...indent(body));
        break;
      }
      case 'addLabels': {
        const [number, labels] = args as [number, readonly string[]];
        lines.push(`labels on #${number}: ${labels.map((label) => `+${label}`).join(' ')}`);
        break;
      }
      case 'removeLabel': {
        const [number, label] = args as [number, string];
        lines.push(`labels on #${number}: -${label}`);
        break;
      }
      case 'addAssignees': {
        const [number, logins] = args as [number, readonly string[]];
        lines.push(`assignees on #${number}: ${logins.join(', ')}`);
        break;
      }
      case 'addReaction': {
        const [commentId, reaction] = args as [number, string];
        lines.push(`reaction ${reaction} on comment ${commentId}`);
        break;
      }
      case 'minimizeComment': {
        const [nodeId, reason] = args as [string, string | undefined];
        lines.push(`comment ${nodeId} minimized${reason === undefined ? '' : ` (${reason})`}`);
        break;
      }
      case 'createBranch': {
        const [name, from] = args as [string, string | undefined];
        lines.push(`branch ${name} from ${from ?? 'main'}`);
        break;
      }
      case 'deleteBranch':
        lines.push(`branch ${String(args[0])} deleted`);
        break;
      case 'commitFile': {
        const [input] = args as [CommitFileInput];
        lines.push(`commit on ${input.branch}: ${input.path} — ${input.message}`);
        break;
      }
      case 'createPullRequest': {
        const [input] = args as [CreatePullRequestInput];
        lines.push(`pull request "${input.title}" from ${input.head}:`, ...indent(input.body));
        break;
      }
      case 'closePullRequest':
        lines.push(`pull request #${String(args[0])} closed`);
        break;
      case 'deleteIssue':
        lines.push(`issue #${String(args[0])} deleted`);
        break;
      default:
        break;
    }
  }
  return lines;
}

function printFakeActivity(io: Io, calls: readonly FakeCall[]): void {
  const lines = describeFakeCalls(calls);
  if (lines.length === 0) {
    io.out('On the fake GitHub: nothing.\n');
    return;
  }
  io.out('On the fake GitHub:\n');
  for (const line of lines) io.out(`  ${line}\n`);
}

function indent(text: string): string[] {
  return text.split('\n').map((line) => `    ${line}`);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** `+7d 2h` against the wall clock, or `wall clock` when `/clock` never moved it. */
export function describeOffset(offsetMs: number): string {
  if (offsetMs === 0) return 'wall clock';
  const sign = offsetMs < 0 ? '-' : '+';
  let seconds = Math.round(Math.abs(offsetMs) / 1000);
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const parts = [
    ...(days === 0 ? [] : [`${days}d`]),
    ...(hours === 0 ? [] : [`${hours}h`]),
    ...(minutes === 0 ? [] : [`${minutes}m`]),
    ...(seconds === 0 && days + hours + minutes > 0 ? [] : [`${seconds}s`]),
  ];
  return `${sign}${parts.join(' ')} against the wall clock`;
}

/** Rows as aligned columns, two spaces in; no rows renders nothing. */
function columns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map(
    (row) =>
      `  ${row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join('  ')}`,
  );
}

function parseIssueNumber(value: string): number {
  const match = /^#?([1-9]\d*)$/.exec(value.trim());
  if (match?.[1] === undefined) throw new CliError(`Expected an issue number, got "${value}".`);
  return Number(match[1]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
