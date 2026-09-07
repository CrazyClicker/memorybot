import { describe, expect, it } from 'vitest';

import { loadLiveConfig } from './config.ts';
import { resolveIssueCustomer } from './events.ts';
import { FAKE_BOT_LOGIN } from './fake-github.ts';
import { fakeFromFixture, loadFixture, parseFixture, readWikiFiles } from './fixture.ts';

const WALL = '2026-09-07T10:00:00.000Z';

describe('recorded fixture', () => {
  it('numbers issues and comments in file order, plays closes and serves the wiki files', async () => {
    const fixture = parseFixture({
      events: [
        { issue: { title: 'Память', author: 'human' } },
        { issue: { title: 'Тикет', author: 'merchant', labels: ['support'], body: '### Магазин\n\nЛаванда\n' } },
        { comment: { issue: 2, author: 'human', body: '/consolidate' } },
        { close: { issue: 2 } },
      ],
    });
    const fake = fakeFromFixture(fixture, { files: { 'wiki/help.md': '---\nslug: help\n---\n' }, now: () => WALL });

    expect(await fake.botLogin()).toBe(FAKE_BOT_LOGIN);
    const support = await fake.listIssues({ label: 'support' });
    expect(support.map((issue) => [issue.number, issue.state, issue.author])).toEqual([[2, 'closed', 'merchant']]);
    expect((await fake.getIssue(1)).labels).toEqual([]);
    expect((await fake.listComments(2)).map((comment) => [comment.id, comment.author, comment.body])).toEqual([
      [1, 'human', '/consolidate'],
    ]);
    expect((await fake.readWiki()).map((file) => file.name)).toEqual(['help.md']);
  });

  it('rejects a reference to an issue the file has not opened yet, and unknown keys', () => {
    expect(() =>
      parseFixture({ events: [{ comment: { issue: 1, author: 'h', body: 'x' } }, { issue: { title: 'T', author: 'm' } }] }),
    ).toThrow(/refers to issue 1, but only 0 issue\(s\) were opened before it/);
    expect(() => parseFixture({ events: [{ close: { issue: 3 } }] }, 'f.yaml')).toThrow(/Invalid fixture f\.yaml/);
    expect(() => parseFixture({ issues: [] })).toThrow(/Invalid fixture/);
  });

  it('ships a recording that matches live/config.yaml: the memory issue first, the tickets resolvable', async () => {
    const [fixture, config, files] = await Promise.all([loadFixture(), loadLiveConfig(), readWikiFiles()]);
    const fake = fakeFromFixture(fixture, { files });

    expect((await fake.getIssue(config.memory_issue ?? 0)).title).toContain('Память агента');
    const tickets = await fake.listIssues({ label: config.labels.support });
    expect(tickets.length).toBeGreaterThan(0);
    for (const ticket of tickets) expect(resolveIssueCustomer(ticket, config)?.via).toBe('form');
    expect(Object.keys(files)).toContain('wiki/README.md');
    expect((await fake.readWiki()).length).toBe(Object.keys(files).length);
  });
});
