import { runTurn, type RunTurnOptions, type TurnInput, type TurnResult } from '../agent/index.ts';
import {
  canRecall,
  cloneMemoryItem,
  createNaiveMemoryEngine,
  createNoneMemoryEngine,
  dateStatement,
  type MemoryEngine,
  type MemoryItem,
  type ThreadEvent,
  type ThreadTranscript,
} from '../memory/index.ts';
import { loadWiki, Wiki } from '../wiki/index.ts';
import type {
  Config,
  MemoryEngineId,
  ProbeResult,
  RunResult,
  Scenario,
  Step,
  StepResult,
} from './schema.ts';

export type RunAgent = (
  input: TurnInput,
  options?: RunTurnOptions,
) => Promise<TurnResult>;

export interface RunScenarioOptions {
  readonly engine: MemoryEngine;
  /** Source snapshot. The runner clones it so `wiki_update` never escapes this run. */
  readonly wiki?: Wiki;
  readonly repeat?: number;
  readonly runAgent?: RunAgent;
  /** Wall clock used only for result metadata, never for scenario decisions. */
  readonly wallClock?: () => Date;
}

export type RepeatScenarioOptions = Omit<RunScenarioOptions, 'repeat'>;

interface RunState {
  now: string;
  readonly threads: Map<string, ThreadTranscript>;
  readonly consolidatedEventCounts: Map<string, number>;
  readonly steps: StepResult[];
  readonly consolidations: RunResult['consolidations'];
  readonly probes: ProbeResult[];
  costUsd: number;
}

/** Engines available before the external and structured engines land in T3. */
export function createMemoryEngine(id: MemoryEngineId): MemoryEngine {
  switch (id) {
    case 'none':
      return createNoneMemoryEngine();
    case 'naive':
      return createNaiveMemoryEngine();
    case 'notes':
    case 'mem0':
    case 'xmemory':
      throw new Error(`Memory engine "${id}" is not implemented yet`);
  }
}

/**
 * Execute one scenario × config × repeat. Runtime failures are returned in `error` together
 * with every completed result before the failure, which keeps expensive partial runs useful.
 */
export async function runScenario(
  scenario: Scenario,
  config: Config,
  options: RunScenarioOptions,
): Promise<RunResult> {
  const repeat = options.repeat ?? 1;
  assertRepeat(repeat);

  const wallClock = options.wallClock ?? (() => new Date());
  const startedAt = wallTime(wallClock);
  const state: RunState = {
    now: scenario.world.clock,
    threads: new Map(),
    consolidatedEventCounts: new Map(),
    steps: [],
    consolidations: [],
    probes: [],
    costUsd: 0,
  };

  try {
    await options.engine.reset();
    const wiki = await wikiForRun(scenario, options.wiki);
    for (const step of scenario.steps) {
      if (step.at !== undefined) state.now = step.at;
      await executeStep(step, scenario, config, options.engine, wiki, state, options.runAgent ?? runTurn);
    }
    await executeProbes(scenario, options.engine, state);
  } catch (error) {
    return result(state, scenario, config, repeat, startedAt, wallTime(wallClock), errorMessage(error));
  }

  return result(state, scenario, config, repeat, startedAt, wallTime(wallClock));
}

/** Sequential repeats deliberately reuse the adapter: `reset()` must prove each run is fresh. */
export async function runScenarioRepeats(
  scenario: Scenario,
  config: Config,
  repeats: number,
  options: RepeatScenarioOptions,
): Promise<RunResult[]> {
  assertRepeat(repeats);
  const results: RunResult[] = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    results.push(await runScenario(scenario, config, { ...options, repeat }));
  }
  return results;
}

