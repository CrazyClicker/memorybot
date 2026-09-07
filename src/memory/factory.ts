/**
 * The engine an eval config names. Both the eval runner and the live session build engines
 * from here, so neither has to import the other for it (T4.7).
 */
import type { LanguageModel } from 'ai';

import type { Config } from '../evals/schema.ts';
import type { MemoryEngine } from './engine.ts';
import { createMem0MemoryEngine, type Mem0Client } from './mem0.ts';
import { createNaiveMemoryEngine } from './naive.ts';
import { createNoneMemoryEngine } from './none.ts';
import { createNotesMemoryEngine } from './notes.ts';
import { createXmemoryMemoryEngine, type XmemoryClient } from './xmemory.ts';

export interface CreateMemoryEngineOptions {
  /** Direct model injection keeps factory-level notes tests offline. */
  readonly model?: LanguageModel;
  /** Direct client injection keeps factory-level mem0 tests offline. */
  readonly mem0Client?: Mem0Client;
  /** Direct client injection keeps factory-level xmemory tests offline. */
  readonly xmemoryClient?: XmemoryClient;
}

/** Build an engine from the complete config because structured extraction uses its agent model. */
export function createMemoryEngine(
  config: Config,
  options: CreateMemoryEngineOptions = {},
): MemoryEngine {
  switch (config.memory.engine) {
    case 'none':
      return createNoneMemoryEngine();
    case 'naive':
      return createNaiveMemoryEngine();
    case 'notes':
      return createNotesMemoryEngine({ modelSpec: config.agent, model: options.model });
    case 'mem0': {
      if (config.agent.provider !== 'openai') {
        throw new Error('mem0 comparison requires an OpenAI agent model for like-for-like extraction');
      }
      return createMem0MemoryEngine({
        client: options.mem0Client,
        llmModel: config.agent.model,
      });
    }
    case 'xmemory':
      return createXmemoryMemoryEngine({ client: options.xmemoryClient });
  }
}
