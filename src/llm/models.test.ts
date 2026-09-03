import type { LanguageModelUsage } from 'ai';
import { describe, expect, it } from 'vitest';

import { addUsage, costUsd, priceFor, tokenUsage, ZERO_USAGE } from './models.ts';

function usage(over: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: 1000,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: 500,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: 1500,
    ...over,
  };
}

describe('tokenUsage', () => {
  it('treats every input token as uncached when the provider reports no detail', () => {
    expect(tokenUsage(usage())).toEqual({
      inputTokens: 1000,
      uncachedInputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 500,
    });
  });

  it('derives the uncached part from the total, which includes cached tokens', () => {
    const normalised = tokenUsage(
      usage({
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: 800,
          cacheWriteTokens: 100,
        },
      }),
    );
    expect(normalised.uncachedInputTokens).toBe(100);
    expect(normalised.cacheReadTokens).toBe(800);
  });

  it('prefers the provider-reported uncached count', () => {
    const normalised = tokenUsage(
      usage({
        inputTokenDetails: { noCacheTokens: 250, cacheReadTokens: 750, cacheWriteTokens: 0 },
      }),
    );
    expect(normalised.uncachedInputTokens).toBe(250);
  });

  it('reads a missing count as zero', () => {
    expect(tokenUsage(usage({ inputTokens: undefined, outputTokens: undefined }))).toEqual(
      ZERO_USAGE,
    );
  });
});

describe('costUsd', () => {
  const ref = { provider: 'openai', model: 'gpt-4o-mini' } as const;

  it('charges input and output at the listed price', () => {
    // 1M input at $0.15 + 1M output at $0.60
    const cost = costUsd(ref, {
      inputTokens: 1_000_000,
      uncachedInputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.75, 10);
  });

  it('charges cache reads at the cache price, not the input price', () => {
    const cost = costUsd(ref, {
      inputTokens: 1_000_000,
      uncachedInputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(0.075, 10);
  });

  it('charges Anthropic cache writes at the write price', () => {
    const cost = costUsd(
      { provider: 'anthropic', model: 'claude-sonnet-5' },
      {
        inputTokens: 1_000_000,
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 1_000_000,
        outputTokens: 0,
      },
    );
    expect(cost).toBeCloseTo(2.5, 10);
  });

  it('is undefined for a model with no price entry, rather than zero', () => {
    expect(costUsd({ provider: 'openai', model: 'gpt-9-imaginary' }, ZERO_USAGE)).toBeUndefined();
    expect(priceFor({ provider: 'openai', model: 'gpt-9-imaginary' })).toBeUndefined();
  });
});

describe('addUsage', () => {
  it('sums every field, so a turn can total its steps', () => {
    const step = {
      inputTokens: 10,
      uncachedInputTokens: 6,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      outputTokens: 5,
    };
    expect(addUsage(step, step)).toEqual({
      inputTokens: 20,
      uncachedInputTokens: 12,
      cacheReadTokens: 6,
      cacheWriteTokens: 2,
      outputTokens: 10,
    });
  });
});
