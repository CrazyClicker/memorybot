/**
 * GitHub client for the live loop (ROADMAP §6, T4.1).
 *
 * One thin wrapper over `@octokit/rest` (REST plus its GraphQL endpoint) for the handful of
 * operations the loop needs. Polling with a cursor, never webhooks (D16): `listIssues` takes
 * the `since` the loop stores, `listComments` likewise, and the loop keeps its own comment-id
 * cursor on top (§8). Every method takes and returns plain data, so the loop, the renderer and
 * the tests never see Octokit response objects; `FakeGithubClient` in `./fake-github.ts`
 * implements the same interface in memory.
 *
 * Identity (D13): a machine account with a classic PAT, or a GitHub App installed on the
 * repository. `githubAuthFromEnv` picks whichever `.env` provides. Deleting an issue needs the
 * owner's token (`pnpm live reset --issues`); every other method works with the bot identity.
 *
 * GitHub has no 🧠 reaction: `GithubReaction` is GitHub's own set, and the loop (T4.3) picks
 * one of them for acknowledged coach notes.
 */
import { readFileSync } from 'node:fs';

import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

export const DEFAULT_BRANCH = 'main';
export const WIKI_DIR = 'wiki';
const USER_AGENT = 'prilavok-memory-agent';
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------------------------
// Plain data
// ---------------------------------------------------------------------------------------------

export interface GithubRepo {
  readonly owner: string;
  readonly name: string;
}

/** `owner/name` as written in `live/config.yaml`. */
export function parseRepo(repo: GithubRepo | string): GithubRepo {
  if (typeof repo !== 'string') return repo;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo.trim());
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`GitHub repository must be "owner/name", got "${repo}"`);
  }
  return { owner: match[1], name: match[2] };
}

export type IssueState = 'open' | 'closed';

export interface GithubIssue {
  readonly number: number;
  /** GraphQL node id; `deleteIssue` needs it. */
  readonly nodeId: string;
  readonly title: string;
  readonly body: string;
  readonly state: IssueState;
  readonly author: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt?: string;
  readonly url: string;
}

export interface GithubComment {
  readonly id: number;
  /** GraphQL node id; `minimizeComment` needs it. */
  readonly nodeId: string;
  readonly issueNumber: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
}

export interface GithubPullRequest {
  readonly number: number;
  readonly nodeId: string;
  readonly title: string;
  readonly body: string;
  readonly state: IssueState;
  readonly merged: boolean;
  readonly mergedAt?: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
}

export interface GithubFile {
  /** Repository path, e.g. `wiki/dostavka.md`. */
  readonly path: string;
  readonly name: string;
  readonly content: string;
}

export const GITHUB_REACTIONS = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes',
] as const;
export type GithubReaction = (typeof GITHUB_REACTIONS)[number];

export const MINIMIZE_REASONS = ['SPAM', 'ABUSE', 'OFF_TOPIC', 'OUTDATED', 'DUPLICATE', 'RESOLVED'] as const;
export type MinimizeReason = (typeof MINIMIZE_REASONS)[number];
export const DEFAULT_MINIMIZE_REASON: MinimizeReason = 'OUTDATED';

export interface ListIssuesOptions {
  readonly label: string;
  /** ISO timestamp; only issues updated at or after it (GitHub's `since`). */
  readonly since?: string;
}

export interface ListCommentsOptions {
  /** ISO timestamp; only comments updated at or after it. */
  readonly since?: string;
}

export interface CommitFileInput {
  readonly branch: string;
  readonly path: string;
  readonly content: string;
  readonly message: string;
}

export interface CreatePullRequestInput {
  readonly head: string;
  readonly base?: string;
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
}

export interface ListPullRequestsOptions {
  readonly headPrefix: string;
  readonly state?: IssueState | 'all';
}

// ---------------------------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------------------------

export interface GithubClient {
  readonly repo: GithubRepo;
  /** The login the client acts as; the loop skips comments by it. */
  botLogin(): Promise<string>;

  listIssues(options: ListIssuesOptions): Promise<GithubIssue[]>;
  getIssue(number: number): Promise<GithubIssue>;
  /** Ascending by id, so the last element is the natural cursor. */
  listComments(number: number, options?: ListCommentsOptions): Promise<GithubComment[]>;
  createComment(number: number, body: string): Promise<GithubComment>;
  updateIssueBody(number: number, body: string): Promise<void>;
  addLabels(number: number, labels: readonly string[]): Promise<void>;
  /** A label the issue does not carry is not an error. */
  removeLabel(number: number, label: string): Promise<void>;
  addAssignees(number: number, logins: readonly string[]): Promise<void>;
  addReaction(commentId: number, reaction: GithubReaction): Promise<void>;
  minimizeComment(commentNodeId: string, reason?: MinimizeReason): Promise<void>;

