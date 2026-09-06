import { describe, expect, it } from 'vitest';

import { FakeGithubClient } from './fake-github.ts';
import {
  createGithubClient,
  githubAuthFromEnv,
  isGithubNotFound,
  type GithubClient,
  parseRepo,
} from './github.ts';

// ---------------------------------------------------------------------------------------------
// Fake client: the semantics the loop relies on
// ---------------------------------------------------------------------------------------------

describe('FakeGithubClient', () => {
  const WIKI = {
    'wiki/README.md': '# absent facts',
    'wiki/dostavka.md': '---\nslug: dostavka\n---\nЗоны доставки',
    'wiki/notes.txt': 'not a page',
    'DOMAIN.md': 'not wiki',
  };

  function fixture() {
    const gh = new FakeGithubClient({ now: () => '2026-09-06T10:00:00.000Z', files: WIKI });
    const issue = gh.openIssue({ title: 'Импорт CSV', body: '### Магазин\n\nДом и сад', author: 'CrazyClicker', labels: ['support'] });
    return { gh, issue };
  }

  it('lists issues by label, updated since a cursor, oldest update first', async () => {
    const { gh, issue } = fixture();
    const other = gh.openIssue({ title: 'not support', author: 'CrazyClicker', labels: ['bug'] });
    const later = gh.openIssue({ title: 'second', author: 'CrazyClicker', labels: ['support'] });

    expect((await gh.listIssues({ label: 'support' })).map((i) => i.number)).toEqual([issue.number, later.number]);
    expect(other.number).toBe(2);

    // A comment on the first issue moves it past the cursor and to the end of the list.
    gh.commentAs(issue.number, 'CrazyClicker', 'ещё вопрос');
    const since = later.updatedAt;
    const updated = await gh.listIssues({ label: 'support', since });
    expect(updated.map((i) => i.number)).toEqual([later.number, issue.number]);
    expect(Date.parse(updated[1]!.updatedAt)).toBeGreaterThan(Date.parse(since));
  });

  it('keeps timestamps strictly increasing on a frozen clock', () => {
    const { gh, issue } = fixture();
    const a = gh.commentAs(issue.number, 'x', '1');
    const b = gh.commentAs(issue.number, 'x', '2');
    expect(Date.parse(b.createdAt)).toBeGreaterThan(Date.parse(a.createdAt));
  });

  it('numbers comments across issues and returns them ascending with a since filter', async () => {
    const { gh, issue } = fixture();
    const second = gh.openIssue({ title: 'second', author: 'CrazyClicker', labels: ['support'] });
    const c1 = gh.commentAs(issue.number, 'CrazyClicker', 'первый');
    const c2 = gh.commentAs(second.number, 'CrazyClicker', 'на другом');
    const bot = await gh.createComment(issue.number, 'ответ');

    expect([c1.id, c2.id, bot.id]).toEqual([1, 2, 3]);
    expect(bot.author).toBe('crazyclicker-bot');
    expect(bot.nodeId).toBe('IC_3');
    expect(bot.issueNumber).toBe(issue.number);

    expect((await gh.listComments(issue.number)).map((c) => c.id)).toEqual([1, 3]);
    expect((await gh.listComments(issue.number, { since: bot.createdAt })).map((c) => c.id)).toEqual([3]);
    expect((await gh.getIssue(issue.number)).updatedAt).toBe(bot.createdAt);
  });

  it('adds and removes labels and assignees idempotently, touching updatedAt only on change', async () => {
    const { gh, issue } = fixture();
    await gh.addLabels(issue.number, ['escalated', 'support']);
    const afterLabels = await gh.getIssue(issue.number);
    expect(afterLabels.labels).toEqual(['support', 'escalated']);
    expect(Date.parse(afterLabels.updatedAt)).toBeGreaterThan(Date.parse(issue.updatedAt));

    await gh.removeLabel(issue.number, 'nope');
    expect((await gh.getIssue(issue.number)).updatedAt).toBe(afterLabels.updatedAt);
    await gh.removeLabel(issue.number, 'escalated');
    expect((await gh.getIssue(issue.number)).labels).toEqual(['support']);

    await gh.addAssignees(issue.number, ['CrazyClicker']);
    await gh.addAssignees(issue.number, ['CrazyClicker']);
    expect((await gh.getIssue(issue.number)).assignees).toEqual(['CrazyClicker']);

    await gh.updateIssueBody(issue.number, 'new body');
    expect((await gh.getIssue(issue.number)).body).toBe('new body');
  });

  it('reacts to and minimizes existing comments, 404 otherwise', async () => {
    const { gh, issue } = fixture();
    const note = gh.commentAs(issue.number, 'CrazyClicker', '/coach причина в BOM');
    await gh.addReaction(note.id, 'eyes');
    await gh.minimizeComment(note.nodeId);
    expect(gh.reactions).toEqual([{ commentId: note.id, reaction: 'eyes' }]);
    expect(gh.minimized.get(note.nodeId)).toBe('OUTDATED');

    await expect(gh.addReaction(99, 'eyes')).rejects.toSatisfy(isGithubNotFound);
    await expect(gh.minimizeComment('IC_99')).rejects.toSatisfy(isGithubNotFound);
    await expect(gh.getIssue(99)).rejects.toSatisfy(isGithubNotFound);
  });

  it('reads wiki markdown only, README included, sorted by name', async () => {
    const { gh } = fixture();
    const files = await gh.readWiki();
    expect(files.map((f) => f.name)).toEqual(['README.md', 'dostavka.md']);
    expect(files[1]).toEqual({ path: 'wiki/dostavka.md', name: 'dostavka.md', content: WIKI['wiki/dostavka.md'] });
    await expect(gh.readWiki('nope')).rejects.toSatisfy(isGithubNotFound);
  });

  it('runs the proposal flow: branch, commit, PR, list by prefix, merge into main', async () => {
    const { gh, issue } = fixture();
    const sha = await gh.createBranch('wiki/proposal-a1');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await expect(gh.createBranch('wiki/proposal-a1')).rejects.toMatchObject({ status: 422 });

    const page = `${WIKI['wiki/dostavka.md']}\n\n## Обновление от 2026-09-06\n\nBOM ломает заголовок sku.`;
    const commit = await gh.commitFile({ branch: 'wiki/proposal-a1', path: 'wiki/dostavka.md', content: page, message: 'wiki: BOM' });
    expect(commit).not.toBe(sha);
    expect(gh.files('main').find((f) => f.path === 'wiki/dostavka.md')?.content).toBe(WIKI['wiki/dostavka.md']);

    const pr = await gh.createPullRequest({
      head: 'wiki/proposal-a1',
      title: 'wiki: BOM breaks the sku header',
      body: `Источник: #${issue.number}`,
      labels: ['proposal'],
    });
    expect(pr).toMatchObject({ number: 2, nodeId: 'PR_2', state: 'open', merged: false, headRef: 'wiki/proposal-a1', baseRef: 'main', labels: ['proposal'] });
    expect(pr.url).toBe('https://github.com/CrazyClicker/memorybot/pull/2');

    // The next issue takes the next number: one number space for issues and PRs.
    expect(gh.openIssue({ title: 'after', author: 'x' }).number).toBe(3);

    expect(await gh.listPullRequests({ headPrefix: 'wiki/' })).toEqual([pr]);
    expect(await gh.listPullRequests({ headPrefix: 'other/' })).toEqual([]);
    expect(await gh.listPullRequests({ headPrefix: 'wiki/', state: 'closed' })).toEqual([]);

    gh.mergePullRequest(pr.number);
    const merged = (await gh.listPullRequests({ headPrefix: 'wiki/' }))[0]!;
    expect(merged).toMatchObject({ merged: true, state: 'closed' });
    expect(merged.mergedAt).toBeDefined();
    expect((await gh.readWiki()).find((f) => f.name === 'dostavka.md')?.content).toBe(page);
    expect(() => gh.mergePullRequest(pr.number)).toThrow(/not open/);

    await gh.deleteBranch('wiki/proposal-a1');
    await gh.deleteBranch('wiki/proposal-a1');
    await expect(gh.readWiki('wiki/proposal-a1')).rejects.toSatisfy(isGithubNotFound);
  });

  it('closes a PR without merging and refuses PRs from unknown branches', async () => {
    const { gh } = fixture();
    await expect(gh.createPullRequest({ head: 'missing', title: 't', body: '' })).rejects.toMatchObject({ status: 422 });
    await gh.createBranch('wiki/proposal-b2');
    const pr = await gh.createPullRequest({ head: 'wiki/proposal-b2', title: 't', body: '' });
    await gh.closePullRequest(pr.number);
    const [closed] = await gh.listPullRequests({ headPrefix: 'wiki/' });
    expect(closed).toMatchObject({ state: 'closed', merged: false });
  });

  it('deletes an issue with its comments and records the interface calls', async () => {
    const { gh, issue } = fixture();
    gh.commentAs(issue.number, 'CrazyClicker', 'x');
    gh.closeIssue(issue.number);
    expect((await gh.getIssue(issue.number)).closedAt).toBeDefined();

    await gh.deleteIssue(issue.number);
    expect(gh.deletedIssues).toEqual([issue.number]);
    expect(gh.comment(1)).toBeUndefined();
    await expect(gh.getIssue(issue.number)).rejects.toSatisfy(isGithubNotFound);
    expect(await gh.listIssues({ label: 'support' })).toEqual([]);

    expect(gh.calls.map((c) => c.method)).toEqual(['getIssue', 'deleteIssue', 'getIssue', 'listIssues']);
    expect(await gh.botLogin()).toBe('crazyclicker-bot');
  });

  it('returns copies, so callers cannot mutate its state through results', async () => {
    const { gh, issue } = fixture();
    const [listed] = await gh.listIssues({ label: 'support' });
    (listed!.labels as string[]).push('hacked');
    expect((await gh.getIssue(issue.number)).labels).toEqual(['support']);
  });
});