async function executeStep(
  step: Step,
  scenario: Scenario,
  config: Config,
  engine: MemoryEngine,
  wiki: Wiki,
  state: RunState,
  runAgent: RunAgent,
): Promise<void> {
  switch (step.type) {
    case 'customer_message': {
      let thread = state.threads.get(step.thread);
      if (thread === undefined) {
        thread = { id: step.thread, customer: step.customer, events: [] };
        state.threads.set(step.thread, thread);
      } else if (thread.customer !== step.customer) {
        throw new Error(`Thread "${step.thread}" belongs to "${thread.customer}", not "${step.customer}"`);
      } else if (thread.closedAt !== undefined) {
        throw new Error(`Thread "${step.thread}" is already closed`);
      }
      thread.events.push({ type: 'customer_message', at: step.at, content: step.content });
      return;
    }

    case 'agent_turn': {
      const thread = requireOpenThread(state, step.thread);
      const query = latestCustomerMessage(thread);
      const recall = async (customer: string, queryText: string, now: string): Promise<MemoryItem[]> =>
        scopedRecall(engine, customer, queryText, now);
      const memory = config.memory.read === 'tool'
        ? []
        : await recall(thread.customer, query, state.now);
      const customer = scenario.world.customers[thread.customer];
      if (customer === undefined) throw new Error(`Unknown customer "${thread.customer}"`);

      const turn = await runAgent(
        {
          now: state.now,
          customer: { id: thread.customer, ...customer },
          thread: cloneThread(thread),
          memory,
          tools: {
            recallMemory: config.memory.read !== 'hydrate',
            remember: config.memory.write !== 'consolidate',
          },
          wiki,
          model: config.agent,
        },
        { recallMemory: recall },
      );

      thread.events.push({ type: 'agent_reply', at: state.now, content: turn.reply });
      const memoryWrites = turn.memoryWrites.map((item, index) =>
        agentWrite(item, thread, step.id, index, state.now),
      );
      state.steps.push({
        id: step.id,
        thread: step.thread,
        at: state.now,
        outcome: turn.outcome,
        reply: turn.reply,
        ...(turn.escalationReason === undefined ? {} : { escalationReason: turn.escalationReason }),
        trace: turn.trace,
        memoryWrites,
        checks: [],
        usage: turn.usage,
        ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
        latencyMs: turn.latencyMs,
      });
      state.costUsd += turn.costUsd ?? 0;
      if (memoryWrites.length > 0) await engine.write(memoryWrites, state.now);
      return;
    }

    case 'human_reply': {
      const thread = requireOpenThread(state, step.thread);
      thread.events.push({
        type: 'human_reply',
        at: step.at,
        author: step.author,
        content: step.content,
      });
      return;
    }

    case 'coach_note': {
      const thread = requireThread(state, step.thread);
      thread.events.push({
        type: 'coach_note',
        at: step.at,
        author: step.author,
        scope: step.scope,
        content: step.content,
      });
      return;
    }

    case 'close_ticket': {
      requireOpenThread(state, step.thread).closedAt = step.at;
      return;
    }

    case 'wiki_update': {
      const statements = step.knowledge.map((id) => {
        const item = scenario.knowledge[id];
        if (item === undefined) throw new Error(`Unknown knowledge item "${id}"`);
        return item.statement;
      });
      wiki.update(step.page, statements.join('\n\n'), state.now);
      return;
    }

    case 'consolidate': {
      const wrote: MemoryItem[] = [];
      for (const thread of state.threads.values()) {
        const previousCount = state.consolidatedEventCounts.get(thread.id) ?? 0;
        if (thread.events.length === previousCount) continue;

        const transcript = config.memory.write === 'agent'
          ? coachNotesSince(thread, previousCount)
          : cloneThread(thread);
        const items = await engine.consolidate(transcript, state.now);
        wrote.push(...items.map(cloneMemoryItem));
        state.consolidatedEventCounts.set(thread.id, thread.events.length);
      }
      state.consolidations.push({ id: step.id, at: state.now, wrote });
      return;
    }
  }
}

