/**
 * The live loop (ROADMAP §6, T4.3): poll GitHub, map what changed to session events by the
 * table in §6, act, record. Everything the agent, the engines and the wiki do is the
 * `Session` (T4.2); this file only decides *which* session call a GitHub object means and
 * what goes back to GitHub.
 *
 * Contract:
 * - The merchant of an issue is the form's «Магазин» field, else the author's login through
 *   the map in `live/config.yaml`; humans are the logins listed there; the bot's own comments
 *   are skipped. A merchant comment is a `customer_message` and an agent turn unless the issue
 *   is `escalated`; a human comment is a `human_reply`, or one of `/coach [product] …`,
 *   `/clock <ISO>`, `/consolidate`; a closed issue consolidates; a merged proposal PR reloads
 *   the wiki from `main`. Every consolidation opens a pull request for each documentation
 *   candidate that has none (T4.5); the proposal row in the state is the idempotency key.
 * - Idempotency (§8): every GitHub object the loop acts on has an id in `processed`
 *   (`issue:N`, `comment:ID`, `close:N`, `pr:N:merged`). The id is marked processed in the
 *   same transaction that links the posted comment to the session event, immediately after
 *   `createComment` and before the labels, so a crash re-runs the step but never posts twice.
 *   A turn recorded before a crash is posted on the next poll without calling the agent.
 * - Errors on one issue are logged and never stop the loop; the issue cursor is held back so
 *   that issue is listed again next poll. `AgentDidNotFinishError` posts nothing, retries on
 *   the next two polls, then labels `agent:failed`.
 * - The cursor is `meta.issues_since`: GitHub's `since` (updated at or after) with the latest
 *   `updatedAt` of the issues handled completely. Comments of a listed issue are fetched in
 *   full; `processed` makes re-listing harmless.
 * - What goes back to GitHub is rendered by `render.ts` (T4.4). The pinned memory issue named
 *   in `live/config.yaml` is repainted after every write and every clock move, best effort,
 *   and is never handled as a ticket even when it carries the support label.
 * - `coach` and `moveClock` are the command-line forms of `/coach` and `/clock` (T4.6, D12):
 *   the same session calls and the same consolidation, but no GitHub object, so nothing is
 *   marked processed and the note itself never reaches GitHub.
 */
import { AgentDidNotFinishError } from '../agent/index.ts';
import type { Outcome } from '../evals/schema.ts';
import { wikiUpdateSection } from '../wiki/index.ts';
import { isHuman, type LiveConfig, sameLogin, sessionCustomers } from './config.ts';
import {
  FORM_MERCHANT_HEADING,
  issueMessage,
  parseCommand,
  parseIssueForm,
  resolveIssueCustomer,
} from './events.ts';
import {
  DEFAULT_BRANCH,
  type GithubClient,
  type GithubComment,
  type GithubFile,
  type GithubIssue,
  githubErrorStatus,
  type GithubPullRequest,
  type GithubReaction,
} from './github.ts';
import {
  appendWikiUpdate,
  createPageChooser,
  DEFAULT_LEAK_README,
  findWikiFile,
  leakMatches,
  loadLeakPattern,
  type PageChooser,
  parseProposalMarker,
  PROPOSAL_BRANCH_PREFIX,
  proposalBranch,
  proposalMarker,
} from './proposals.ts';
import {
  type ConsolidationTrigger,
  createRenderer,
  type LoopRenderer,
  type ProposalLink,
} from './render.ts';
import {
  ClockMovesForwardOnlyError,
  type Session,
  type SessionConsolidation,
  type SessionTurn,
  SessionTurnSchema,
  wikiPagesFromFiles,
} from './session.ts';
import type { EventRecord, ThreadRecord } from './state.ts';

export { PROPOSAL_BRANCH_PREFIX } from './proposals.ts';
/** GitHub has no 🧠; this is the acknowledgement on an accepted coach note. */
export const COACH_REACTION: GithubReaction = 'eyes';
export const MAX_TURN_ATTEMPTS = 3;
export const ISSUES_SINCE_KEY = 'issues_since';
const ATTEMPTS_PREFIX = 'attempts:';

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

