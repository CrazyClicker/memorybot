import type { MemoryEngine, MemoryItem, ThreadTranscript } from './engine.ts';

/** Control engine: deliberately learns and recalls nothing. */
export class NoneMemoryEngine implements MemoryEngine {
  readonly id = 'none';

  async reset(): Promise<void> {}

  async recall(_customer: string, _query: string, _now: string): Promise<MemoryItem[]> {
    return [];
  }

  async write(_items: MemoryItem[], _now: string): Promise<void> {}

  async consolidate(_thread: ThreadTranscript, _now: string): Promise<MemoryItem[]> {
    return [];
  }
}

export function createNoneMemoryEngine(): NoneMemoryEngine {
  return new NoneMemoryEngine();
}