async function executeProbes(
  scenario: Scenario,
  engine: MemoryEngine,
  state: RunState,
): Promise<void> {
  for (const probe of scenario.probes ?? []) {
    if (probe.type === 'memory_recall') {
      state.probes.push({
        id: probe.id,
        checks: [],
        returned: await scopedRecall(engine, probe.customer, probe.query, state.now),
      });
      continue;
    }

    if (engine.proposals === undefined) {
      state.probes.push({ id: probe.id, checks: [] });
    } else {
      state.probes.push({
        id: probe.id,
        checks: [],
        returned: (await engine.proposals()).map(cloneMemoryItem),
      });
    }
  }
}

async function scopedRecall(
  engine: MemoryEngine,
  customer: string,
  query: string,
  now: string,
): Promise<MemoryItem[]> {
  return (await engine.recall(customer, query, now))
    .filter((item) => canRecall(item, customer))
    .map(cloneMemoryItem);
}

function agentWrite(
  item: MemoryItem,
  thread: ThreadTranscript,
  step: string,
  index: number,
  now: string,
): MemoryItem {
  return {
    ...cloneMemoryItem(item),
    id: `agent-${thread.id}-${step}-${index + 1}`,
    learnedFrom: thread.customer,
    scope: 'customer',
    statement: dateStatement(item.statement, now),
    source: { thread: thread.id, step, via: 'agent' },
    createdAt: now,
  };
}

function coachNotesSince(thread: ThreadTranscript, eventIndex: number): ThreadTranscript {
  return {
    id: thread.id,
    customer: thread.customer,
    events: thread.events.slice(eventIndex).filter((event) => event.type === 'coach_note').map(cloneEvent),
    ...(thread.closedAt === undefined ? {} : { closedAt: thread.closedAt }),
  };
}

function cloneThread(thread: ThreadTranscript): ThreadTranscript {
  return {
    id: thread.id,
    customer: thread.customer,
    events: thread.events.map(cloneEvent),
    ...(thread.closedAt === undefined ? {} : { closedAt: thread.closedAt }),
  };
}

function cloneEvent(event: ThreadEvent): ThreadEvent {
  return { ...event };
}

function requireThread(state: RunState, id: string): ThreadTranscript {
  const thread = state.threads.get(id);
  if (thread === undefined) throw new Error(`Unknown thread "${id}"`);
  return thread;
}

function requireOpenThread(state: RunState, id: string): ThreadTranscript {
  const thread = requireThread(state, id);
  if (thread.closedAt !== undefined) throw new Error(`Thread "${id}" is already closed`);
  return thread;
}

function latestCustomerMessage(thread: ThreadTranscript): string {
  for (let index = thread.events.length - 1; index >= 0; index -= 1) {
    const event = thread.events[index];
    if (event?.type === 'customer_message') return event.content;
  }
  throw new Error(`Thread "${thread.id}" has no customer message`);
}

async function wikiForRun(scenario: Scenario, source: Wiki | undefined): Promise<Wiki> {
  if (scenario.world.knowledge_base === 'none') return new Wiki([]);
  const canonical = source ?? await loadWiki();
  return new Wiki(canonical.pages, { search: canonical.searchEnabled });
}

function result(
  state: RunState,
  scenario: Scenario,
  config: Config,
  repeat: number,
  startedAt: string,
  finishedAt: string,
  error?: string,
): RunResult {
  return {
    scenario: scenario.id,
    config: config.id,
    repeat,
    startedAt,
    finishedAt,
    steps: state.steps,
    consolidations: state.consolidations,
    probes: state.probes,
    score: { pass: 0, partial: 0, fail: 0, skipped: 0 },
    costUsd: state.costUsd,
    ...(error === undefined ? {} : { error }),
  };
}

function assertRepeat(repeat: number): void {
  if (!Number.isSafeInteger(repeat) || repeat < 1) {
    throw new Error(`Repeat must be a positive safe integer, got ${repeat}`);
  }
}

function wallTime(clock: () => Date): string {
  return clock().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
