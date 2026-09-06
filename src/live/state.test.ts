import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LiveState, toThreadEvent } from './state.ts';

const WALL = '2026-09-06T10:00:00.000Z';
const AT = '2026-09-06T10:00:00Z';

const open: LiveState[] = [];
const tempDirs: string[] = [];

function state(path = ':memory:'): LiveState {
  const result = new LiveState({ path, clock: () => new Date(WALL) });
  open.push(result);
  return result;
}

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'live-state-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

afterEach(async () => {
  for (const value of open.splice(0)) value.close();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('LiveState threads and events', () => {
  it('opens threads with their issue number and appends events in order', () => {
    const db = state();
    const thread = db.openThread({ id: 'issue-5', customer: 'dom_i_sad', issueNumber: 5, openedAt: AT });
    expect(thread).toEqual({
      id: 'issue-5',
      customer: 'dom_i_sad',
      issueNumber: 5,
      openedAt: AT,
      consolidatedEvents: 0,
    });
    expect(db.threadByIssue(5)).toEqual(thread);
    expect(db.threadByIssue(6)).toBeUndefined();

    const first = db.appendEvent('issue-5', { type: 'customer_message', at: AT, content: 'Импорт' }, { githubId: 'issue:5' });
    const second = db.appendEvent(
      'issue-5',
      { type: 'coach_note', at: AT, author: 'CrazyClicker', scope: 'product', content: 'BOM' },
      { githubId: 'comment:1' },
    );
    expect(first).toEqual({
      id: 1,
      thread: 'issue-5',
      type: 'customer_message',
      at: AT,
      content: 'Импорт',
      githubId: 'issue:5',
      recordedAt: WALL,
    });
    expect(second).toMatchObject({ id: 2, author: 'CrazyClicker', scope: 'product', githubId: 'comment:1' });
    expect(db.events('issue-5').map((event) => event.id)).toEqual([1, 2]);
    expect(db.transcript('issue-5')).toEqual({
      id: 'issue-5',
      customer: 'dom_i_sad',
      events: [
        { type: 'customer_message', at: AT, content: 'Импорт' },
        { type: 'coach_note', at: AT, author: 'CrazyClicker', scope: 'product', content: 'BOM' },
      ],
    });
    expect(toThreadEvent(second)).toEqual(db.transcript('issue-5').events[1]);
  });

  it('rejects duplicate thread ids and issue numbers, and events on unknown threads', () => {
    const db = state();
    db.openThread({ id: 'a', customer: 'x', issueNumber: 1, openedAt: AT });
    expect(() => db.openThread({ id: 'a', customer: 'x', openedAt: AT })).toThrow(/already exists/);
    expect(() => db.openThread({ id: 'b', customer: 'x', issueNumber: 1, openedAt: AT })).toThrow(/Issue #1/);
    expect(() => db.appendEvent('nope', { type: 'customer_message', at: AT, content: 'x' })).toThrow(/Unknown thread/);
    expect(() => db.closeThread('nope', AT)).toThrow(/Unknown thread/);
  });

  it('returns the existing row for a GitHub id it already recorded, never a second one', () => {
    const db = state();
    db.openThread({ id: 'a', customer: 'x', openedAt: AT });
    db.openThread({ id: 'b', customer: 'y', openedAt: AT });
    const first = db.appendEvent('a', { type: 'customer_message', at: AT, content: 'one' }, { githubId: 'comment:7' });
    const again = db.appendEvent('a', { type: 'customer_message', at: AT, content: 'changed' }, { githubId: 'comment:7' });
    expect(again).toEqual(first);
    expect(db.events('a')).toHaveLength(1);
    expect(db.eventByGithubId('comment:7')?.content).toBe('one');
    expect(() => db.appendEvent('b', { type: 'customer_message', at: AT, content: 'x' }, { githubId: 'comment:7' }))
      .toThrow(/already belongs to thread "a"/);
  });

  it('keeps a turn payload on the event and links it to the posted comment later', () => {
    const db = state();
    db.openThread({ id: 'a', customer: 'x', openedAt: AT });
    const reply = db.appendEvent(
      'a',
      { type: 'agent_reply', at: AT, content: 'Ответ' },
      { turnId: 'turn-1', payload: { outcome: 'answer', nested: { list: [1, 2] } } },
    );
    expect(reply.turnId).toBe('turn-1');
    expect(reply.payload).toEqual({ outcome: 'answer', nested: { list: [1, 2] } });
    expect(reply.githubId).toBeUndefined();

    db.setEventGithubId(reply.id, 'comment:9');
    expect(db.event(reply.id)?.githubId).toBe('comment:9');
    expect(db.eventByGithubId('comment:9')?.turnId).toBe('turn-1');
    expect(() => db.setEventGithubId(99, 'comment:10')).toThrow(/Unknown event 99/);
  });

  it('closes threads and tracks the consolidated event count', () => {
    const db = state();
    db.openThread({ id: 'a', customer: 'x', openedAt: AT });
    expect(db.closeThread('a', '2026-09-06T11:00:00Z').closedAt).toBe('2026-09-06T11:00:00Z');
    expect(db.transcript('a').closedAt).toBe('2026-09-06T11:00:00Z');
    db.setConsolidatedEvents('a', 3);
    expect(db.thread('a')?.consolidatedEvents).toBe(3);
    expect(() => db.setConsolidatedEvents('a', -1)).toThrow(/non-negative/);
  });

  it('lists threads oldest first', () => {
    const db = state();
    db.openThread({ id: 'later', customer: 'x', openedAt: '2026-09-06T12:00:00Z' });
    db.openThread({ id: 'earlier', customer: 'x', openedAt: '2026-09-06T09:00:00Z' });
    expect(db.threads().map((thread) => thread.id)).toEqual(['earlier', 'later']);
  });
});

describe('LiveState meta, clock, processed ids and proposals', () => {
  it('stores meta values and the clock offset', () => {
    const db = state();
    expect(db.get('cursor')).toBeUndefined();
    db.set('cursor', '123');
    db.set('cursor', '124');
    expect(db.get('cursor')).toBe('124');
    db.delete('cursor');
    expect(db.get('cursor')).toBeUndefined();

    expect(db.clockOffsetMs()).toBe(0);
    db.setClockOffsetMs(86_400_000);
    expect(db.clockOffsetMs()).toBe(86_400_000);
    expect(() => db.setClockOffsetMs(Number.NaN)).toThrow(/finite/);
    db.set('clock_offset_ms', 'garbage');
    expect(() => db.clockOffsetMs()).toThrow(/Corrupt clock offset/);
  });

  it('marks GitHub events processed with what the loop did', () => {
    const db = state();
    expect(db.isProcessed('comment:1')).toBe(false);
    expect(db.markProcessed('comment:1', { issueNumber: 5, result: { comment: 8 } })).toEqual({
      githubId: 'comment:1',
      issueNumber: 5,
      result: { comment: 8 },
      processedAt: WALL,
    });
    expect(db.isProcessed('comment:1')).toBe(true);
    expect(db.markProcessed('comment:1')).toEqual({ githubId: 'comment:1', processedAt: WALL });
  });

  it('maps proposal items to pull requests and moves their status', () => {
    const db = state();
    const record = db.recordProposal({
      itemId: 'notes-3',
      pullNumber: 12,
      branch: 'wiki/proposal-notes-3',
      page: 'import-csv',
      sourceThread: 'issue-5',
    });
    expect(record).toEqual({
      itemId: 'notes-3',
      pullNumber: 12,
      branch: 'wiki/proposal-notes-3',
      page: 'import-csv',
      sourceThread: 'issue-5',
      status: 'open',
      createdAt: WALL,
      updatedAt: WALL,
    });
    expect(db.proposalByPull(12)).toEqual(record);
    expect(() => db.recordProposal({ ...record })).toThrow(/already exists/);
    expect(db.setProposalStatus('notes-3', 'merged').status).toBe('merged');
    expect(db.proposals().map((proposal) => proposal.status)).toEqual(['merged']);
    expect(() => db.setProposalStatus('nope', 'closed')).toThrow(/Unknown proposal/);
  });
});

describe('LiveState transactions and persistence', () => {
  it('rolls back everything a failing transaction wrote, savepoints included', () => {
    const db = state();
    db.openThread({ id: 'a', customer: 'x', openedAt: AT });
    expect(() =>
      db.transaction(() => {
        db.appendEvent('a', { type: 'customer_message', at: AT, content: 'one' });
        db.markProcessed('comment:1');
        db.transaction(() => {
          db.set('cursor', '1');
        });
        throw new Error('post failed');
      }),
    ).toThrow('post failed');
    expect(db.events('a')).toEqual([]);
    expect(db.isProcessed('comment:1')).toBe(false);
    expect(db.get('cursor')).toBeUndefined();

    // An inner failure that the outer transaction handles keeps the outer writes.
    db.transaction(() => {
      db.set('cursor', '2');
      try {
        db.transaction(() => {
          db.set('cursor', '3');
          throw new Error('inner');
        });
      } catch {
        // handled
      }
    });
    expect(db.get('cursor')).toBe('2');
  });

  it('survives close and reopen on a file, and reset empties it', async () => {
    const path = await tempFile();
    const first = state(path);
    first.openThread({ id: 'a', customer: 'x', issueNumber: 3, openedAt: AT });
    first.appendEvent('a', { type: 'customer_message', at: AT, content: 'one' }, { githubId: 'issue:3' });
    first.setClockOffsetMs(1000);
    first.markProcessed('issue:3');
    first.recordProposal({ itemId: 'n1', pullNumber: 4, branch: 'b', page: 'p', sourceThread: 'a' });
    first.close();
    open.pop();

    const second = state(path);
    expect(second.threadByIssue(3)?.id).toBe('a');
    expect(second.events('a').map((event) => event.content)).toEqual(['one']);
    expect(second.clockOffsetMs()).toBe(1000);
    expect(second.isProcessed('issue:3')).toBe(true);
    expect(second.proposal('n1')?.pullNumber).toBe(4);

    second.reset();
    expect(second.threads()).toEqual([]);
    expect(second.clockOffsetMs()).toBe(0);
    expect(second.isProcessed('issue:3')).toBe(false);
    expect(second.proposals()).toEqual([]);
    // Event ids restart too, so a fresh demo reads from 1.
    second.openThread({ id: 'b', customer: 'x', openedAt: AT });
    expect(second.appendEvent('b', { type: 'customer_message', at: AT, content: 'x' }).id).toBe(1);
  });
});
