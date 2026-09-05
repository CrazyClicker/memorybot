import { describe, expect, it } from 'vitest';

import { ZERO_USAGE } from '../llm/index.ts';
import { createNaiveMemoryEngine } from '../memory/naive.ts';
import { createNoneMemoryEngine } from '../memory/none.ts';
import { estimateTokens } from '../memory/text.ts';
import { loadWiki, Wiki } from '../wiki/index.ts';
import type { TurnInput } from '../agent/index.ts';
import { listYamlFiles, loadScenario } from './load.ts';
import { runScenario } from './runner.ts';
import type { Config } from './schema.ts';

const config: Config = {
  id: 'naive', agent: { provider: 'openai', model: 'gpt-5.6-terra' },
  memory: { engine: 'naive', read: 'hydrate', write: 'consolidate' },
  judge: { provider: 'openai', model: 'gpt-5.6-sol' },
};
const offlineAgent = async () => ({
  outcome: 'answer' as const, reply: 'Offline fixture; no model was called.',
  memoryWrites: [], trace: [], usage: ZERO_USAGE, latencyMs: 0, costUsd: 0,
});

describe('experiment scenarios', () => {
  it('validates core and opt-in hypotheses and source references', async () => {
    const paths = [
      ...await listYamlFiles('evals/scenarios'),
      ...await listYamlFiles('evals/stress'),
      ...await listYamlFiles('evals/controls'),
    ];
    for (const path of paths) {
      const loaded = await loadScenario(path);
      expect(loaded.issues, path).toEqual([]);
      expect(loaded.value?.hypotheses?.length, path).toBeGreaterThan(0);
    }
  });

  it('keeps source-control questions, rubrics, clocks and original explanation identical to the memory comparison', async () => {
    const main = (await loadScenario('evals/scenarios/csv-import-dropped-rows.yaml')).value!;
    const control = (await loadScenario('evals/controls/csv-rule-source.yaml')).value!;
    const source = main.steps.find((step) => step.id === 't1-coach-note')!;
    if (source.type !== 'coach_note') throw new Error('Expected an engineer source');
    expect(control.world).toEqual(main.world);
    const questions = main.steps.filter((step) => step.type === 'customer_message')
      .filter((step) => step.id.startsWith('branch-'));
    expect(questions).toHaveLength(3);
    expect(new Set(questions.map((question) => question.thread)).size).toBe(3);
    for (const question of questions) {
      const prefix = question.id.replace(/-open$/, '');
      expect(control.steps.find((step) => step.id === question.id)).toEqual(question);
      expect(control.steps.find((step) => step.id === `${prefix}-agent`))
        .toEqual(main.steps.find((step) => step.id === `${prefix}-agent`));
      const copy = control.steps.find((step) => step.id === `${prefix}-source`)!;
      expect(copy).toMatchObject({ type: 'coach_note', content: source.content, author: source.author, scope: source.scope });
    }
    expect(control.steps.some((step) => step.type === 'consolidate' || step.type === 'wiki_update')).toBe(false);
    // Core selection must not silently multiply the direct-source control across engines.
    expect(await listYamlFiles('evals/scenarios')).not.toContain('evals/controls/csv-rule-source.yaml');
  });

  it('delivers the rule through current-thread source only in control and through recall only in memory branches', async () => {
    const main = (await loadScenario('evals/scenarios/csv-import-dropped-rows.yaml')).value!;
    const control = (await loadScenario('evals/controls/csv-rule-source.yaml')).value!;
    const source = main.steps.find((step) => step.id === 't1-coach-note')!;
    if (source.type !== 'coach_note') throw new Error('Expected an engineer source');
    const inputs: Array<Array<Pick<TurnInput, 'thread' | 'memory'>>> = [[], []];
    const wiki = await loadWiki();
    for (const [index, scenario] of [main, control].entries()) {
      const result = await runScenario(scenario, index === 0 ? config : {
        ...config, id: 'none', memory: { ...config.memory, engine: 'none' },
      }, {
        engine: index === 0 ? createNaiveMemoryEngine() : createNoneMemoryEngine(), wiki,
        runAgent: async (input) => {
          if (input.thread.id.includes('_branch_')) inputs[index]!.push(structuredClone({
            thread: input.thread, memory: input.memory,
          }));
          return offlineAgent();
        },
      });
      expect(result.error).toBeUndefined();
    }
    expect(inputs[0]).toHaveLength(3);
    expect(inputs[1]).toHaveLength(3);
    for (const input of inputs[0]!) {
      expect(input.thread.events).toHaveLength(1);
      expect(input.memory.some((item) => item.statement.includes(source.content))).toBe(true);
      expect(input.memory.some((item) => item.source.thread.includes('_branch_'))).toBe(false);
    }
    for (const input of inputs[1]!) {
      expect(input.memory).toEqual([]);
      expect(input.thread.events.map((event) => event.type)).toEqual(['customer_message', 'coach_note', 'customer_message']);
      expect(input.thread.events[1]?.content).toBe(source.content);
    }
  });

  it('actually evicts the older constraint under the default transcript budget without an oversized newest item', async () => {
    const loaded = await loadScenario('evals/stress/recall-under-noise.yaml');
    const result = await runScenario(loaded.value!, config, {
      engine: createNaiveMemoryEngine(), wiki: new Wiki([]), runAgent: offlineAgent,
    });
    expect(result.error).toBeUndefined();
    const writes = result.consolidations.flatMap((pass) => pass.wrote);
    expect(writes.some((item) => item.source.thread === 'tkt_kofe_tochka_learn')).toBe(true);
    expect(writes.reduce((sum, item) => sum + estimateTokens(item.statement), 0)).toBeGreaterThan(4000);
    expect(writes.every((item) => estimateTokens(item.statement) < 4000)).toBe(true);
    const later = result.steps.find((step) => step.id === 'later-agent')!.recalls![0]!;
    expect(later.returned.length).toBeGreaterThan(0);
    expect(later.returned.some((item) => item.source.thread === 'tkt_kofe_tochka_learn')).toBe(false);
  });

  it('replays only the older source at the final update checkpoint', async () => {
    const loaded = await loadScenario('evals/scenarios/customer-setup-change.yaml');
    const result = await runScenario(loaded.value!, config, {
      engine: createNaiveMemoryEngine(), wiki: new Wiki([]), runAgent: offlineAgent,
    });
    expect(result.error).toBeUndefined();
    const replay = result.consolidations.find((pass) => pass.id === 'consolidate-replay')!;
    expect(replay.wrote.map((item) => item.source.thread)).toEqual(['tkt_lavanda_old']);
  });
});
