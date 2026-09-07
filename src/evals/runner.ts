/**
 * The scenario runner: one scenario × config × repeat, in process, the scenario as the only
 * state. Since T4.7 the steps drive a `Session` (`src/live/session.ts`) over an in-memory
 * `LiveState`, the same object the live loop drives from GitHub events: the agent turn, the
 * consolidation and the scoped recall are implemented once, there. What stays here is the
 * eval's own business — the step clock, the checks and the judge, the per-step cost
 * accounting, the wiki updates, the probes and the result file.
 */
import { runTurn } from '../agent/index.ts';
import { type RunAgent, Session } from '../live/session.ts';
import { LiveState } from '../live/state.ts';
import { cloneMemoryItem, type MemoryEngine, type MemoryItem } from '../memory/index.ts';
import { loadWiki, Wiki } from '../wiki/index.ts';
import { checkProbePatterns, checkTurn, scoreOf } from './checks.ts';
import { createSkipJudge, type Judge } from './judge.ts';
import type {
  CheckResult,
  Config,
  ConsolidationError,
  ProbeResult,
  RunResult,
  Scenario,
  Step,
  StepResult,
} from './schema.ts';

export { createMemoryEngine, type CreateMemoryEngineOptions } from '../memory/index.ts';
export type { RunAgent } from '../live/session.ts';

export interface RunScenarioOptions {
  readonly engine: MemoryEngine;
  /**
   * Scores `uses`, `must_not_use`, `reply.rubric` and the knowledge side of the probes.
   * Without one every judged check is reported `skipped` with that reason: a run never
   * counts an unjudged check as a pass. `pnpm eval run` always supplies a real judge.
   */
  readonly judge?: Judge;
  /** Source snapshot. The runner clones it so `wiki_update` never escapes this run. */
  readonly wiki?: Wiki;
  readonly repeat?: number;
  readonly runAgent?: RunAgent;
  /** Wall clock used only for result metadata, never for scenario decisions. */
  readonly wallClock?: () => Date;
  /** Recorded in the result: a run made with the LLM disk cache on replays identical calls. */
  readonly cached?: boolean;
}

export type RepeatScenarioOptions = Omit<RunScenarioOptions, 'repeat'>;