  /** `wiki/*.md` at `ref`, README included; the caller decides what is a page. */
  readWiki(ref?: string): Promise<GithubFile[]>;
  /** Returns the sha the branch points at. Fails when the branch already exists. */
  createBranch(name: string, from?: string): Promise<string>;
  /** Create or update one file on a branch; returns the commit sha. */
  commitFile(input: CommitFileInput): Promise<string>;
  createPullRequest(input: CreatePullRequestInput): Promise<GithubPullRequest>;
  /** Pull requests whose head branch starts with `headPrefix`, ascending by number. */
  listPullRequests(options: ListPullRequestsOptions): Promise<GithubPullRequest[]>;
  closePullRequest(number: number): Promise<void>;
  /** A branch that does not exist is not an error. */
  deleteBranch(name: string): Promise<void>;
  /** GraphQL `deleteIssue`; needs the owner's token, the bot cannot do it. */
  deleteIssue(number: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Thrown by the fake; Octokit's `RequestError` carries the same `status` field. */
export class GithubRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubRequestError';
  }
}

export function githubErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export function isGithubNotFound(error: unknown): boolean {
  return githubErrorStatus(error) === 404;
}

/** GitHub returns tree entries in byte order; the fake and the mappers keep to it. */
export function compareByteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

export type GithubAuth =
  | { readonly kind: 'token'; readonly token: string }
  | {
      readonly kind: 'app';
      readonly appId: string;
      readonly installationId: string;
      /** PEM contents, not a path. */
      readonly privateKey: string;
    };

export const GITHUB_ENV = {
  token: 'GITHUB_TOKEN',
  appId: 'GITHUB_APP_ID',
  installationId: 'GITHUB_APP_INSTALLATION_ID',
  privateKeyPath: 'GITHUB_APP_PRIVATE_KEY_PATH',
} as const;

/**
 * `GITHUB_TOKEN` wins; otherwise the three `GITHUB_APP_*` variables together select App auth.
 * Returns undefined when nothing is configured, so callers can fall back to the fake (T4.6).
 */
export function githubAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readKey: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): GithubAuth | undefined {
  const token = env[GITHUB_ENV.token]?.trim();
  if (token !== undefined && token !== '') return { kind: 'token', token };

  const appId = env[GITHUB_ENV.appId]?.trim() ?? '';
  const installationId = env[GITHUB_ENV.installationId]?.trim() ?? '';
  const privateKeyPath = env[GITHUB_ENV.privateKeyPath]?.trim() ?? '';
  const provided = [appId, installationId, privateKeyPath].filter((value) => value !== '').length;
  if (provided === 0) return undefined;
  if (provided < 3) {
    throw new Error(
      `GitHub App auth needs ${GITHUB_ENV.appId}, ${GITHUB_ENV.installationId} and ` +
        `${GITHUB_ENV.privateKeyPath} together (or ${GITHUB_ENV.token} alone)`,
    );
  }
  return { kind: 'app', appId, installationId, privateKey: readKey(privateKeyPath) };
}

// ---------------------------------------------------------------------------------------------
// Octokit-backed client
// ---------------------------------------------------------------------------------------------