// ---------------------------------------------------------------------------------------------
// Octokit client against a scripted fetch: request shapes and response mapping
// ---------------------------------------------------------------------------------------------

interface Recorded {
  readonly method: string;
  readonly url: URL;
  /** Decoded pathname: Octokit percent-encodes `:` and `/` inside path parameters. */
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

interface Route {
  readonly method: string;
  readonly path: string;
  readonly when?: (request: Recorded) => boolean;
  readonly status?: number;
  readonly data?: unknown;
}

function scriptedFetch(routes: Route[]) {
  const requests: Recorded[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const request: Recorded = { method: (init?.method ?? 'GET').toUpperCase(), url, path: decodeURIComponent(url.pathname), headers, body };
    requests.push(request);
    const route = routes.find(
      (r) => r.method === request.method && r.path === request.path && (r.when === undefined || r.when(request)),
    );
    if (route === undefined) {
      return Promise.resolve(json({ message: `unscripted ${request.method} ${url.pathname}` }, 599));
    }
    return Promise.resolve(json(route.data, route.status ?? (route.data === undefined ? 204 : 200)));
  };
  return { fetch: fetchImpl, requests };
}

function json(data: unknown, status: number): Response {
  return data === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const REPO = '/repos/CrazyClicker/memorybot';
const RAW_ISSUE = {
  number: 7,
  node_id: 'I_kwDO7',
  title: 'Импорт CSV',
  body: '### Магазин\n\nДом и сад',
  state: 'open',
  user: { login: 'CrazyClicker' },
  labels: [{ name: 'support' }, 'agent:answered', { name: '' }],
  assignees: [{ login: 'CrazyClicker' }],
  created_at: '2026-09-06T10:00:00Z',
  updated_at: '2026-09-06T10:05:00Z',
  closed_at: null,
  html_url: 'https://github.com/CrazyClicker/memorybot/issues/7',
};
const RAW_COMMENT = {
  id: 501,
  node_id: 'IC_kwDO501',
  body: '/coach причина в BOM',
  user: { login: 'CrazyClicker' },
  created_at: '2026-09-06T10:10:00Z',
  updated_at: '2026-09-06T10:10:00Z',
  html_url: 'https://github.com/CrazyClicker/memorybot/issues/7#issuecomment-501',
};
const RAW_PULL = {
  number: 9,
  node_id: 'PR_kwDO9',
  title: 'wiki: BOM breaks the sku header',
  body: 'Источник: #7',
  state: 'closed',
  merged_at: '2026-09-06T11:00:00Z',
  head: { ref: 'wiki/proposal-a1' },
  base: { ref: 'main' },
  labels: [{ name: 'proposal' }],
  created_at: '2026-09-06T10:30:00Z',
  updated_at: '2026-09-06T11:00:00Z',
  html_url: 'https://github.com/CrazyClicker/memorybot/pull/9',
};

function client(routes: Route[]): { gh: GithubClient; requests: Recorded[] } {
  const scripted = scriptedFetch(routes);
  const gh = createGithubClient({ repo: 'CrazyClicker/memorybot', auth: { kind: 'token', token: 'ghp_test' }, fetch: scripted.fetch });
  return { gh, requests: scripted.requests };
}

describe('OctokitGithubClient', () => {
  it('sends the token and caches the bot login', async () => {
    const { gh, requests } = client([{ method: 'GET', path: '/user', data: { login: 'crazyclicker-bot' } }]);
    expect(await gh.botLogin()).toBe('crazyclicker-bot');
    expect(await gh.botLogin()).toBe('crazyclicker-bot');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers['authorization']).toBe('token ghp_test');
    expect(gh.repo).toEqual({ owner: 'CrazyClicker', name: 'memorybot' });
  });

  it('lists support issues since a cursor, drops pull requests and maps the fields', async () => {
    const { gh, requests } = client([
      { method: 'GET', path: `${REPO}/issues`, data: [RAW_ISSUE, { ...RAW_ISSUE, number: 8, pull_request: { url: 'x' } }] },
    ]);
    const issues = await gh.listIssues({ label: 'support', since: '2026-09-06T10:00:00Z' });
    expect(issues).toEqual([
      {
        number: 7,
        nodeId: 'I_kwDO7',
        title: 'Импорт CSV',
        body: '### Магазин\n\nДом и сад',
        state: 'open',
        author: 'CrazyClicker',
        labels: ['support', 'agent:answered'],
        assignees: ['CrazyClicker'],
        createdAt: '2026-09-06T10:00:00Z',
        updatedAt: '2026-09-06T10:05:00Z',
        url: 'https://github.com/CrazyClicker/memorybot/issues/7',
      },
    ]);
    const query = Object.fromEntries(requests[0]!.url.searchParams);
    expect(query).toEqual({ labels: 'support', state: 'all', since: '2026-09-06T10:00:00Z', sort: 'updated', direction: 'asc', per_page: '100' });
  });

  it('omits since when there is no cursor and maps a closed issue without an author', async () => {
    const { gh, requests } = client([
      { method: 'GET', path: `${REPO}/issues`, data: [{ ...RAW_ISSUE, state: 'closed', closed_at: '2026-09-06T12:00:00Z', user: null, body: null, assignees: null }] },
    ]);
    const [issue] = await gh.listIssues({ label: 'support' });
    expect(issue).toMatchObject({ state: 'closed', closedAt: '2026-09-06T12:00:00Z', author: '', body: '', assignees: [] });
    expect(requests[0]!.url.searchParams.has('since')).toBe(false);
  });

  it('lists comments ascending by id and creates one', async () => {
    const { gh, requests } = client([
      { method: 'GET', path: `${REPO}/issues/7/comments`, data: [{ ...RAW_COMMENT, id: 502, node_id: 'IC_502' }, RAW_COMMENT] },
      { method: 'POST', path: `${REPO}/issues/7/comments`, status: 201, data: { ...RAW_COMMENT, id: 503, node_id: 'IC_503', body: 'ответ', user: { login: 'crazyclicker-bot' } } },
    ]);
    const comments = await gh.listComments(7, { since: '2026-09-06T10:00:00Z' });
    expect(comments.map((c) => c.id)).toEqual([501, 502]);
    expect(comments[0]).toEqual({
      id: 501,
      nodeId: 'IC_kwDO501',
      issueNumber: 7,
      author: 'CrazyClicker',
      body: '/coach причина в BOM',
      createdAt: '2026-09-06T10:10:00Z',
      updatedAt: '2026-09-06T10:10:00Z',
      url: 'https://github.com/CrazyClicker/memorybot/issues/7#issuecomment-501',
    });
    expect(requests[0]!.url.searchParams.get('since')).toBe('2026-09-06T10:00:00Z');

    const created = await gh.createComment(7, 'ответ');
    expect(created).toMatchObject({ id: 503, issueNumber: 7, author: 'crazyclicker-bot', body: 'ответ' });
    expect(requests[1]!.body).toEqual({ body: 'ответ' });
  });

  it('edits the body, labels, assignees and reactions through the REST endpoints', async () => {
    const { gh, requests } = client([
      { method: 'PATCH', path: `${REPO}/issues/7`, data: RAW_ISSUE },
      { method: 'POST', path: `${REPO}/issues/7/labels`, data: [] },
      { method: 'DELETE', path: `${REPO}/issues/7/labels/agent:asked`, data: [] },
      { method: 'DELETE', path: `${REPO}/issues/7/labels/missing`, status: 404, data: { message: 'Label does not exist' } },
      { method: 'POST', path: `${REPO}/issues/7/assignees`, status: 201, data: RAW_ISSUE },
      { method: 'POST', path: `${REPO}/issues/comments/501/reactions`, status: 201, data: { id: 1, content: 'eyes' } },
    ]);
    await gh.updateIssueBody(7, 'новое тело');
    await gh.addLabels(7, ['escalated']);
    await gh.addLabels(7, []);
    await gh.removeLabel(7, 'agent:asked');
    await gh.removeLabel(7, 'missing');
    await gh.addAssignees(7, ['CrazyClicker']);
    await gh.addReaction(501, 'eyes');

    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `PATCH ${REPO}/issues/7`,
      `POST ${REPO}/issues/7/labels`,
      `DELETE ${REPO}/issues/7/labels/agent:asked`,
      `DELETE ${REPO}/issues/7/labels/missing`,
      `POST ${REPO}/issues/7/assignees`,
      `POST ${REPO}/issues/comments/501/reactions`,
    ]);
    expect(requests[0]!.body).toEqual({ body: 'новое тело' });
    expect(requests[1]!.body).toEqual({ labels: ['escalated'] });
    expect(requests[4]!.body).toEqual({ assignees: ['CrazyClicker'] });
    expect(requests[5]!.body).toEqual({ content: 'eyes' });
  });

