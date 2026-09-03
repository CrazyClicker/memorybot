/**
 * Model references and what a call costs.
 *
 * A `ModelRef` is what a config file names (`{provider: openai, model: gpt-4o-mini}`); the
 * price table turns the token usage the AI SDK reports back into USD for the report's cost
 * column. Prices are per 1M tokens.
 *
 * Sources, with the date they were checked — re-check before quoting costs in a report:
 *   openai    2026-09-03  https://developers.openai.com/api/docs/pricing
 *   anthropic 2026-09-03  https://docs.anthropic.com/en/docs/about-claude/pricing
 * Anthropic charges cache reads at 0.1x and cache writes at 1.25x the base input price.
 *
 * Not covered here: what a hosted memory engine spends inside its own API (mem0's extraction
 * and embedding calls, xmemory's reads). Those never pass through our usage accounting, so
 * the report's cost column measures the agent and the judge only. Say so in the report.
 */
import type { LanguageModelUsage } from 'ai';

export type Provider = 'openai' | 'anthropic';

export interface ModelRef {
  readonly provider: Provider;
  readonly model: string;
}

/** USD per 1M tokens. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  /** Input tokens served from the provider's prompt cache. Defaults to the input price. */
  readonly cacheRead?: number;
  /** Input tokens written to the provider's prompt cache. Defaults to the input price. */
  readonly cacheWrite?: number;
}

export function modelKey(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'openai:gpt-4o-mini': { input: 0.15, cacheRead: 0.075, output: 0.6 },
  'openai:gpt-4.1-mini': { input: 0.4, cacheRead: 0.1, output: 1.6 },
  'openai:gpt-5-mini': { input: 0.25, cacheRead: 0.025, output: 2.0 },
  'openai:gpt-5-nano': { input: 0.05, cacheRead: 0.005, output: 0.4 },
  'openai:gpt-5.4': { input: 2.5, cacheRead: 0.25, output: 15.0 },
  'openai:gpt-5.4-mini': { input: 0.75, cacheRead: 0.075, output: 4.5 },
  'openai:gpt-5.4-nano': { input: 0.2, cacheRead: 0.02, output: 1.25 },
  'anthropic:claude-haiku-4-5': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0 },
  'anthropic:claude-sonnet-5': { input: 2.0, cacheRead: 0.2, cacheWrite: 2.5, output: 10.0 },
  'anthropic:claude-opus-5': { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
};

export function priceFor(ref: ModelRef): ModelPrice | undefined {
  return MODEL_PRICES[modelKey(ref)];
}

/**
 * Token counts for one call, normalised. `inputTokens` is the total the provider billed as
 * input and already contains `cacheReadTokens` and `cacheWriteTokens`; `uncachedInputTokens`
 * is the remainder, which is the part charged at the full input price.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

export function tokenUsage(usage: LanguageModelUsage): TokenUsage {
  const inputTokens = usage.inputTokens ?? 0;
  const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const uncachedInputTokens =
    usage.inputTokenDetails.noCacheTokens ??
    Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  return {
    inputTokens,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: usage.outputTokens ?? 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** USD for one call, or `undefined` when the model has no price entry. */
export function costUsd(ref: ModelRef, usage: TokenUsage): number | undefined {
  const price = priceFor(ref);
  if (price === undefined) return undefined;
  const perToken = (perMTok: number, tokens: number): number => (perMTok * tokens) / 1_000_000;
  return (
    perToken(price.input, usage.uncachedInputTokens) +
    perToken(price.cacheRead ?? price.input, usage.cacheReadTokens) +
    perToken(price.cacheWrite ?? price.input, usage.cacheWriteTokens) +
    perToken(price.output, usage.outputTokens)
  );
}
