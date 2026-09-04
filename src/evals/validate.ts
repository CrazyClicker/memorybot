/**
 * Cross-field validation of scenarios and configs: what `pnpm eval validate` checks beyond
 * the shape. Pure functions over parsed documents; file IO lives in load.ts.
 *
 * Errors make a file invalid. Warnings mark a well-formed scenario that probably does not
 * test what its author meant; they never fail the command.
 */
import type { z } from 'zod';

import { modelKey, priceFor } from '../llm/index.ts';
import {
  clockMs,
  expiryMs,
  type Config,
  ConfigSchema,
  type KnowledgeItem,
  type Scenario,
  ScenarioSchema,
} from './schema.ts';

export type Severity = 'error' | 'warning';

export interface Issue {
  readonly severity: Severity;
  /** Where in the document (`steps[3].at`, `knowledge.K1.valid_until`); empty for the file as a whole. */
  readonly path: string;
  readonly message: string;
}

export interface ValidationContext {
  /** Slugs a `wiki_update.page` may name. Undefined skips that check. */
  readonly wikiSlugs?: ReadonlySet<string>;
  /** File name without extension; the document's `id` must match it. */
  readonly fileStem?: string;
}

export interface Parsed<T> {
  /** Present when the shape is valid, even if semantic errors were found. */
  readonly value?: T;
  readonly issues: readonly Issue[];
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? String(key) : `.${String(key)}`;
  }
  return out;
}

export function zodIssues(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    severity: 'error',
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

export function parseScenario(raw: unknown, ctx: ValidationContext = {}): Parsed<Scenario> {
  const result = ScenarioSchema.safeParse(raw);
  if (!result.success) return { issues: zodIssues(result.error) };
  return { value: result.data, issues: validateScenario(result.data, ctx) };
}

export function parseConfig(raw: unknown, ctx: ValidationContext = {}): Parsed<Config> {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) return { issues: zodIssues(result.error) };
  return { value: result.data, issues: validateConfig(result.data, ctx) };
}

class Issues {
  readonly list: Issue[] = [];

  error(path: string, message: string): void {
    this.list.push({ severity: 'error', path, message });
  }

  warning(path: string, message: string): void {
    this.list.push({ severity: 'warning', path, message });
  }
}

function listOf(values: Iterable<string>): string {
  const all = [...values];
  return all.length === 0 ? '(none)' : all.map((value) => `"${value}"`).join(', ');
}

interface ThreadState {
  readonly customer: string;
  /** Customer messages nobody has answered yet. */
  pending: number;
  /** Index of the `close_ticket` step, once closed. */
  closedAt?: number;
}

/** What the expectation checks need to know about a knowledge item, resolved once. */
interface KnowledgeFacts {
  readonly item: KnowledgeItem;
  /** Indices of the source steps that resolve to a learning step. */
  readonly sourceSteps: readonly number[];
  /** Customers whose threads the source steps belong to. */
  readonly learnedFrom: ReadonlySet<string>;
}