  it('rethrows non-404 failures', async () => {
    const { gh } = client([{ method: 'DELETE', path: `${REPO}/issues/7/labels/x`, status: 403, data: { message: 'Forbidden' } }]);
    await expect(gh.removeLabel(7, 'x')).rejects.toMatchObject({ status: 403 });
  });

  it('minimizes a comment and deletes an issue through GraphQL', async () => {
    const { gh, requests } = client([
      { method: 'POST', path: '/graphql', when: (r) => graphqlQuery(r).includes('minimizeComment'), data: { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } } },
      { method: 'GET', path: `${REPO}/issues/7`, data: RAW_ISSUE },
      { method: 'POST', path: '/graphql', when: (r) => graphqlQuery(r).includes('deleteIssue'), data: { data: { deleteIssue: { clientMutationId: null } } } },
    ]);
    await gh.minimizeComment('IC_kwDO501');
    expect(graphqlVariables(requests[0]!)).toEqual({ subjectId: 'IC_kwDO501', classifier: 'OUTDATED' });

    await gh.deleteIssue(7);
    expect(requests[1]!.path).toBe(`${REPO}/issues/7`);
    expect(graphqlVariables(requests[2]!)).toEqual({ issueId: 'I_kwDO7' });
  });

  it('surfaces GraphQL errors', async () => {
    const { gh } = client([
      { method: 'POST', path: '/graphql', data: { data: null, errors: [{ message: 'Resource not accessible by integration' }] } },
    ]);
    await expect(gh.minimizeComment('IC_x')).rejects.toThrow(/not accessible/);
  });

  it('reads wiki/*.md from a ref in one GraphQL request', async () => {
    const { gh, requests } = client([
      {
        method: 'POST',
        path: '/graphql',
        data: {
          data: {
            repository: {
              object: {
                entries: [
                  { name: 'dostavka.md', type: 'blob', object: { text: 'Зоны', isBinary: false } },
                  { name: 'README.md', type: 'blob', object: { text: '# absent', isBinary: false } },
                  { name: 'img.md', type: 'blob', object: { text: null, isBinary: true } },
                  { name: 'notes.txt', type: 'blob', object: { text: 'x', isBinary: false } },
                  { name: 'sub', type: 'tree', object: {} },
                ],
              },
            },
          },
        },
      },
    ]);
    const files = await gh.readWiki();
    expect(files).toEqual([
      { path: 'wiki/README.md', name: 'README.md', content: '# absent' },
      { path: 'wiki/dostavka.md', name: 'dostavka.md', content: 'Зоны' },
    ]);
    expect(graphqlVariables(requests[0]!)).toEqual({ owner: 'CrazyClicker', name: 'memorybot', expression: 'main:wiki' });
  });

  it('fails readWiki with 404 when the directory is missing at the ref', async () => {
    const { gh } = client([{ method: 'POST', path: '/graphql', data: { data: { repository: { object: null } } } }]);
    await expect(gh.readWiki('nope')).rejects.toSatisfy(isGithubNotFound);
  });

  it('creates a branch from main and commits a new and an existing file', async () => {
    const { gh, requests } = client([
      { method: 'GET', path: `${REPO}/git/ref/heads/main`, data: { object: { sha: 'abc123' } } },
      { method: 'POST', path: `${REPO}/git/refs`, status: 201, data: { ref: 'refs/heads/wiki/proposal-a1' } },
      { method: 'GET', path: `${REPO}/contents/wiki/new.md`, status: 404, data: { message: 'Not Found' } },
      { method: 'PUT', path: `${REPO}/contents/wiki/new.md`, status: 201, data: { commit: { sha: 'c1' } } },
      { method: 'GET', path: `${REPO}/contents/wiki/dostavka.md`, data: { type: 'file', sha: 'f0', content: '' } },
      { method: 'PUT', path: `${REPO}/contents/wiki/dostavka.md`, data: { commit: { sha: 'c2' } } },
    ]);
    expect(await gh.createBranch('wiki/proposal-a1')).toBe('abc123');
    expect(requests[1]!.body).toEqual({ ref: 'refs/heads/wiki/proposal-a1', sha: 'abc123' });

    expect(await gh.commitFile({ branch: 'wiki/proposal-a1', path: 'wiki/new.md', content: 'Привет', message: 'add' })).toBe('c1');
    expect(requests[2]!.url.searchParams.get('ref')).toBe('wiki/proposal-a1');
    expect(requests[3]!.body).toEqual({ branch: 'wiki/proposal-a1', message: 'add', content: Buffer.from('Привет').toString('base64') });

    expect(await gh.commitFile({ branch: 'wiki/proposal-a1', path: 'wiki/dostavka.md', content: 'v2', message: 'update' })).toBe('c2');
    expect(requests[5]!.body).toMatchObject({ sha: 'f0', branch: 'wiki/proposal-a1' });
  });

  it('opens a labelled pull request and lists them by head prefix with merge state', async () => {
    const { gh, requests } = client([
      { method: 'POST', path: `${REPO}/pulls`, status: 201, data: { ...RAW_PULL, state: 'open', merged_at: null, labels: [] } },
      { method: 'POST', path: `${REPO}/issues/9/labels`, data: [{ name: 'proposal' }] },
      { method: 'GET', path: `${REPO}/pulls`, data: [RAW_PULL, { ...RAW_PULL, number: 10, head: { ref: 'feature/x' } }] },
      { method: 'PATCH', path: `${REPO}/pulls/9`, data: RAW_PULL },
    ]);
    const pr = await gh.createPullRequest({ head: 'wiki/proposal-a1', title: 'wiki: BOM breaks the sku header', body: 'Источник: #7', labels: ['proposal'] });
    expect(pr).toMatchObject({ number: 9, state: 'open', merged: false, labels: ['proposal'], headRef: 'wiki/proposal-a1', baseRef: 'main' });
    expect(pr.mergedAt).toBeUndefined();
    expect(requests[0]!.body).toEqual({ head: 'wiki/proposal-a1', base: 'main', title: 'wiki: BOM breaks the sku header', body: 'Источник: #7' });
    expect(requests[1]!.body).toEqual({ labels: ['proposal'] });

    const pulls = await gh.listPullRequests({ headPrefix: 'wiki/' });
    expect(pulls).toEqual([
      {
        number: 9,
        nodeId: 'PR_kwDO9',
        title: 'wiki: BOM breaks the sku header',
        body: 'Источник: #7',
        state: 'closed',
        merged: true,
        mergedAt: '2026-09-06T11:00:00Z',
        headRef: 'wiki/proposal-a1',
        baseRef: 'main',
        labels: ['proposal'],
        createdAt: '2026-09-06T10:30:00Z',
        updatedAt: '2026-09-06T11:00:00Z',
        url: 'https://github.com/CrazyClicker/memorybot/pull/9',
      },
    ]);
    expect(Object.fromEntries(requests[2]!.url.searchParams)).toEqual({ state: 'all', per_page: '100' });

    await gh.closePullRequest(9);
    expect(requests[3]!.body).toEqual({ state: 'closed' });
  });

  it('deletes a branch and tolerates one that is already gone', async () => {
    const { gh, requests } = client([
      { method: 'DELETE', path: `${REPO}/git/refs/heads/wiki/proposal-a1` },
      { method: 'DELETE', path: `${REPO}/git/refs/heads/gone`, status: 422, data: { message: 'Reference does not exist' } },
    ]);
    await gh.deleteBranch('wiki/proposal-a1');
    await gh.deleteBranch('gone');
    expect(requests).toHaveLength(2);
  });
});

