/**
 * In-memory `GithubClient` for tests and for `pnpm live` without a token (T4.6).
 *
 * Mirrors the GitHub semantics the loop relies on: issues and pull requests share one number
 * space, comment ids grow across issues, `updatedAt` moves on every comment, label, assignee
 * or body change (so `since` cursors work), timestamps are strictly increasing even when the
 * injected clock stands still, missing objects fail with status 404 like Octokit's
 * `RequestError`. The interface methods are what the loop calls and are recorded in `calls`;
 * the extra methods (`openIssue`, `commentAs`, `closeIssue`, `mergePullRequest`, `writeFile`)
 * play the people on GitHub.
 */
import { createHash } from 'node:crypto';

import {
  DEFAULT_BRANCH,
  DEFAULT_MINIMIZE_REASON,
  compareByteOrder,
  type CommitFileInput,
  type CreatePullRequestInput,
  type GithubClient,
  type GithubComment,
  type GithubFile,
  type GithubIssue,
  type GithubPullRequest,
  type GithubReaction,
  type GithubRepo,
  GithubRequestError,
  type ListCommentsOptions,
  type ListIssuesOptions,
  type ListPullRequestsOptions,
  type MinimizeReason,
  parseRepo,
  WIKI_DIR,
} from './github.ts';

export const FAKE_BOT_LOGIN = 'crazyclicker-bot';
export const FAKE_REPO = 'CrazyClicker/memorybot';

export interface FakeGithubOptions {
  readonly repo?: GithubRepo | string;
  readonly botLogin?: string;
  /** Source of timestamps; the fake keeps them strictly increasing on top of it. */
  readonly now?: () => string;
  /** Files on the default branch at start, by repository path. */
  readonly files?: Readonly<Record<string, string>>;
}

export interface OpenIssueInput {
  readonly title: string;
  readonly body?: string;
  readonly author: string;
  readonly labels?: readonly string[];
}

export interface FakeCall {
  readonly method: Exclude<keyof GithubClient, 'repo'>;
  readonly args: readonly unknown[];
}

