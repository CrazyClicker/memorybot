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
 *   the wiki from `main`.
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
 */
import { AgentDidNotFinishError } from '../agent/index.ts';
import type { Outcome } from '../evals/schema.ts';
import { isHuman, type LiveConfig, sameLogin, sessionCustomers } from './config.ts';
import {
  FORM_MERCHANT_HEADING,
  issueMessage,
  parseCommand,
  parseIssueForm,
  resolveIssueCustomer,
} from './events.ts';
import type {
  GithubClient,
  GithubComment,
  GithubIssue,
  GithubPullRequest,
  GithubReaction,
} from './github.ts';
import { type ConsolidationTrigger, createRenderer, type LoopRenderer } from './render.ts';
import {
  ClockMovesForwardOnlyError,
  type Session,
  type SessionConsolidation,
  type SessionTurn,
  SessionTurnSchema,
  wikiPagesFromFiles,
} from './session.ts';
import type { EventRecord, ThreadRecord } from './state.ts';

export const PROPOSAL_BRANCH_PREFIX = 'wiki/proposal-';
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

export type Logger = (line: string) => void;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface LoopOptions {
  readonly session: Session;
  readonly github: GithubClient;
  readonly config: LiveConfig;
  readonly render?: LoopRenderer;
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
  private bot: string | undefined;

  constructor(options: LoopOptions) {
    this.session = options.session;
    this.github = options.github;
    this.config = options.config;
    this.render = options.render ?? createRenderer(
      options.config.memory_issue === undefined ? {} : { memoryIssue: options.config.memory_issue },
    );
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
        await this.handleComment(issue, comment, handled);
      }
      if (issue.state === 'closed' && !state.isProcessed(githubIds.close(issue.number))) {
        await this.handleClose(issue, handled);
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

  private async handleComment(issue: GithubIssue, comment: GithubComment, handled: HandledEvent[]): Promise<void> {
    const githubId = githubIds.comment(comment.id);
    const thread = this.session.state.threadByIssue(issue.number);
    if (thread === undefined) {
      this.skip(githubId, issue.number, 'the issue has no thread', handled);
      return;
    }
    if (isHuman(this.config, comment.author)) {
      await this.handleHumanComment(issue, comment, thread, handled);
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
        const posted = await this.consolidateThread(thread, issue.number, 'coach');
        await this.finishConsolidation(githubId, issue.number, 'coach', posted, handled, `${command.scope} note`);
        return;
      }
      case 'consolidate': {
        const posted = await this.consolidateThread(thread, issue.number, 'consolidate');
        await this.finishConsolidation(githubId, issue.number, 'consolidate', posted, handled);
        return;
      }
      default:
        return assertNever(command);
    }
  }

  private async handleClose(issue: GithubIssue, handled: HandledEvent[]): Promise<void> {
    const githubId = githubIds.close(issue.number);
    const thread = this.session.state.threadByIssue(issue.number);
    if (thread === undefined) {
      this.skip(githubId, issue.number, 'the issue has no thread', handled);
      return;
    }
    if (thread.closedAt === undefined) this.session.close(thread.id);
    const posted = await this.consolidateThread(thread, issue.number, 'close');
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

  /** Consolidate and comment; a close with nothing new to consolidate stays silent. */
  private async consolidateThread(
    thread: ThreadRecord,
    issueNumber: number,
    trigger: ConsolidationTrigger,
  ): Promise<{ result: SessionConsolidation; comment?: GithubComment }> {
    const result = await this.session.consolidate(thread.id);
    if (trigger === 'close' && result.events === 0) return { result };
    const body = this.render.consolidation(result, { issueNumber, thread: thread.id, trigger });
    const comment = await this.github.createComment(issueNumber, body);
    return { result, comment };
  }

  private async finishConsolidation(
    githubId: string,
    issueNumber: number,
    action: ConsolidationTrigger,
    posted: { result: SessionConsolidation; comment?: GithubComment },
    handled: HandledEvent[],
    what = 'consolidation',
  ): Promise<void> {
    const { result, comment } = posted;
    this.session.state.markProcessed(githubId, {
      issueNumber,
      result: {
        ...(comment === undefined ? {} : { comment: comment.id }),
        events: result.events,
        wrote: result.wrote.length,
      },
    });
    const detail = `${result.events} event(s), ${result.wrote.length} note(s)`;
    handled.push({ githubId, issue: issueNumber, action, ...(comment === undefined ? {} : { comment: comment.id }), detail });
    this.log(`#${issueNumber}: ${what} → ${detail}${comment === undefined ? '' : `, comment ${comment.id}`}`);
    if (result.wrote.length > 0) await this.refreshMemoryIssue(`#${issueNumber} ${action}`);
  }

  // -- proposals (T4.5 opens them; the loop follows their merge) -----------------------------

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