function graphqlQuery(request: Recorded): string {
  return String((request.body as { query?: unknown }).query ?? '');
}

function graphqlVariables(request: Recorded): unknown {
  return (request.body as { variables?: unknown }).variables;
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

describe('githubAuthFromEnv', () => {
  const readKey = (path: string) => `PEM:${path}`;

  it('prefers a token', () => {
    expect(githubAuthFromEnv({ GITHUB_TOKEN: ' ghp_x ', GITHUB_APP_ID: '1' }, readKey)).toEqual({ kind: 'token', token: 'ghp_x' });
  });

  it('reads App credentials with the private key from its path', () => {
    expect(
      githubAuthFromEnv(
        { GITHUB_TOKEN: '', GITHUB_APP_ID: '12', GITHUB_APP_INSTALLATION_ID: '34', GITHUB_APP_PRIVATE_KEY_PATH: '/k.pem' },
        readKey,
      ),
    ).toEqual({ kind: 'app', appId: '12', installationId: '34', privateKey: 'PEM:/k.pem' });
  });

  it('rejects a partial App configuration and returns undefined when nothing is set', () => {
    expect(() => githubAuthFromEnv({ GITHUB_APP_ID: '12' }, readKey)).toThrow(/together/);
    expect(githubAuthFromEnv({}, readKey)).toBeUndefined();
  });
});

describe('parseRepo', () => {
  it('splits owner/name and rejects anything else', () => {
    expect(parseRepo('CrazyClicker/memorybot')).toEqual({ owner: 'CrazyClicker', name: 'memorybot' });
    expect(parseRepo({ owner: 'a', name: 'b' })).toEqual({ owner: 'a', name: 'b' });
    expect(() => parseRepo('memorybot')).toThrow(/owner\/name/);
  });
});