interface RunState {
  /** The scenario clock: the `at` of the latest step that had one. */
  now: string;
  /** Thread ids in the order their first message opened them: the consolidation order. */
  readonly threadOrder: string[];
  readonly steps: StepResult[];
  readonly consolidations: RunResult['consolidations'];
  readonly probes: ProbeResult[];
  costUsd: number;
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
    threadOrder: [],
    steps: [],
    consolidations: [],
    probes: [],
    costUsd: 0,
  };

  const judge = options.judge ?? createSkipJudge('no judge configured for this run');
  // The transcripts live in SQLite for the run only; the engine is reused across repeats and
  // reset here, so the session must not dispose it.
  const liveState = new LiveState({ path: ':memory:' });
  try {
    await options.engine.reset();
    const session = new Session({
      config,
      engine: options.engine,
      wiki: await wikiForRun(scenario, options.wiki),
      state: liveState,
      customers: scenario.world.customers,
      scenarioClock: () => state.now,
      runAgent: options.runAgent ?? runTurn,
    });
    for (const step of scenario.steps) {
      if (step.at !== undefined) state.now = step.at;
      await executeStep(step, scenario, session, state, judge);
    }
    await executeProbes(scenario, session, state, judge);
  } catch (error) {
    return result(
      state,
      scenario,
      config,
      repeat,
      startedAt,
      wallTime(wallClock),
      judge,
      options.engine,
      options.cached,
      errorMessage(error),
    );
  } finally {
    liveState.close();
  }

  return result(
    state,
    scenario,
    config,
    repeat,
    startedAt,
    wallTime(wallClock),
    judge,
    options.engine,
    options.cached,
  );
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
  session: Session,
  state: RunState,
  judge: Judge,
): Promise<void> {
  switch (step.type) {
    case 'customer_message': {
      const known = session.thread(step.thread) !== undefined;
      session.customerMessage({
        thread: step.thread,
        customer: step.customer,
        content: step.content,
        at: step.at,
      });
      if (!known) state.threadOrder.push(step.thread);
      return;
    }

    case 'agent_turn': {
      await session.agentTurn(step.thread, {
        id: step.id,
        // Scored once the turn is on the transcript and before its memory writes are persisted:
        // a write that fails afterwards ends the run, but the paid turn keeps its verdicts.
        recorded: async (turn) => {
          // Deterministic checks first (free), then the judged ones: that is also the order the
          // report reads them in. Every expectation gets a verdict; neither gates the other.
          const checks = checkTurn(step.expect, turn);
          const judged = await judge.turn(step.expect, turn, scenario.knowledge);
          state.steps.push({
            ...turn,
            checks: [...checks, ...judged.checks],
            judgeCostUsd: judged.costUsd,
          });
          state.costUsd += (turn.costUsd ?? 0) + judged.costUsd;
        },
      });
      return;
    }

    case 'human_reply': {
      session.humanReply({
        thread: step.thread,
        author: step.author,
        content: step.content,
        at: step.at,
      });
      return;
    }

    case 'coach_note': {
      session.coachNote({
        thread: step.thread,
        author: step.author,
        content: step.content,
        scope: step.scope,
        at: step.at,
      });
      return;
    }

    case 'close_ticket': {
      session.close(step.thread, step.at);
      return;
    }

    case 'wiki_update': {
      const statements = step.knowledge.map((id) => {
        const item = scenario.knowledge[id];
        if (item === undefined) throw new Error(`Unknown knowledge item "${id}"`);
        return item.statement;
      });
      session.wiki.update(step.page, statements.join('\n\n'), state.now);
      return;
    }

    case 'consolidate': {
      // One boundary over every thread with new events, in the order they were opened; the
      // engine's extraction spend for the whole boundary is charged to this step.
      const wrote: MemoryItem[] = [];
      const errors: ConsolidationError[] = [];
      const engine = session.engine;
      const costBefore = engine.usage?.().costUsd;
      for (const thread of state.threadOrder) {
        try {
          wrote.push(...(await session.consolidate(thread)).wrote);
        } catch (error) {
          // The engine wrote nothing for this thread: a memory gap the later checks measure,
          // not a reason to abandon the paid turns around it. The thread stays pending, so the
          // next consolidate step offers it again.
          errors.push({ thread, error: errorMessage(error) });
        }
      }
      const costAfter = engine.usage?.().costUsd;
      const engineCost = costBefore === undefined || costAfter === undefined
        ? undefined
        : Math.max(0, costAfter - costBefore);
      state.consolidations.push({
        id: step.id,
        at: state.now,
        wrote,
        ...(engineCost === undefined ? {} : { costUsd: engineCost }),
        ...(errors.length === 0 ? {} : { errors }),
      });
      state.costUsd += engineCost ?? 0;
      return;
    }
  }
}

async function executeProbes(
  scenario: Scenario,
  session: Session,
  state: RunState,
  judge: Judge,
): Promise<void> {
  for (const probe of scenario.probes ?? []) {
    // `undefined` is "the engine cannot serve this", which checks and judge report as skipped.
    const returned = probe.type === 'memory_recall'
      ? await session.recall(probe.customer, probe.query, state.now)
      : session.engine.proposals === undefined
        ? undefined
        : (await session.engine.proposals()).map(cloneMemoryItem);

    const judged = await judge.probe(probe, returned, scenario.knowledge);
    state.costUsd += judged.costUsd;
    state.probes.push({
      id: probe.id,
      judgeCostUsd: judged.costUsd,
      checks: [...checkProbePatterns(probe, returned), ...judged.checks],
      ...(returned === undefined ? {} : { returned }),
    });
  }
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
  judge: Judge,
  engine: MemoryEngine,
  cached?: boolean,
  error?: string,
): RunResult {
  const memoryDiagnostics = engine.diagnostics?.();
  return {
    scenario: scenario.id,
    config: config.id,
    repeat,
    definition: structuredClone({ scenario, config }),
    startedAt,
    ...(judge.spec === undefined ? {} : { judge: judge.spec }),
    finishedAt,
    steps: state.steps,
    consolidations: state.consolidations,
    probes: state.probes,
    score: scoreOf(allChecks(state)),
    costUsd: state.costUsd,
    ...(cached === undefined ? {} : { cached }),
    ...(memoryDiagnostics === undefined
      ? {}
      : {
          memoryDiagnostics: {
            calls: { ...memoryDiagnostics.calls },
            traces: memoryDiagnostics.traces.map((trace) => ({ ...trace })),
          },
        }),
    ...(error === undefined ? {} : { error }),
  };
}

function allChecks(state: RunState): CheckResult[] {
  return [
    ...state.steps.flatMap((step) => step.checks),
    ...state.probes.flatMap((probe) => probe.checks),
  ];
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
