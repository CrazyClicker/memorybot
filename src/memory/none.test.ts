import { describe, expect, it } from 'vitest';

import type { MemoryItem, ThreadTranscript } from './engine.ts';
import { NoneMemoryEngine } from './none.ts';

const item: MemoryItem = {
  id: 'm1',
  kind: 'personal',
  about: 'alfa',
  learnedFrom: 'alfa',
  scope: 'customer',
  statement: 'По состоянию на 2026-09-03: факт.',
  source: { thread: 'thread-1', via: 'agent' },
  createdAt: '2026-09-03T10:00:00Z',
};

const thread: ThreadTranscript = {
  id: 'thread-1',
  customer: 'alfa',
  events: [{ type: 'customer_message', at: '2026-09-03T10:00:00Z', content: 'Вопрос.' }],
};

describe('NoneMemoryEngine', () => {
  it('never writes, consolidates, recalls or proposes anything', async () => {
    const engine = new NoneMemoryEngine();
    expect(engine.id).toBe('none');
    await engine.write([item], '2026-09-03T10:00:00Z');
    expect(await engine.consolidate(thread, '2026-09-03T11:00:00Z')).toEqual([]);
    expect(await engine.recall('alfa', 'факт', '2026-09-03T12:00:00Z')).toEqual([]);
    expect('proposals' in engine).toBe(false);
    await engine.reset();
    expect(await engine.recall('alfa', 'факт', '2026-09-03T12:00:00Z')).toEqual([]);
  });
});