export interface GithubClientOptions {
  readonly repo: GithubRepo | string;
  readonly auth: GithubAuth;
  /** Injected by tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

export function createGithubClient(options: GithubClientOptions): GithubClient {
  return new OctokitGithubClient(options);
}

/** The subset of GitHub's JSON the mappers read; kept structural so tests can hand in literals. */
interface RawUser {
  readonly login: string;
}
interface RawLabel {
  readonly name?: string;
}
interface RawIssue {
  readonly number: number;
  readonly node_id: string;
  readonly title: string;
  readonly body?: string | null;
  readonly state: string;
  readonly user?: RawUser | null;
  readonly labels: readonly (string | RawLabel)[];
  readonly assignees?: readonly RawUser[] | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at?: string | null;
  readonly html_url: string;
  readonly pull_request?: unknown;
}
interface RawComment {
  readonly id: number;
  readonly node_id: string;
  readonly body?: string;
  readonly user?: RawUser | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly html_url: string;
}
interface RawPull {
  readonly number: number;
  readonly node_id: string;
  readonly title: string;
  readonly body?: string | null;
  readonly state: string;
  readonly merged_at?: string | null;
  readonly head: { readonly ref: string };
  readonly base: { readonly ref: string };
  readonly labels: readonly RawLabel[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly html_url: string;
}

function labelNames(labels: readonly (string | RawLabel)[]): string[] {
  return labels
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((name): name is string => typeof name === 'string' && name !== '');
}

function toIssue(raw: RawIssue): GithubIssue {
  return {
    number: raw.number,
    nodeId: raw.node_id,
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    author: raw.user?.login ?? '',
    labels: labelNames(raw.labels),
    assignees: (raw.assignees ?? []).map((user) => user.login),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    ...(raw.closed_at ? { closedAt: raw.closed_at } : {}),
    url: raw.html_url,
  };
}

function toComment(raw: RawComment, issueNumber: number): GithubComment {
  return {
    id: raw.id,
    nodeId: raw.node_id,
    issueNumber,
    author: raw.user?.login ?? '',
    body: raw.body ?? '',
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: raw.html_url,
  };
}

function toPull(raw: RawPull): GithubPullRequest {
  return {
    number: raw.number,
    nodeId: raw.node_id,
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    merged: typeof raw.merged_at === 'string',
    ...(raw.merged_at ? { mergedAt: raw.merged_at } : {}),
    headRef: raw.head.ref,
    baseRef: raw.base.ref,
    labels: labelNames(raw.labels),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: raw.html_url,
  };
}

const MINIMIZE_COMMENT = `mutation($subjectId: ID!, $classifier: ReportedContentClassifiers!) {
  minimizeComment(input: {subjectId: $subjectId, classifier: $classifier}) {
    minimizedComment { isMinimized }
  }
}`;

const DELETE_ISSUE = `mutation($issueId: ID!) {
  deleteIssue(input: {issueId: $issueId}) { clientMutationId }
}`;

const READ_TREE = `query($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      ... on Tree {
        entries { name type object { ... on Blob { text isBinary } } }
      }
    }
  }
}`;

interface TreeResponse {
  readonly repository: {
    readonly object: {
      readonly entries?: readonly {
        readonly name: string;
        readonly type: string;
        readonly object?: { readonly text?: string | null; readonly isBinary?: boolean | null } | null;
      }[];
    } | null;
  } | null;
}

export class OctokitGithubClient implements GithubClient {
  readonly repo: GithubRepo;
  private readonly octokit: Octokit;
  private readonly auth: GithubAuth;
  private login: Promise<string> | undefined;

  constructor(options: GithubClientOptions) {
    this.repo = parseRepo(options.repo);
    this.auth = options.auth;
    const request = options.fetch === undefined ? {} : { request: { fetch: options.fetch } };
    this.octokit =
      options.auth.kind === 'token'
        ? new Octokit({ auth: options.auth.token, userAgent: USER_AGENT, ...request })
        : new Octokit({
            authStrategy: createAppAuth,
            auth: {
              appId: options.auth.appId,
              installationId: options.auth.installationId,
              privateKey: options.auth.privateKey,
            },
            userAgent: USER_AGENT,
            ...request,
          });
  }

  private get base(): { owner: string; repo: string } {
    return { owner: this.repo.owner, repo: this.repo.name };
  }

  botLogin(): Promise<string> {
    this.login ??= this.fetchLogin();
    return this.login;
  }

  private async fetchLogin(): Promise<string> {
    if (this.auth.kind === 'token') {
      const { data } = await this.octokit.users.getAuthenticated();
      return data.login;
    }
    const { data } = await this.octokit.apps.getAuthenticated();
    const slug = data?.slug;
    if (typeof slug !== 'string' || slug === '') {
      throw new Error('GitHub App has no slug; cannot derive the bot login');
    }
    return `${slug}[bot]`;
  }

  async listIssues(options: ListIssuesOptions): Promise<GithubIssue[]> {
    const issues = await this.octokit.paginate(this.octokit.issues.listForRepo, {
      ...this.base,
      labels: options.label,
      state: 'all',
      ...(options.since === undefined ? {} : { since: options.since }),
      sort: 'updated',
      direction: 'asc',
      per_page: PAGE_SIZE,
    });
    return issues.filter((issue) => issue.pull_request === undefined).map(toIssue);
  }

  async getIssue(number: number): Promise<GithubIssue> {
    const { data } = await this.octokit.issues.get({ ...this.base, issue_number: number });
    return toIssue(data);
  }

  async listComments(number: number, options: ListCommentsOptions = {}): Promise<GithubComment[]> {
    const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
      ...this.base,
      issue_number: number,
      ...(options.since === undefined ? {} : { since: options.since }),
      per_page: PAGE_SIZE,
    });
    return comments.map((comment) => toComment(comment, number)).sort((a, b) => a.id - b.id);
  }

  async createComment(number: number, body: string): Promise<GithubComment> {
    const { data } = await this.octokit.issues.createComment({ ...this.base, issue_number: number, body });
    return toComment(data, number);
  }