export function threadIdFor(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

/** Ids in `processed` and on events, one per GitHub object the loop acts on. */
export const githubIds = {
  issue: (number: number): string => `issue:${number}`,
  comment: (id: number): string => `comment:${id}`,
  close: (number: number): string => `close:${number}`,
  merged: (pullNumber: number): string => `pr:${pullNumber}:merged`,
} as const;

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export type LoopAction =
  | Outcome
  | 'human_reply'
  | 'coach'
  | 'clock'
  | 'consolidate'
  | 'close'
  | 'wiki_update'
  | 'failed'
  | 'skipped';

export interface HandledEvent {
  readonly githubId: string;
  readonly issue?: number;
  readonly action: LoopAction;
  /** The comment the loop posted, when it posted one. */
  readonly comment?: number;
  /** Documentation-proposal pull requests this consolidation opened (T4.5). */
  readonly proposals?: number[];
  readonly detail?: string;
}

export interface PollError {
  readonly issue?: number;
  readonly githubId?: string;
  readonly message: string;
}

export interface PollResult {
  /** Issues the listing returned this poll. */
  readonly issues: number;
  readonly handled: HandledEvent[];
  readonly errors: PollError[];
  /** The cursor stored for the next poll. */
  readonly since?: string;
}

/** What one consolidation produced: the engine's result, the comment and the proposals. */
interface Consolidated {
  readonly result: SessionConsolidation;
  readonly comment?: GithubComment;
  readonly proposals: ProposalLink[];
}

/** `pnpm live coach <issue> [--product] <text>`: the private coach path. */
export interface CoachInput {
  readonly issue: number;
  readonly author: string;
  readonly text: string;
  /** `product` is the human broadcast gate (D7); defaults to `customer`. */
  readonly scope?: 'customer' | 'product';
}

export interface CoachResult {
  readonly issue: number;
  readonly thread: string;
  readonly result: SessionConsolidation;
  /** The consolidation comment the loop posted, when it posted one. */
  readonly comment?: number;
  readonly proposals: ProposalLink[];
  /** Proposal pull requests that could not be opened; the consolidation itself succeeded. */
  readonly errors: PollError[];
}

export type Logger = (line: string) => void;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface LoopOptions {
  readonly session: Session;
  readonly github: GithubClient;
  readonly config: LiveConfig;
  readonly render?: LoopRenderer;
  /** Picks the wiki page of a proposal; built from the session config's agent model by default. */
  readonly choosePage?: PageChooser;
  /** The `wiki/README.md` leak grep; `false` turns the lint off, absent reads the file. */
  readonly leakPattern?: RegExp | false;
  readonly log?: Logger;
  readonly sleep?: Sleep;
}

/** `HH:MM:SS line` on stdout; the poller log is on camera (§9). */
export function consoleLogger(clock: () => Date = () => new Date()): Logger {
  return (line) => {
    console.log(`${clock().toISOString().slice(11, 19)} ${line}`);
  };
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------------------------

export class LiveLoop {
  readonly session: Session;
  readonly github: GithubClient;
  readonly config: LiveConfig;

  private readonly render: LoopRenderer;
  private readonly log: Logger;
  private readonly sleep: Sleep;
  private readonly leakOption: RegExp | false | undefined;
  private bot: string | undefined;
  private chooser: PageChooser | undefined;
  private leak: RegExp | undefined;
  private leakLoaded = false;

  constructor(options: LoopOptions) {
    this.session = options.session;
    this.github = options.github;
    this.config = options.config;
    this.render = options.render ?? createRenderer(
      options.config.memory_issue === undefined ? {} : { memoryIssue: options.config.memory_issue },
    );
    this.chooser = options.choosePage;
    this.leakOption = options.leakPattern;
    this.log = options.log ?? consoleLogger();
    this.sleep = options.sleep ?? abortableSleep;
  }

  get pollMs(): number {
    return this.config.poll_seconds * 1000;
  }

  /** Poll until `signal` aborts. A poll that throws as a whole is logged and tried again. */
  async run(signal?: AbortSignal): Promise<void> {
    const { owner, name } = this.github.repo;
    this.log(`polling ${owner}/${name} for "${this.config.labels.support}" every ${this.config.poll_seconds} s`);
    while (!isAborted(signal)) {
      try {
        await this.poll();
      } catch (error) {
        this.log(`poll failed: ${describe(error)}`);
      }
      if (isAborted(signal)) break;
      await this.sleep(this.pollMs, signal);
    }
    this.log('stopped');
  }

  /** One pass: merged proposals first (the wiki the next answer reads), then the issues. */
  async poll(): Promise<PollResult> {
    const handled: HandledEvent[] = [];
    const errors: PollError[] = [];
    const bot = await this.botLogin();
    const state = this.session.state;

    await this.pollProposals(handled, errors);

    const since = state.get(ISSUES_SINCE_KEY);
    const issues = await this.github.listIssues({
      label: this.config.labels.support,
      ...(since === undefined ? {} : { since }),
    });
    let latest = since;
    let holdBack: string | undefined;
    for (const issue of issues) {
      if (issue.number === this.config.memory_issue) continue;
      const complete = await this.processIssue(issue, bot, handled, errors);
      if (complete) latest = laterIso(latest, issue.updatedAt);
      else holdBack = earlierIso(holdBack, issue.updatedAt);
    }
    const next = holdBack === undefined ? latest : earlierIso(holdBack, latest);
    if (next !== undefined && next !== since) state.set(ISSUES_SINCE_KEY, next);
    return { issues: issues.length, handled, errors, ...(next === undefined ? {} : { since: next }) };
  }

  // -- command-line entry points (T4.6) ------------------------------------------------------

  /**
   * The private coach path (`pnpm live coach`, D12): the note is recorded on the session and
   * never posted, then the thread is consolidated exactly as after a `/coach` comment — the
   * proposal pull requests, the consolidation comment and the memory issue included. Nothing
   * goes into `processed`: there is no GitHub object to guard against.
   */
  async coach(input: CoachInput): Promise<CoachResult> {
    const thread = this.session.state.threadByIssue(input.issue);
    if (thread === undefined) {
      throw new Error(`Issue #${input.issue} has no thread: the loop has not seen it yet`);
    }
    const scope = input.scope ?? 'customer';
    this.session.coachNote({ thread: thread.id, author: input.author, content: input.text, scope });
    this.log(`#${input.issue}: ${scope} coach note by ${input.author} recorded privately`);
    const errors: PollError[] = [];
    const posted = await this.consolidateThread(thread, input.issue, 'coach', errors);
    await this.reportConsolidation(input.issue, `${scope} note`, posted, 'coach');
    return {
      issue: input.issue,
      thread: thread.id,
      result: posted.result,
      ...(posted.comment === undefined ? {} : { comment: posted.comment.id }),
      proposals: posted.proposals,
      errors,
    };
  }

  /** `/clock` from the command line (`pnpm live clock`): move the clock, repaint the memory issue. */
  async moveClock(target: string): Promise<string> {
    const now = this.session.setClock(target);
    this.log(`clock → ${now}`);
    await this.refreshMemoryIssue('the clock move');
    return now;
  }

  // -- issues --------------------------------------------------------------------------------

  /** Opening, then comments by id, then the close; the first error stops this issue. */
  private async processIssue(
    issue: GithubIssue,
    bot: string,
    handled: HandledEvent[],
    errors: PollError[],
  ): Promise<boolean> {
    const state = this.session.state;
    try {
      if (!state.isProcessed(githubIds.issue(issue.number))) await this.handleOpening(issue, handled);
      const comments = await this.github.listComments(issue.number);
      for (const comment of comments) {
        if (sameLogin(comment.author, bot) || state.isProcessed(githubIds.comment(comment.id))) continue;
        await this.handleComment(issue, comment, handled, errors);
      }
      if (issue.state === 'closed' && !state.isProcessed(githubIds.close(issue.number))) {
        await this.handleClose(issue, handled, errors);
      }
      return true;
    } catch (error) {
      const message = describe(error);
      errors.push({ issue: issue.number, message });
      this.log(`#${issue.number}: ${message}; will retry next poll`);
      return false;
    }
  }

  private async handleOpening(issue: GithubIssue, handled: HandledEvent[]): Promise<void> {
    const githubId = githubIds.issue(issue.number);
    const form = parseIssueForm(issue.body);
    const resolved = resolveIssueCustomer(issue, this.config, form);
    if (resolved === undefined) {
      this.skip(
        githubId,
        issue.number,
        `no merchant: "${FORM_MERCHANT_HEADING}" names no configured customer and "${issue.author}" is not in the login map`,
        handled,
      );
      return;
    }
    const threadId = threadIdFor(issue.number);
    this.session.customerMessage({
      thread: threadId,
      customer: resolved.id,
      content: issueMessage(issue, form),
      githubId,
      issueNumber: issue.number,
    });
    this.log(`#${issue.number}: ${resolved.id} (via ${resolved.via}) opened "${issue.title}"`);
    if (issue.state !== 'open') {
      this.skip(githubId, issue.number, 'issue already closed; recorded without an answer', handled);
      return;
    }
    await this.answer(issue, threadId, githubId, handled);
  }

  private async handleComment(
    issue: GithubIssue,
    comment: GithubComment,
    handled: HandledEvent[],
    errors: PollError[],
  ): Promise<void> {
    const githubId = githubIds.comment(comment.id);
    const thread = this.session.state.threadByIssue(issue.number);
    if (thread === undefined) {
      this.skip(githubId, issue.number, 'the issue has no thread', handled);
      return;
    }
    if (isHuman(this.config, comment.author)) {
      await this.handleHumanComment(issue, comment, thread, handled, errors);
      return;
    }
    if (thread.closedAt !== undefined) {
      this.skip(githubId, issue.number, 'the thread is closed', handled);
      return;
    }
    this.session.customerMessage({ thread: thread.id, customer: thread.customer, content: comment.body, githubId });
    if (this.isEscalated(issue, thread.id)) {
      this.skip(githubId, issue.number, 'escalated: recorded, the human answers', handled);
      return;
    }
    await this.answer(issue, thread.id, githubId, handled);
  }

  private async handleHumanComment(
    issue: GithubIssue,
    comment: GithubComment,
    thread: ThreadRecord,
    handled: HandledEvent[],
    errors: PollError[],
  ): Promise<void> {
    const githubId = githubIds.comment(comment.id);
    const state = this.session.state;
    const command = parseCommand(comment.body);
    if (command === undefined) {
      if (thread.closedAt !== undefined) {
        this.skip(githubId, issue.number, 'the thread is closed', handled);
        return;
      }
      this.session.humanReply({ thread: thread.id, author: comment.author, content: comment.body, githubId });
      state.markProcessed(githubId, { issueNumber: issue.number, result: { human_reply: true } });
      handled.push({ githubId, issue: issue.number, action: 'human_reply' });
      this.log(`#${issue.number}: human reply by ${comment.author} recorded`);
      return;
    }
    switch (command.kind) {
      case 'invalid':
        this.skip(githubId, issue.number, `/${command.command}: ${command.reason}`, handled);
        return;
      case 'clock': {
        let now: string;
        try {
          now = this.session.setClock(command.target);
        } catch (error) {
          if (!(error instanceof ClockMovesForwardOnlyError)) throw error;
          this.skip(githubId, issue.number, error.message, handled);
          return;
        }
        state.markProcessed(githubId, { issueNumber: issue.number, result: { clock: now } });
        handled.push({ githubId, issue: issue.number, action: 'clock', detail: now });
        this.log(`#${issue.number}: clock → ${now}`);
        await this.refreshMemoryIssue('the clock move');
        return;
      }
      case 'coach': {
        this.session.coachNote({
          thread: thread.id,
          author: comment.author,
          content: command.text,
          scope: command.scope,
          githubId,
        });
        await this.github.addReaction(comment.id, COACH_REACTION);
        await this.github.minimizeComment(comment.nodeId);
        const posted = await this.consolidateThread(thread, issue.number, 'coach', errors);
        await this.finishConsolidation(githubId, issue.number, 'coach', posted, handled, `${command.scope} note`);
        return;
      }
      case 'consolidate': {
        const posted = await this.consolidateThread(thread, issue.number, 'consolidate', errors);
        await this.finishConsolidation(githubId, issue.number, 'consolidate', posted, handled);
        return;
      }
      default:
        return assertNever(command);
    }
  }

  private async handleClose(issue: GithubIssue, handled: HandledEvent[], errors: PollError[]): Promise<void> {
    const githubId = githubIds.close(issue.number);
    const thread = this.session.state.threadByIssue(issue.number);
    if (thread === undefined) {
      this.skip(githubId, issue.number, 'the issue has no thread', handled);
      return;
    }
    if (thread.closedAt === undefined) this.session.close(thread.id);
    const posted = await this.consolidateThread(thread, issue.number, 'close', errors);
    await this.finishConsolidation(githubId, issue.number, 'close', posted, handled);
  }

  // -- the agent turn ------------------------------------------------------------------------

  /**
   * Run (or recover) the turn for `githubId`, post it, then mark it processed together with
   * the comment id, then label. Nothing is posted when the agent does not finish.
   */
  private async answer(issue: GithubIssue, threadId: string, githubId: string, handled: HandledEvent[]): Promise<void> {
    const state = this.session.state;
    const attemptsKey = ATTEMPTS_PREFIX + githubId;
    let turn: SessionTurn;
    let replyEventId: number;

    const pending = this.unpostedReply(threadId);
    if (pending !== undefined) {
      turn = SessionTurnSchema.parse(pending.payload);
      replyEventId = pending.id;
      this.log(`#${issue.number}: posting the reply recorded before a restart (${turn.id})`);
    } else {
      try {
        turn = await this.session.agentTurn(threadId);
      } catch (error) {
        if (!(error instanceof AgentDidNotFinishError)) throw error;
        const attempts = Number(state.get(attemptsKey) ?? '0') + 1;
        if (attempts < MAX_TURN_ATTEMPTS) {
          state.set(attemptsKey, String(attempts));
          throw new Error(
            `agent did not finish (attempt ${attempts} of ${MAX_TURN_ATTEMPTS}), nothing posted: ${error.message}`,
            { cause: error },
          );
        }
        await this.github.addLabels(issue.number, [this.config.labels.failed]);
        state.transaction(() => {
          state.markProcessed(githubId, { issueNumber: issue.number, result: { failed: error.message, attempts } });
          state.delete(attemptsKey);
        });
        handled.push({ githubId, issue: issue.number, action: 'failed', detail: error.message });
        this.log(`#${issue.number}: agent did not finish ${attempts} times; labelled ${this.config.labels.failed}`);
        return;
      }
      const event = state.events(threadId).find((candidate) => candidate.turnId === turn.id);
      if (event === undefined) throw new Error(`Turn ${turn.id} left no agent_reply event on ${threadId}`);
      replyEventId = event.id;
    }

    const comment = await this.github.createComment(
      issue.number,
      this.render.reply(turn, { issue, thread: threadId, wiki: this.session.wiki }),
    );
    state.transaction(() => {
      state.setEventGithubId(replyEventId, githubIds.comment(comment.id));
      state.markProcessed(githubId, {
        issueNumber: issue.number,
        result: { comment: comment.id, turn: turn.id, outcome: turn.outcome },
      });
      state.delete(attemptsKey);
    });
    const cost = turn.costUsd === undefined ? '' : `, $${turn.costUsd.toFixed(4)}`;
    const detail = `${(turn.responseLatencyMs / 1000).toFixed(1)} s${cost}`;
    handled.push({ githubId, issue: issue.number, action: turn.outcome, comment: comment.id, detail });
    this.log(`#${issue.number}: ${githubId} → ${turn.outcome} (${detail}), comment ${comment.id}`);

    try {
      await this.applyOutcome(issue, turn.outcome);
    } catch (error) {
      this.log(`#${issue.number}: comment posted but labels not applied: ${describe(error)}`);
    }
    if (turn.memoryWrites.length > 0) await this.refreshMemoryIssue(`#${issue.number} ${turn.id}`);
  }

  /** `answer` → `agent:answered`; `ask` → `agent:asked`; `escalate` → `escalated` + the humans. */
  private async applyOutcome(issue: GithubIssue, outcome: Outcome): Promise<void> {
    const { labels, humans } = this.config;
    switch (outcome) {
      case 'answer':
        await this.github.addLabels(issue.number, [labels.answered]);
        await this.github.removeLabel(issue.number, labels.asked);
        return;
      case 'ask':
        await this.github.addLabels(issue.number, [labels.asked]);
        await this.github.removeLabel(issue.number, labels.answered);
        return;
      case 'escalate':
        await this.github.addLabels(issue.number, [labels.escalated]);
        await this.github.removeLabel(issue.number, labels.asked);
        await this.github.removeLabel(issue.number, labels.answered);
        await this.github.addAssignees(issue.number, humans);
        return;
      default:
        return assertNever(outcome);
    }
  }

  /** A turn recorded but never posted: the thread's last event is an unlinked `agent_reply`. */
  private unpostedReply(threadId: string): EventRecord | undefined {
    const last = this.session.state.events(threadId).at(-1);
    return last?.type === 'agent_reply' && last.githubId === undefined && last.turnId !== undefined ? last : undefined;
  }

  /** The label on the issue, or an `escalate` outcome in the state (the label lags one poll). */
  private isEscalated(issue: GithubIssue, threadId: string): boolean {
    return (
      issue.labels.includes(this.config.labels.escalated) ||
      this.session.turns(threadId).some((turn) => turn.outcome === 'escalate')
    );
  }

  // -- consolidation -------------------------------------------------------------------------

  /**
   * Consolidate, open the proposal pull requests, then comment with their links; a close with
   * nothing new to consolidate stays silent and opens nothing. A crash between the pull
   * requests and the comment loses the comment, never a pull request: the proposal rows are
   * written as each one is opened.
   */
  private async consolidateThread(
    thread: ThreadRecord,
    issueNumber: number,
    trigger: ConsolidationTrigger,
    errors: PollError[],
  ): Promise<Consolidated> {
    const result = await this.session.consolidate(thread.id);
    if (trigger === 'close' && result.events === 0) return { result, proposals: [] };
    const proposals = await this.openProposals(issueNumber, result.at, errors);
    const body = this.render.consolidation(result, { issueNumber, thread: thread.id, trigger, proposals });
    const comment = await this.github.createComment(issueNumber, body);
    return { result, comment, proposals };
  }

  private async finishConsolidation(
    githubId: string,
    issueNumber: number,
    action: ConsolidationTrigger,
    posted: Consolidated,
    handled: HandledEvent[],
    what = 'consolidation',
  ): Promise<void> {
    const { result, comment } = posted;
    const proposals = posted.proposals.map((link) => link.number);
    this.session.state.markProcessed(githubId, {
      issueNumber,
      result: {
        ...(comment === undefined ? {} : { comment: comment.id }),
        events: result.events,
        wrote: result.wrote.length,
        ...(proposals.length === 0 ? {} : { proposals }),
      },
    });
    handled.push({
      githubId,
      issue: issueNumber,
      action,
      ...(comment === undefined ? {} : { comment: comment.id }),
      ...(proposals.length === 0 ? {} : { proposals }),
      detail: consolidationDetail(posted),
    });
    await this.reportConsolidation(issueNumber, what, posted, action);
  }

  /** The log line and the memory-issue repaint every consolidation ends with, GitHub-triggered or not. */
  private async reportConsolidation(
    issueNumber: number,
    what: string,
    posted: Consolidated,
    after: string,
  ): Promise<void> {
    const { comment } = posted;
    this.log(
      `#${issueNumber}: ${what} → ${consolidationDetail(posted)}${comment === undefined ? '' : `, comment ${comment.id}`}`,
    );
    if (posted.result.wrote.length > 0) await this.refreshMemoryIssue(`#${issueNumber} ${after}`);
  }

  // -- proposals (T4.5) ----------------------------------------------------------------------

  /**
   * A pull request for every documentation candidate that has none yet. Candidates come from
   * every thread, not only the consolidated one (§6): an item whose pull request failed — a
   * GitHub hiccup, a chooser that did not answer — is picked up by the next consolidation of
   * any thread, and an `about: product` write by the agent gets its pull request the same way.
   * Each item fails on its own: the error is reported, the consolidation comment still goes out.
   */
  private async openProposals(issueNumber: number, at: string, errors: PollError[]): Promise<ProposalLink[]> {
    const items = await this.session.newProposals();
    if (items.length === 0) return [];

    const state = this.session.state;
    const links: ProposalLink[] = [];
    let opened: Map<string, GithubPullRequest>;
    try {
      opened = await this.proposalPullsByBranch();
    } catch (error) {
      // Without the listing a crashed pass cannot be told from a fresh one, and a second pull
      // request is worse than a late one: report it, comment, and try at the next consolidation.
      const message = `proposal pull requests not listed: ${describe(error)}`;
      errors.push({ issue: issueNumber, message });
      this.log(`#${issueNumber}: ${message}; proposals will be opened at the next consolidation`);
      return [];
    }
    const leak = await this.leakPattern();
    const merchants = this.merchantNames();
    let files: GithubFile[] | undefined;
    const mainWiki = async (): Promise<GithubFile[]> => (files ??= await this.github.readWiki());

    for (const item of items) {
      try {
        const branch = proposalBranch(item.id);
        const sourceThread = item.source.thread;

        // Opened before a crash, with no state row: adopt it instead of opening a second one.
        const already = opened.get(branch);
        if (already !== undefined) {
          const page = parseProposalMarker(already.body)?.page ?? (await this.pageOnBranch(branch, await mainWiki()));
          if (page === undefined) {
            throw new Error(`pull request #${already.number} on ${branch} names no wiki page; close it by hand`);
          }
          state.recordProposal({ itemId: item.id, pullNumber: already.number, branch, page, sourceThread });
          links.push({ number: already.number, page, url: already.url });
          this.log(`proposal ${item.id}: adopted #${already.number} opened on ${branch} before a restart`);
          continue;
        }

        const choice = await this.choosePage()(this.session.wiki, item);
        const file = findWikiFile(await mainWiki(), choice.slug);
        if (file === undefined) throw new Error(`wiki page "${choice.slug}" is not on ${DEFAULT_BRANCH}`);
        const addition = wikiUpdateSection(item.statement, at);
        const page = this.session.wiki.pages.find((candidate) => candidate.slug === choice.slug);
        const sourceIssue = state.thread(sourceThread)?.issueNumber;
        const rendered = this.render.proposal({
          item,
          page: page ?? { slug: choice.slug, title: choice.slug },
          ...(choice.why === '' ? {} : { why: choice.why }),
          ...(choice.title === undefined ? {} : { title: choice.title }),
          ...(sourceIssue === undefined ? {} : { sourceIssue }),
          addition,
          at,
          ...(leak === undefined ? {} : { leak: leakMatches(addition, leak, merchants) }),
        });

        await this.createProposalBranch(branch);
        await this.github.commitFile({
          branch,
          path: file.path,
          content: appendWikiUpdate(file.content, item.statement, at),
          message: `wiki(${choice.slug}): proposal from ${item.id}`,
        });
        const pull = await this.github.createPullRequest({
          head: branch,
          title: rendered.title,
          body: `${rendered.body}\n\n${proposalMarker(item.id, choice.slug)}`,
          labels: [this.config.labels.proposal],
        });
        state.recordProposal({ itemId: item.id, pullNumber: pull.number, branch, page: choice.slug, sourceThread });
        links.push({ number: pull.number, page: choice.slug, url: pull.url });
        const cost = choice.costUsd === undefined ? 'cost unknown' : `$${choice.costUsd.toFixed(4)}`;
        this.log(`#${issueNumber}: proposal ${item.id} → PR #${pull.number} on \`${choice.slug}\` (${cost})`);
      } catch (error) {
        const message = `proposal for ${item.id} not opened: ${describe(error)}`;
        errors.push({ issue: issueNumber, message });
        this.log(`#${issueNumber}: ${message}; it will be retried at the next consolidation`);
      }
    }
    return links;
  }

  /** Every proposal pull request by head branch; the state row is what marks an item as done. */
  private async proposalPullsByBranch(): Promise<Map<string, GithubPullRequest>> {
    const pulls = await this.github.listPullRequests({ headPrefix: PROPOSAL_BRANCH_PREFIX, state: 'all' });
    return new Map(pulls.map((pull) => [pull.headRef, pull]));
  }

  /** The page a branch changes, for a pull request whose body no longer carries the marker. */
  private async pageOnBranch(branch: string, main: readonly GithubFile[]): Promise<string | undefined> {
    const byPath = new Map(main.map((file) => [file.path, file.content]));
    const changed = (await this.github.readWiki(branch)).find((file) => byPath.get(file.path) !== file.content);
    return changed === undefined ? undefined : wikiPagesFromFiles([changed])[0]?.slug;
  }

  /** A branch with no pull request behind it was left by a crash: restart it from `main`. */
  private async createProposalBranch(branch: string): Promise<void> {
    try {
      await this.github.createBranch(branch);
    } catch (error) {
      if (githubErrorStatus(error) !== 422) throw error;
      await this.github.deleteBranch(branch);
      await this.github.createBranch(branch);
      this.log(`branch ${branch} left by an earlier attempt was recreated from ${DEFAULT_BRANCH}`);
    }
  }

  private choosePage(): PageChooser {
    this.chooser ??= createPageChooser({ modelSpec: this.session.config.agent });
    return this.chooser;
  }

  /** Names and form values of the configured merchants; none of them may reach a wiki page. */
  private merchantNames(): string[] {
    return [...new Set(Object.values(this.config.customers).flatMap((customer) => [customer.name, customer.form]))];
  }

  /** The leak grep, read from `wiki/README.md` once; a missing block turns the lint off. */
  private async leakPattern(): Promise<RegExp | undefined> {
    if (this.leakLoaded) return this.leak;
    this.leakLoaded = true;
    if (this.leakOption !== undefined) {
      this.leak = this.leakOption === false ? undefined : this.leakOption;
      return this.leak;
    }
    let reason = `no grep block in ${DEFAULT_LEAK_README}`;
    try {
      this.leak = await loadLeakPattern();
    } catch (error) {
      reason = describe(error);
    }
    if (this.leak === undefined) this.log(`wiki leak lint is off: ${reason}`);
    return this.leak;
  }

  // -- proposals merged by a human -----------------------------------------------------------

  private async pollProposals(handled: HandledEvent[], errors: PollError[]): Promise<void> {
    const state = this.session.state;
    const open = state.proposals().filter((proposal) => proposal.status === 'open');
    if (open.length === 0) return;
    let pulls: GithubPullRequest[];
    try {
      pulls = await this.github.listPullRequests({ headPrefix: PROPOSAL_BRANCH_PREFIX, state: 'all' });
    } catch (error) {
      errors.push({ message: `listing proposal pull requests: ${describe(error)}` });
      this.log(`proposal pull requests not listed: ${describe(error)}`);
      return;
    }
    const byNumber = new Map(pulls.map((pull) => [pull.number, pull]));
    let reloaded = false;
    for (const proposal of open) {
      const pull = byNumber.get(proposal.pullNumber);
      if (pull === undefined || pull.state === 'open') continue;
      const githubId = githubIds.merged(pull.number);
      const source = state.thread(proposal.sourceThread);
      try {
        if (!pull.merged) {
          state.setProposalStatus(proposal.itemId, 'closed');
          this.log(`PR #${pull.number} closed without merging; proposal ${proposal.itemId} dropped`);
          continue;
        }
        if (!reloaded) {
          this.session.wikiReload(wikiPagesFromFiles(await this.github.readWiki()));
          reloaded = true;
          this.log('wiki reloaded from main');
        }
        const comment = source?.issueNumber === undefined
          ? undefined
          : await this.github.createComment(
              source.issueNumber,
              this.render.wikiUpdated(proposal, pull, { wiki: this.session.wiki }),
            );
        state.transaction(() => {
          state.setProposalStatus(proposal.itemId, 'merged');
          state.markProcessed(githubId, {
            ...(source?.issueNumber === undefined ? {} : { issueNumber: source.issueNumber }),
            result: { ...(comment === undefined ? {} : { comment: comment.id }), page: proposal.page },
          });
        });
        handled.push({
          githubId,
          ...(source?.issueNumber === undefined ? {} : { issue: source.issueNumber }),
          action: 'wiki_update',
          ...(comment === undefined ? {} : { comment: comment.id }),
          detail: proposal.page,
        });
        this.log(`PR #${pull.number} merged: wiki page ${proposal.page} updated`);
      } catch (error) {
        errors.push({ ...(source?.issueNumber === undefined ? {} : { issue: source.issueNumber }), githubId, message: describe(error) });
        this.log(`PR #${pull.number}: ${describe(error)}; will retry next poll`);
      }
    }
  }

  // -- the pinned memory issue (T4.4) --------------------------------------------------------

  /**
   * Repaint the «🧠 Память агента» body after every write and every clock move (what counts as
   * expired is a function of the clock). Best effort, like the labels: the write is already
   * recorded, a failure is logged, and the next write repaints the whole body anyway.
   */
  private async refreshMemoryIssue(after: string): Promise<void> {
    const number = this.config.memory_issue;
    if (number === undefined) return;
    try {
      const items = await this.session.memoryItems();
      const body = this.render.memoryIssue(items, {
        now: this.session.now(),
        customers: sessionCustomers(this.config),
      });
      await this.github.updateIssueBody(number, body);
      this.log(`memory issue #${number} repainted after ${after}: ${items.length} note(s)`);
    } catch (error) {
      this.log(`memory issue #${number} not repainted after ${after}: ${describe(error)}`);
    }
  }

  // -- internals -----------------------------------------------------------------------------

  private async botLogin(): Promise<string> {
    this.bot ??= await this.github.botLogin();
    return this.bot;
  }

  private skip(githubId: string, issueNumber: number, reason: string, handled: HandledEvent[]): void {
    this.session.state.markProcessed(githubId, { issueNumber, result: { skipped: reason } });
    handled.push({ githubId, issue: issueNumber, action: 'skipped', detail: reason });
    this.log(`#${issueNumber}: ${githubId} skipped: ${reason}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** «3 event(s), 1 note(s), 1 PR(s)»: what a consolidation produced, for the log and the handled event. */
function consolidationDetail(posted: Consolidated): string {
  return [
    `${posted.result.events} event(s)`,
    `${posted.result.wrote.length} note(s)`,
    ...(posted.proposals.length === 0 ? [] : [`${posted.proposals.length} PR(s)`]),
  ].join(', ');
}

function laterIso(a: string | undefined, b: string): string {
  return a === undefined || Date.parse(b) > Date.parse(a) ? b : a;
}

function earlierIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/** A function call, so the compiler does not narrow `aborted` across the awaits in `run`. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value ${JSON.stringify(value)}`);
}
