import { z } from 'zod';

import { CliError } from './args.ts';

const coreStories = [
  'csv-import-dropped-rows', 'setup-from-the-question', 'customer-setup-change',
  'human-reply-only', 'payment-provider-incident',
];
const engines = ['none', 'naive', 'notes', 'mem0', 'xmemory'];

export const GROUPS = {
  controls: {
    purpose: 'Check source-rule understanding before attributing paired CSV failures to memory.',
    scenarios: ['evals/controls/csv-rule-source.yaml'],
    configs: ['none'],
  },
  core: {
    purpose: 'Compare memory engines with hydrate/consolidate fixed across five support stories.',
    scenarios: coreStories.map((id) => `evals/scenarios/${id}.yaml`),
    configs: engines,
  },
  stress: {
    purpose: 'Check retention beyond the bounded transcript history, with consolidate fixed.',
    scenarios: ['evals/stress/recall-under-noise.yaml'],
    configs: engines,
  },
  'write-paths': {
    purpose: 'Compare additional writing modes; reuse naive and notes baselines from the matching core run.',
    scenarios: coreStories.map((id) => `evals/scenarios/${id}.yaml`),
    configs: ['naive-agent', 'notes-agent', 'notes-both'],
  },
} as const;

export type GroupName = keyof typeof GROUPS;
export const SUITES = {
  research: ['controls', 'core', 'stress'],
  controls: ['controls'],
  core: ['core'],
  stress: ['stress'],
  'write-paths': ['write-paths'],
} as const satisfies Record<string, readonly GroupName[]>;
export type SuiteName = keyof typeof SUITES;

export interface RunGroup {
  readonly id: string;
  readonly purpose: string;
  readonly scenarioPaths: readonly string[];
  readonly configPaths: readonly string[];
}

export function suiteGroups(name: string): RunGroup[] {
  if (!Object.hasOwn(SUITES, name)) {
    throw new CliError(`Unknown suite "${name}". Choose: ${Object.keys(SUITES).join(', ')}.`);
  }
  return SUITES[name as SuiteName].map((id) => ({
    id,
    purpose: GROUPS[id].purpose,
    scenarioPaths: GROUPS[id].scenarios,
    configPaths: GROUPS[id].configs.map((config) => `evals/configs/${config}.yaml`),
  }));
}

/** Stored separately from result JSON; reports use the frozen plan, not today's suite catalogue. */
export const SUITE_PLAN_FILE = 'PLAN.yaml';
const safeId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
export const SuitePlanSchema = z.object({
  version: z.literal(1),
  suite: safeId,
  repeat: z.number().int().positive(),
  groups: z.array(z.object({
    id: safeId,
    purpose: z.string(),
    scenarios: z.array(safeId).min(1),
    configs: z.array(safeId).min(1),
  }).strict()).min(1),
}).strict();
export type SuitePlan = z.infer<typeof SuitePlanSchema>;

export function expectedResultNames(group: SuitePlan['groups'][number], repeat: number): string[] {
  return group.scenarios.flatMap((scenario) => group.configs.flatMap((config) =>
    Array.from({ length: repeat }, (_, index) => `${scenario}.${config}.${index + 1}.json`),
  ));
}