  async updateIssueBody(number: number, body: string): Promise<void> {
    await this.octokit.issues.update({ ...this.base, issue_number: number, body });
  }

  async addLabels(number: number, labels: readonly string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.octokit.issues.addLabels({ ...this.base, issue_number: number, labels: [...labels] });
  }

  async removeLabel(number: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.removeLabel({ ...this.base, issue_number: number, name: label });
    } catch (error) {
      if (!isGithubNotFound(error)) throw error;
    }
  }

  async addAssignees(number: number, logins: readonly string[]): Promise<void> {
    if (logins.length === 0) return;
    await this.octokit.issues.addAssignees({ ...this.base, issue_number: number, assignees: [...logins] });
  }

  async addReaction(commentId: number, reaction: GithubReaction): Promise<void> {
    await this.octokit.reactions.createForIssueComment({
      ...this.base,
      comment_id: commentId,
      content: reaction,
    });
  }

  async minimizeComment(commentNodeId: string, reason: MinimizeReason = DEFAULT_MINIMIZE_REASON): Promise<void> {
    await this.octokit.graphql(MINIMIZE_COMMENT, { subjectId: commentNodeId, classifier: reason });
  }

  async readWiki(ref: string = DEFAULT_BRANCH): Promise<GithubFile[]> {
    const response = await this.octokit.graphql<TreeResponse>(READ_TREE, {
      owner: this.repo.owner,
      name: this.repo.name,
      expression: `${ref}:${WIKI_DIR}`,
    });
    const entries = response.repository?.object?.entries;
    if (entries === undefined) {
      throw new GithubRequestError(404, `${WIKI_DIR}/ not found at ${ref} in ${this.repo.owner}/${this.repo.name}`);
    }
    return entries
      .filter((entry) => entry.type === 'blob' && entry.name.endsWith('.md') && entry.object?.isBinary !== true)
      .map((entry) => ({ path: `${WIKI_DIR}/${entry.name}`, name: entry.name, content: entry.object?.text ?? '' }))
      .sort((a, b) => compareByteOrder(a.name, b.name));
  }

  async createBranch(name: string, from: string = DEFAULT_BRANCH): Promise<string> {
    const { data } = await this.octokit.git.getRef({ ...this.base, ref: `heads/${from}` });
    const sha = data.object.sha;
    await this.octokit.git.createRef({ ...this.base, ref: `refs/heads/${name}`, sha });
    return sha;
  }

  async commitFile(input: CommitFileInput): Promise<string> {
    let sha: string | undefined;
    try {
      const { data } = await this.octokit.repos.getContent({ ...this.base, path: input.path, ref: input.branch });
      if (!Array.isArray(data) && data.type === 'file') sha = data.sha;
    } catch (error) {
      if (!isGithubNotFound(error)) throw error;
    }
    const { data } = await this.octokit.repos.createOrUpdateFileContents({
      ...this.base,
      path: input.path,
      branch: input.branch,
      message: input.message,
      content: Buffer.from(input.content, 'utf8').toString('base64'),
      ...(sha === undefined ? {} : { sha }),
    });
    return data.commit.sha ?? '';
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GithubPullRequest> {
    const { data } = await this.octokit.pulls.create({
      ...this.base,
      head: input.head,
      base: input.base ?? DEFAULT_BRANCH,
      title: input.title,
      body: input.body,
    });
    const labels = input.labels ?? [];
    await this.addLabels(data.number, labels);
    const pull = toPull(data);
    return labels.length === 0 ? pull : { ...pull, labels: [...new Set([...pull.labels, ...labels])] };
  }

  async listPullRequests(options: ListPullRequestsOptions): Promise<GithubPullRequest[]> {
    const pulls = await this.octokit.paginate(this.octokit.pulls.list, {
      ...this.base,
      state: options.state ?? 'all',
      per_page: PAGE_SIZE,
    });
    return pulls
      .filter((pull) => pull.head.ref.startsWith(options.headPrefix))
      .map(toPull)
      .sort((a, b) => a.number - b.number);
  }

  async closePullRequest(number: number): Promise<void> {
    await this.octokit.pulls.update({ ...this.base, pull_number: number, state: 'closed' });
  }

  async deleteBranch(name: string): Promise<void> {
    try {
      await this.octokit.git.deleteRef({ ...this.base, ref: `heads/${name}` });
    } catch (error) {
      const status = githubErrorStatus(error);
      if (status !== 404 && status !== 422) throw error;
    }
  }

  async deleteIssue(number: number): Promise<void> {
    const issue = await this.getIssue(number);
    await this.octokit.graphql(DELETE_ISSUE, { issueId: issue.nodeId });
  }
}
