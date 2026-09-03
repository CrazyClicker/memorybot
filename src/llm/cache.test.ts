import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cacheKey, diskCacheMiddleware } from './cache.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'llm-cache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function countingModel() {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      return {
        content: [{ type: 'text' as const, text: `reply ${calls}` }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
        response: { timestamp: new Date('2026-09-03T12:00:00Z'), modelId: 'mock', id: 'r1' },
      };
    },
  });
  return { model, calls: () => calls };
}

function cached(model: MockLanguageModelV4) {
  return wrapLanguageModel({ model, middleware: diskCacheMiddleware(dir) });
}

describe('diskCacheMiddleware', () => {
  it('calls the model once and serves the second identical call from disk', async () => {
    const { model, calls } = countingModel();

    const first = await generateText({ model: cached(model), prompt: 'привет' });
    const second = await generateText({ model: cached(model), prompt: 'привет' });

    expect(calls()).toBe(1);
    expect(second.text).toBe(first.text);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it('reports the recorded usage on a hit, so a cached run is not free-looking', async () => {
    const { model } = countingModel();
    await generateText({ model: cached(model), prompt: 'привет' });
    const hit = await generateText({ model: cached(model), prompt: 'привет' });

    expect(hit.usage.inputTokens).toBe(10);
    expect(hit.usage.outputTokens).toBe(5);
    expect(hit.finalStep.response.timestamp).toBeInstanceOf(Date);
  });

  it('misses when the prompt changes', async () => {
    const { model, calls } = countingModel();
    await generateText({ model: cached(model), prompt: 'привет' });
    await generateText({ model: cached(model), prompt: 'здравствуйте' });

    expect(calls()).toBe(2);
    expect(await readdir(dir)).toHaveLength(2);
  });

  it('misses when the instructions change', async () => {
    const { model, calls } = countingModel();
    await generateText({ model: cached(model), instructions: 'a', prompt: 'привет' });
    await generateText({ model: cached(model), instructions: 'b', prompt: 'привет' });

    expect(calls()).toBe(2);
  });

  it('survives an unreadable entry by treating it as a miss', async () => {
    const { model, calls } = countingModel();
    await generateText({ model: cached(model), prompt: 'привет' });
    const [file] = await readdir(dir);
    await rm(join(dir, file as string));

    await generateText({ model: cached(model), prompt: 'привет' });
    expect(calls()).toBe(2);
  });
});

describe('cacheKey', () => {
  it('is stable for the same input and differs per model', () => {
    const params = { prompt: [{ role: 'user', content: 'привет' }] };
    expect(cacheKey('openai', 'gpt-4o-mini', params)).toBe(
      cacheKey('openai', 'gpt-4o-mini', params),
    );
    expect(cacheKey('openai', 'gpt-4o-mini', params)).not.toBe(
      cacheKey('openai', 'gpt-5-mini', params),
    );
    expect(cacheKey('openai', 'gpt-4o-mini', params)).not.toBe(
      cacheKey('anthropic', 'gpt-4o-mini', params),
    );
  });
});