export interface FakeReaction {
  readonly commentId: number;
  readonly reaction: GithubReaction;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function sha(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

export class FakeGithubClient implements GithubClient {
  readonly repo: GithubRepo;
  readonly login: string;
  /** Every interface call, in order, for asserting what the loop did. */
  readonly calls: FakeCall[] = [];
  readonly reactions: FakeReaction[] = [];
  /** Comment node id → reason. */
  readonly minimized = new Map<string, MinimizeReason>();
  readonly deletedIssues: number[] = [];

  private readonly now: () => string;
  private lastTimestamp = 0;
  private nextNumber = 1;
  private nextCommentId = 1;
  private readonly issues = new Map<number, Mutable<GithubIssue>>();
  private readonly comments = new Map<number, Mutable<GithubComment>>();
  private readonly pulls = new Map<number, Mutable<GithubPullRequest>>();
  private readonly branches = new Map<string, Map<string, string>>();

  constructor(options: FakeGithubOptions = {}) {
    this.repo = parseRepo(options.repo ?? FAKE_REPO);
    this.login = options.botLogin ?? FAKE_BOT_LOGIN;
    this.now = options.now ?? (() => new Date().toISOString());
    this.branches.set(DEFAULT_BRANCH, new Map(Object.entries(options.files ?? {})));
  }

  // -- people on GitHub ------------------------------------------------------------------------

  openIssue(input: OpenIssueInput): GithubIssue {
    const number = this.nextNumber++;
    const at = this.tick();
    const issue: Mutable<GithubIssue> = {
      number,
      nodeId: `I_${number}`,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      author: input.author,
      labels: [...new Set(input.labels ?? [])],
      assignees: [],
      createdAt: at,
      updatedAt: at,
      url: `${this.url()}/issues/${number}`,
    };
    this.issues.set(number, issue);
    return snapshotIssue(issue);
  }

  commentAs(number: number, author: string, body: string): GithubComment {
    const issue = this.requireIssue(number);
    const id = this.nextCommentId++;
    const at = this.touch(issue);
    const comment: Mutable<GithubComment> = {
      id,
      nodeId: `IC_${id}`,
      issueNumber: number,
      author,
      body,
      createdAt: at,
      updatedAt: at,
      url: `${issue.url}#issuecomment-${id}`,
    };
    this.comments.set(id, comment);
    return { ...comment };
  }

  closeIssue(number: number): void {
    const issue = this.requireIssue(number);
    issue.state = 'closed';
    issue.closedAt = this.touch(issue);
  }

  /** Copies the head branch's files onto the base branch, as a merge on GitHub would. */
  mergePullRequest(number: number): void {
    const pull = this.requirePull(number);
    if (pull.state !== 'open') throw new GithubRequestError(405, `Pull request #${number} is not open`);
    const head = this.requireBranch(pull.headRef);
    const base = this.requireBranch(pull.baseRef);
    for (const [path, content] of head) base.set(path, content);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = this.tick();
    pull.updatedAt = pull.mergedAt;
  }

  writeFile(path: string, content: string, branch: string = DEFAULT_BRANCH): void {
    this.requireBranch(branch).set(path, content);
  }

  files(branch: string = DEFAULT_BRANCH): GithubFile[] {
    return [...this.requireBranch(branch)]
      .map(([path, content]) => ({ path, name: path.slice(path.lastIndexOf('/') + 1), content }))
      .sort((a, b) => compareByteOrder(a.path, b.path));
  }

  comment(id: number): GithubComment | undefined {
    const comment = this.comments.get(id);
    return comment === undefined ? undefined : { ...comment };
  }

  // -- GithubClient ----------------------------------------------------------------------------

  async botLogin(): Promise<string> {
    this.record('botLogin');
    return this.login;
  }

  async listIssues(options: ListIssuesOptions): Promise<GithubIssue[]> {
    this.record('listIssues', options);
    const since = parseSince(options.since);
    const issues = [...this.issues.values()]
      .filter((issue) => issue.labels.includes(options.label) && Date.parse(issue.updatedAt) >= since)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.number - b.number)
      .map(snapshotIssue);
    return issues;
  }

  async getIssue(number: number): Promise<GithubIssue> {
    this.record('getIssue', number);
    return snapshotIssue(this.requireIssue(number));
  }

  async listComments(number: number, options: ListCommentsOptions = {}): Promise<GithubComment[]> {
    this.record('listComments', number, options);
    this.requireIssue(number);
    const since = parseSince(options.since);
    const comments = [...this.comments.values()]
      .filter((comment) => comment.issueNumber === number && Date.parse(comment.updatedAt) >= since)
      .sort((a, b) => a.id - b.id)
      .map((comment) => ({ ...comment }));
    return comments;
  }

  async createComment(number: number, body: string): Promise<GithubComment> {
    this.record('createComment', number, body);
    return this.commentAs(number, this.login, body);
  }

  async updateIssueBody(number: number, body: string): Promise<void> {
    this.record('updateIssueBody', number, body);
    const issue = this.requireIssue(number);
    issue.body = body;
    this.touch(issue);
  }

  async addLabels(number: number, labels: readonly string[]): Promise<void> {
    this.record('addLabels', number, labels);
    const issue = this.requireIssue(number);
    const merged = [...new Set([...issue.labels, ...labels])];
    if (merged.length !== issue.labels.length) {
      issue.labels = merged;
      this.touch(issue);
    }
  }

  async removeLabel(number: number, label: string): Promise<void> {
    this.record('removeLabel', number, label);
    const issue = this.requireIssue(number);
    if (issue.labels.includes(label)) {
      issue.labels = issue.labels.filter((name) => name !== label);
      this.touch(issue);
    }
  }

  async addAssignees(number: number, logins: readonly string[]): Promise<void> {
    this.record('addAssignees', number, logins);
    const issue = this.requireIssue(number);
    const merged = [...new Set([...issue.assignees, ...logins])];
    if (merged.length !== issue.assignees.length) {
      issue.assignees = merged;
      this.touch(issue);
    }
  }

  async addReaction(commentId: number, reaction: GithubReaction): Promise<void> {
    this.record('addReaction', commentId, reaction);
    if (!this.comments.has(commentId)) throw new GithubRequestError(404, `Comment ${commentId} not found`);
    this.reactions.push({ commentId, reaction });
  }

  async minimizeComment(commentNodeId: string, reason: MinimizeReason = DEFAULT_MINIMIZE_REASON): Promise<void> {
    this.record('minimizeComment', commentNodeId, reason);
    const exists = [...this.comments.values()].some((comment) => comment.nodeId === commentNodeId);
    if (!exists) throw new GithubRequestError(404, `Comment node ${commentNodeId} not found`);
    this.minimized.set(commentNodeId, reason);
  }

  async readWiki(ref: string = DEFAULT_BRANCH): Promise<GithubFile[]> {
    this.record('readWiki', ref);
    const prefix = `${WIKI_DIR}/`;
    const files = this.files(ref).filter(
      (file) => file.path.startsWith(prefix) && !file.name.includes('/') && file.name.endsWith('.md'),
    );
    return files;
  }

  async createBranch(name: string, from: string = DEFAULT_BRANCH): Promise<string> {
    this.record('createBranch', name, from);
    const source = this.requireBranch(from);
    if (this.branches.has(name)) throw new GithubRequestError(422, 'Reference already exists');
    this.branches.set(name, new Map(source));
    return branchSha(source);
  }

  async commitFile(input: CommitFileInput): Promise<string> {
    this.record('commitFile', input);
    const branch = this.requireBranch(input.branch);
    branch.set(input.path, input.content);
    return branchSha(branch);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GithubPullRequest> {
    this.record('createPullRequest', input);
    const base = input.base ?? DEFAULT_BRANCH;
    if (!this.branches.has(input.head) || !this.branches.has(base)) {
      throw new GithubRequestError(422, `Validation Failed: unknown branch ${input.head} or ${base}`);
    }
    const number = this.nextNumber++;
    const at = this.tick();
    const pull: Mutable<GithubPullRequest> = {
      number,
      nodeId: `PR_${number}`,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      headRef: input.head,
      baseRef: base,
      labels: [...new Set(input.labels ?? [])],
      createdAt: at,
      updatedAt: at,
      url: `${this.url()}/pull/${number}`,
    };
    this.pulls.set(number, pull);
    return snapshotPull(pull);
  }

  async listPullRequests(options: ListPullRequestsOptions): Promise<GithubPullRequest[]> {
    this.record('listPullRequests', options);
    const state = options.state ?? 'all';
    const pulls = [...this.pulls.values()]
      .filter((pull) => pull.headRef.startsWith(options.headPrefix) && (state === 'all' || pull.state === state))
      .sort((a, b) => a.number - b.number)
      .map(snapshotPull);
    return pulls;
  }

  async closePullRequest(number: number): Promise<void> {
    this.record('closePullRequest', number);
    const pull = this.requirePull(number);
    if (pull.state === 'open') {
      pull.state = 'closed';
      pull.updatedAt = this.tick();
    }
  }

  async deleteBranch(name: string): Promise<void> {
    this.record('deleteBranch', name);
    if (name === DEFAULT_BRANCH) throw new GithubRequestError(422, 'Cannot delete the default branch');
    this.branches.delete(name);
  }

  async deleteIssue(number: number): Promise<void> {
    this.record('deleteIssue', number);
    this.requireIssue(number);
    this.issues.delete(number);
    for (const [id, comment] of this.comments) {
      if (comment.issueNumber === number) this.comments.delete(id);
    }
    this.deletedIssues.push(number);
  }

  // -- internals -------------------------------------------------------------------------------

  private record(method: FakeCall['method'], ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private url(): string {
    return `https://github.com/${this.repo.owner}/${this.repo.name}`;
  }

  private tick(): string {
    const wall = Date.parse(this.now());
    const next = Math.max(Number.isFinite(wall) ? wall : 0, this.lastTimestamp + 1);
    this.lastTimestamp = next;
    return new Date(next).toISOString();
  }

  private touch(issue: Mutable<GithubIssue>): string {
    issue.updatedAt = this.tick();
    return issue.updatedAt;
  }

  private requireIssue(number: number): Mutable<GithubIssue> {
    const issue = this.issues.get(number);
    if (issue === undefined) throw new GithubRequestError(404, `Issue #${number} not found`);
    return issue;
  }

  private requirePull(number: number): Mutable<GithubPullRequest> {
    const pull = this.pulls.get(number);
    if (pull === undefined) throw new GithubRequestError(404, `Pull request #${number} not found`);
    return pull;
  }

  private requireBranch(name: string): Map<string, string> {
    const branch = this.branches.get(name);
    if (branch === undefined) throw new GithubRequestError(404, `Branch ${name} not found`);
    return branch;
  }
}

function parseSince(since: string | undefined): number {
  if (since === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(since);
  if (!Number.isFinite(parsed)) throw new GithubRequestError(422, `since must be an ISO timestamp, got "${since}"`);
  return parsed;
}

function branchSha(files: Map<string, string>): string {
  return sha(JSON.stringify([...files].sort(([a], [b]) => compareByteOrder(a, b))));
}

function snapshotIssue(issue: GithubIssue): GithubIssue {
  return { ...issue, labels: [...issue.labels], assignees: [...issue.assignees] };
}

function snapshotPull(pull: GithubPullRequest): GithubPullRequest {
  return { ...pull, labels: [...pull.labels] };
}
