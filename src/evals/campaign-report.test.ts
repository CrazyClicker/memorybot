import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ZERO_USAGE } from '../llm/index.ts';
import type { Config, RunResult, Scenario } from './schema.ts';
import { renderCampaignReport } from './campaign-report.ts';

const story: Scenario = {
  id: 'story', title: 'Offline memory example', knowledge: {},
  world: { knowledge_base: 'wiki', clock: '2026-09-01T09:00:00Z', customers: { shop: { name: 'Shop' } } },
  steps: [
    { id: 'open', type: 'customer_message', thread: 'ticket', customer: 'shop', at: '2026-09-01T09:00:00Z', content: 'Question' },
    { id: 'reply', type: 'agent_turn', thread: 'ticket', expect: { reply: { rubric: 'Use the known fact.' } } },
  ],
};
let dir: string;
let serial: number;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'research-report-')); serial = 0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function saveSuite(id: string, groups: Record<string, string[]>, change?: (result: RunResult) => void) {
  const plans = [];
  for (const [group, configs] of Object.entries(groups)) {
    plans.push({ id: group, purpose: 'Offline test', scenarios: ['story'], configs });
    await mkdir(join(dir, id, group), { recursive: true });
    for (const configId of configs) {
      const config: Config = {
        id: configId, agent: { provider: 'openai', model: 'gpt-5.6-terra' },
        judge: { provider: 'openai', model: 'gpt-5.6-sol' },
        memory: {
          engine: configId.startsWith('notes') ? 'notes' : 'naive', read: 'hydrate',
          write: configId.endsWith('-agent') ? 'agent' : configId.endsWith('-both') ? 'both' : 'consolidate',
        },
      };
      const result: RunResult = {
        scenario: story.id, config: configId, repeat: 1, definition: { scenario: structuredClone(story), config },
        startedAt: new Date(Date.UTC(2026, 8, 5, 10, 0, serial++)).toISOString(),
        judge: config.judge, cached: false,
        steps: [{
          id: 'reply', thread: 'ticket', at: '2026-09-01T09:00:00Z', outcome: 'answer',
          reply: 'Offline answer', trace: [], memoryWrites: [], recalls: [], usage: ZERO_USAGE, latencyMs: 0,
          checks: [{ key: 'reply.rubric', verdict: 'partial', why: 'Missing detail' }],
        }],
        consolidations: [], probes: [], score: { pass: 0, partial: 1, fail: 0, skipped: 0 }, costUsd: 1,
      };
      change?.(result);
      await writeFile(join(dir, id, group, `story.${configId}.1.json`), JSON.stringify(result));
    }
  }
  await writeFile(join(dir, id, 'PLAN.yaml'), stringify({ version: 1, suite: 'research', repeat: 1, groups: plans }));
}

describe('research report', () => {
  it('reuses core baselines within engines, preserves provenance and counts their spend once', async () => {
    await saveSuite('main', { core: ['naive', 'notes'] });
    await saveSuite('writing', { 'write-paths': ['naive-agent', 'notes-agent', 'notes-both'] });
    const report = (await renderCampaignReport(['main', 'writing', 'main'], dir)).replace(/ +/g, ' ');
    expect(report).toContain('Unique recorded results: **5**. Observed spend: **$5.0000**');
    const naive = report.split('## Write paths: naive\n')[1]!.split('## Write paths: notes\n')[0]!;
    expect(naive).toContain('| `naive` | naive | hydrate | consolidate |');
    expect(naive).toContain('| `naive-agent` | naive | hydrate | agent |');
    expect(naive).not.toContain('| `notes` |');
    const notes = report.split('## Write paths: notes\n')[1]!;
    for (const config of ['notes', 'notes-agent', 'notes-both']) expect(notes).toContain(`| \`${config}\` | notes |`);
    expect(report).toContain(`\`${join(dir, 'main/core/story.naive.1.json')}\` / \`reply\``);
    expect(report).toContain('## Research decision record');
    expect(report).toContain('## controls\n\nNot run');
    expect(report).toContain('## stress\n\nNot run');
  });

  it.each(['agent', 'judge', 'scenario', 'cache', 'read'] as const)('blocks incompatible %s inputs without hiding the core report', async (kind) => {
    await saveSuite('main', { core: ['notes'] });
    await saveSuite('writing', { 'write-paths': ['notes-agent'] }, (result) => {
      if (kind === 'agent') result.definition!.config.agent.model = 'other-agent';
      if (kind === 'judge') result.judge = { provider: 'openai', model: 'other-judge' };
      if (kind === 'scenario') result.definition!.scenario.title = 'Changed story';
      if (kind === 'cache') result.cached = true;
      if (kind === 'read') result.definition!.config.memory.read = 'tool';
    });
    const report = (await renderCampaignReport(['main', 'writing'], dir)).replace(/ +/g, ' ');
    expect(report).toContain('| `notes` | notes | hydrate | consolidate |');
    const writing = report.split('## Write paths: notes\n')[1]!;
    expect(writing).toContain('**Comparison blocked');
    expect(writing).not.toContain('| `notes-agent` | notes |');
  });

  it('exposes missing baselines, incomplete groups and unreadable files', async () => {
    await saveSuite('main', { core: ['naive', 'notes'] });
    await rm(join(dir, 'main/core/story.notes.1.json'));
    await saveSuite('writing', { 'write-paths': ['notes-agent', 'notes-both'] });
    await writeFile(join(dir, 'writing/write-paths/story.notes-both.1.json'), '{broken');
    const report = (await renderCampaignReport(['main', 'writing'], dir)).replace(/ +/g, ' ');
    expect(report).toContain('| main/core | 1 / 2 | Incomplete |');
    expect(report).toContain('Missing notes core baseline for: `story`');
    expect(report).toContain('Unreadable result:');
    expect(report).toContain('Missing planned result:');
  });

  it('counts independently recorded repeat 1 samples while excluding copied result files', async () => {
    await saveSuite('first', { core: ['notes'] });
    await saveSuite('second', { core: ['notes'] });
    await saveSuite('copy', { core: ['notes'] });
    await writeFile(join(dir, 'copy/core/story.notes.1.json'), await readFile(join(dir, 'first/core/story.notes.1.json')));
    const report = await renderCampaignReport(['first', 'second', 'copy'], dir);
    expect(report).toContain('Unique recorded results: **2**. Observed spend: **$2.0000**');
    expect(report).toContain('Duplicate evidence excluded:');
    expect(report).toMatch(/\| `reply`\s*\| `reply\.rubric`\s*\| ◐ 0\/2\s*\|/);
    expect(report).toContain(join(dir, 'first/core/story.notes.1.json'));
    expect(report).toContain(join(dir, 'second/core/story.notes.1.json'));
  });

  it('requires saved suite plans and does not infer group membership from old flat runs', async () => {
    await expect(renderCampaignReport(['baseline-4'], dir)).rejects.toThrow('valid saved PLAN.yaml');
  });
});