export function validateScenario(scenario: Scenario, ctx: ValidationContext = {}): Issue[] {
  const issues = new Issues();

  if (ctx.fileStem !== undefined && scenario.id !== ctx.fileStem) {
    issues.error('id', `"${scenario.id}" does not match the file name "${ctx.fileStem}"`);
  }

  const customers = new Set(Object.keys(scenario.world.customers));
  const knowledgeIds = new Set(Object.keys(scenario.knowledge));
  const stepIndex = new Map<string, number>();
  /** The scenario clock in force at each step. */
  const stepClock: number[] = [];
  const threads = new Map<string, ThreadState>();
  /** First `wiki_update` step that promoted each knowledge item. */
  const promotedAt = new Map<string, number>();

  const requireKnowledge = (path: string, label: string, ids: readonly string[] | undefined): void => {
    ids?.forEach((id, j) => {
      if (!knowledgeIds.has(id)) {
        issues.error(`${path}[${j}]`, `${label}: unknown knowledge item ${id}; declared: ${listOf(knowledgeIds)}`);
      }
    });
  };

  // ---- Pass 1: step ids, the clock, threads ---------------------------------------------

  let clock = clockMs(scenario.world.clock);
  let clockOwner = `world.clock (${scenario.world.clock})`;

  scenario.steps.forEach((step, i) => {
    const path = `steps[${i}]`;
    const label = `"${step.id}"`;

    const first = stepIndex.get(step.id);
    if (first !== undefined) {
      issues.error(`${path}.id`, `duplicate step id ${label}, first used at steps[${first}]`);
    } else {
      stepIndex.set(step.id, i);
    }

    if (step.at !== undefined) {
      const ms = clockMs(step.at);
      if (ms < clock) {
        issues.error(`${path}.at`, `${label}: ${step.at} is earlier than ${clockOwner}; the clock never goes backwards`);
      } else {
        clock = ms;
        clockOwner = `${path}.at (${step.at})`;
      }
    }
    stepClock.push(clock);

    const openThread = (thread: string): ThreadState | undefined => {
      const state = threads.get(thread);
      if (state === undefined) {
        issues.error(`${path}.thread`, `${label}: no customer_message has opened thread "${thread}" before this step`);
        return undefined;
      }
      if (state.closedAt !== undefined) {
        issues.error(`${path}.thread`, `${label}: thread "${thread}" was closed at steps[${state.closedAt}]`);
        return undefined;
      }
      return state;
    };

    switch (step.type) {
      case 'customer_message': {
        if (!customers.has(step.customer)) {
          issues.error(`${path}.customer`, `${label}: unknown customer "${step.customer}"; world.customers has ${listOf(customers)}`);
        }
        const state = threads.get(step.thread);
        if (state === undefined) {
          threads.set(step.thread, { customer: step.customer, pending: 1 });
          break;
        }
        if (state.closedAt !== undefined) {
          issues.error(`${path}.thread`, `${label}: thread "${step.thread}" was closed at steps[${state.closedAt}]; a new message opens a new thread`);
          break;
        }
        if (state.customer !== step.customer) {
          issues.error(`${path}.customer`, `${label}: thread "${step.thread}" belongs to "${state.customer}", not "${step.customer}"`);
        }
        state.pending += 1;
        break;
      }
      case 'agent_turn': {
        const state = openThread(step.thread);
        if (state !== undefined) {
          if (state.pending === 0) {
            issues.error(path, `${label}: nothing is pending on thread "${step.thread}"; an agent_turn needs a customer_message nobody has answered`);
          }
          state.pending = 0;
        }
        break;
      }
      case 'human_reply': {
        const state = openThread(step.thread);
        if (state !== undefined) state.pending = 0;
        break;
      }
      case 'coach_note': {
        // A note may follow the close: it is never customer-visible and feeds memory only.
        if (!threads.has(step.thread)) {
          issues.error(`${path}.thread`, `${label}: no customer_message has opened thread "${step.thread}" before this step`);
        }
        break;
      }
      case 'close_ticket': {
        const state = openThread(step.thread);
        if (state !== undefined) state.closedAt = i;
        break;
      }
      case 'wiki_update': {
        if (scenario.world.knowledge_base !== 'wiki') {
          issues.error(path, `${label}: wiki_update needs world.knowledge_base: wiki`);
        }
        if (ctx.wikiSlugs !== undefined && !ctx.wikiSlugs.has(step.page)) {
          issues.error(`${path}.page`, `${label}: no wiki page "${step.page}"; pages: ${listOf(ctx.wikiSlugs)}`);
        }
        requireKnowledge(`${path}.knowledge`, label, step.knowledge);
        for (const id of step.knowledge) {
          if (!promotedAt.has(id)) promotedAt.set(id, i);
        }
        break;
      }
      case 'consolidate':
        break;
    }
  });

  // ---- Knowledge ------------------------------------------------------------------------

  const facts = new Map<string, KnowledgeFacts>();

  for (const [id, item] of Object.entries(scenario.knowledge)) {
    const path = `knowledge.${id}`;

    if (item.about !== 'product' && !customers.has(item.about)) {
      issues.error(`${path}.about`, `${id}: "${item.about}" is neither a customer nor "product"`);
    }

    const sourceSteps: number[] = [];
    const learnedFrom = new Set<string>();
    item.source.forEach((stepId, j) => {
      const index = stepIndex.get(stepId);
      const step = index === undefined ? undefined : scenario.steps[index];
      if (index === undefined || step === undefined) {
        issues.error(`${path}.source[${j}]`, `${id}: unknown step "${stepId}"`);
        return;
      }
      if (step.type !== 'customer_message' && step.type !== 'human_reply' && step.type !== 'coach_note') {
        issues.error(`${path}.source[${j}]`, `${id}: "${stepId}" is a ${step.type}; knowledge comes from customer_message, human_reply or coach_note steps`);
        return;
      }
      sourceSteps.push(index);
      const thread = threads.get(step.thread);
      if (thread !== undefined) learnedFrom.add(thread.customer);
    });

    if (item.kind === 'temporal') {
      if (item.valid_until === undefined) {
        issues.error(`${path}.valid_until`, `${id}: temporal knowledge needs valid_until; the scenario tests the fact before and after it`);
      }
    } else if (item.valid_until !== undefined) {
      issues.error(`${path}.valid_until`, `${id}: only temporal knowledge has valid_until (this item is ${item.kind})`);
    }

    if (item.documentation_candidate === true && item.kind !== 'undocumented') {
      issues.error(`${path}.documentation_candidate`, `${id}: only undocumented knowledge is a documentation candidate (this item is ${item.kind})`);
    }

    if (item.scope === 'shared') {
      const broadcast = sourceSteps.some((index) => {
        const step = scenario.steps[index];
        return step?.type === 'coach_note' && step.scope === 'product';
      });
      if (!broadcast) {
        issues.error(`${path}.scope`, `${id}: shared knowledge comes only from a coach_note with scope: product, and none of its source steps is one`);
      }
    }

    facts.set(id, { item, sourceSteps, learnedFrom });
  }

  /** Principle 4: customer-scoped knowledge reaches another customer only through the wiki. */
  const mayReach = (id: string, fact: KnowledgeFacts, customer: string, atStep: number): boolean => {
    if (fact.item.scope === 'shared' || fact.item.about === customer || fact.learnedFrom.has(customer)) {
      return true;
    }
    const promoted = promotedAt.get(id);
    return promoted !== undefined && promoted < atStep;
  };

  const recallable = (fact: KnowledgeFacts, customer: string): boolean =>
    fact.item.scope === 'shared' || fact.item.about === customer || fact.learnedFrom.has(customer);

  // ---- Pass 2: expectations -------------------------------------------------------------

  /** Knowledge items some check or wiki_update refers to. */
  const referenced = new Set<string>();
  /** Temporal items with a `must_not_use` on a turn after their `valid_until`. */
  const droppedAfterExpiry = new Set<string>();

  scenario.steps.forEach((step, i) => {
    if (step.type === 'wiki_update') {
      for (const id of step.knowledge) referenced.add(id);
      return;
    }
    if (step.type !== 'agent_turn' || step.expect === undefined) return;

    const path = `steps[${i}].expect`;
    const label = `"${step.id}"`;
    const expect = step.expect;
    const customer = threads.get(step.thread)?.customer;
    const now = stepClock[i] ?? clock;

    requireKnowledge(`${path}.uses`, label, expect.uses);
    requireKnowledge(`${path}.must_not_use`, label, expect.must_not_use);

    if (expect.tolerated !== undefined) {
      if (expect.outcome === undefined) {
        issues.error(`${path}.tolerated`, `${label}: tolerated needs an outcome to be tolerated instead of`);
      } else if (expect.tolerated.includes(expect.outcome)) {
        issues.error(`${path}.tolerated`, `${label}: "${expect.outcome}" is the expected outcome; tolerated lists the alternatives`);
      }
    }

    for (const id of expect.uses ?? []) {
      referenced.add(id);
      if (expect.must_not_use?.includes(id)) {
        issues.error(`${path}.uses`, `${label}: ${id} is in both uses and must_not_use`);
      }
      const fact = facts.get(id);
      if (fact === undefined) continue;

      if (fact.sourceSteps.length > 0 && !fact.sourceSteps.some((source) => source < i)) {
        const firstSource = Math.min(...fact.sourceSteps);
        issues.error(`${path}.uses`, `${label}: uses ${id} before it is learned; its first source is steps[${firstSource}] ("${scenario.steps[firstSource]?.id}")`);
      }
      if (customer !== undefined && !mayReach(id, fact, customer, i)) {
        issues.error(`${path}.uses`, `${label}: ${id} is customer-scoped knowledge learned from ${listOf(fact.learnedFrom)}; "${customer}"'s thread can use it only after a wiki_update promotes it, or if it is scope: shared`);
      }
    }

    for (const id of expect.must_not_use ?? []) {
      referenced.add(id);
      const fact = facts.get(id);
      if (fact?.item.kind === 'temporal' && fact.item.valid_until !== undefined && now > expiryMs(fact.item.valid_until)) {
        droppedAfterExpiry.add(id);
      }
    }
  });

  // ---- Probes ---------------------------------------------------------------------------

  const probeIds = new Map<string, number>();

  (scenario.probes ?? []).forEach((probe, i) => {
    const path = `probes[${i}]`;
    const label = `"${probe.id}"`;

    const first = probeIds.get(probe.id);
    if (first !== undefined) {
      issues.error(`${path}.id`, `duplicate probe id ${label}, first used at probes[${first}]`);
    } else {
      probeIds.set(probe.id, i);
    }

    if (Object.keys(probe.expect).length === 0) {
      issues.error(`${path}.expect`, `${label}: expects nothing; add recalls, must_not_recall, proposes or must_not`);
    }

    if (probe.type === 'memory_recall') {
      const known = customers.has(probe.customer);
      if (!known) {
        issues.error(`${path}.customer`, `${label}: unknown customer "${probe.customer}"; world.customers has ${listOf(customers)}`);
      }
      requireKnowledge(`${path}.expect.recalls`, label, probe.expect.recalls);
      requireKnowledge(`${path}.expect.must_not_recall`, label, probe.expect.must_not_recall);

      for (const id of probe.expect.recalls ?? []) {
        referenced.add(id);
        if (probe.expect.must_not_recall?.includes(id)) {
          issues.error(`${path}.expect.recalls`, `${label}: ${id} is in both recalls and must_not_recall`);
        }
        const fact = facts.get(id);
        if (fact !== undefined && known && !recallable(fact, probe.customer)) {
          issues.error(`${path}.expect.recalls`, `${label}: ${id} is customer-scoped knowledge learned from ${listOf(fact.learnedFrom)}; recall for "${probe.customer}" never returns it`);
        }
      }
      for (const id of probe.expect.must_not_recall ?? []) referenced.add(id);
    } else {
      requireKnowledge(`${path}.expect.proposes`, label, probe.expect.proposes);
      for (const id of probe.expect.proposes ?? []) {
        referenced.add(id);
        const fact = facts.get(id);
        if (fact !== undefined && fact.item.documentation_candidate !== true) {
          issues.error(`${path}.expect.proposes`, `${label}: ${id} is not a documentation_candidate, so no engine proposes it`);
        }
      }
    }
  });

  // ---- Warnings: declared but never tested ----------------------------------------------

  for (const [id, fact] of facts) {
    if (!referenced.has(id)) {
      issues.warning(`knowledge.${id}`, `${id} is declared, but no uses, must_not_use, recalls, proposes or wiki_update refers to it`);
    }
    if (fact.item.kind === 'temporal' && fact.item.valid_until !== undefined && !droppedAfterExpiry.has(id)) {
      issues.warning(`knowledge.${id}`, `${id} is temporal, but no agent_turn after valid_until (${fact.item.valid_until}) has must_not_use: [${id}]; nothing checks that the agent drops the expired fact`);
    }
  }

  return issues.list;
}

export function validateConfig(config: Config, ctx: ValidationContext = {}): Issue[] {
  const issues = new Issues();

  if (ctx.fileStem !== undefined && config.id !== ctx.fileStem) {
    issues.error('id', `"${config.id}" does not match the file name "${ctx.fileStem}"`);
  }

  for (const role of ['agent', 'judge'] as const) {
    const ref = config[role];
    if (priceFor(ref) === undefined) {
      issues.warning(`${role}.model`, `no price entry for ${modelKey(ref)} in src/llm/models.ts; the report's cost column stays blank for the ${role}`);
    }
  }

  if (config.agent.provider === config.judge.provider) {
    issues.warning('judge.provider', `judge and agent share a vendor (${config.agent.provider}); a judge from another vendor avoids self-preference (ROADMAP §8)`);
  }

  return issues.list;
}
