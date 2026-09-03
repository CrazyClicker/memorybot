/**
 * Provider registry: a `ModelRef` from a config file becomes a model instance the AI SDK can
 * call. Providers and models are created lazily and memoised per API key, so a matrix run
 * reuses one client per provider instead of building one per turn.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel } from 'ai';

import { DEFAULT_CACHE_DIR, diskCacheMiddleware, type ResolvedModel } from './cache.ts';
import type { ModelRef, Provider } from './models.ts';

export const API_KEY_ENV: Readonly<Record<Provider, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

export type Env = Readonly<Record<string, string | undefined>>;

export class MissingApiKeyError extends Error {
  constructor(
    readonly provider: Provider,
    readonly model: string,
  ) {
    super(
      `${API_KEY_ENV[provider]} is not set, needed for ${provider}:${model}. ` +
        `Add it to .env (see .env.example).`,
    );
    this.name = 'MissingApiKeyError';
  }
}

export function hasApiKey(provider: Provider, env: Env = process.env): boolean {
  const key = env[API_KEY_ENV[provider]];
  return key !== undefined && key !== '';
}

/** `LLM_CACHE=1` turns the disk cache on; `LLM_CACHE_DIR` moves it. */
export function cacheDirFrom(env: Env = process.env): string | undefined {
  if (env['LLM_CACHE'] !== '1') return undefined;
  return env['LLM_CACHE_DIR'] ?? DEFAULT_CACHE_DIR;
}

type ProviderFactory = (modelId: string) => ResolvedModel;

const providerCache = new Map<string, ProviderFactory>();
const modelCache = new Map<string, ResolvedModel>();

function providerFor(provider: Provider, apiKey: string): ProviderFactory {
  const key = `${provider}:${apiKey}`;
  const existing = providerCache.get(key);
  if (existing !== undefined) return existing;

  const factory: ProviderFactory =
    provider === 'openai' ? createOpenAI({ apiKey }) : createAnthropic({ apiKey });
  providerCache.set(key, factory);
  return factory;
}

export interface ResolveOptions {
  readonly env?: Env;
  /** Cache directory, `false` to force the cache off. Defaults to what `LLM_CACHE` says. */
  readonly cache?: string | false;
}

export function resolveModel(ref: ModelRef, options: ResolveOptions = {}): ResolvedModel {
  const env = options.env ?? process.env;
  const apiKey = env[API_KEY_ENV[ref.provider]];
  if (apiKey === undefined || apiKey === '') {
    throw new MissingApiKeyError(ref.provider, ref.model);
  }

  const cacheDir = options.cache === false ? undefined : (options.cache ?? cacheDirFrom(env));
  const key = `${ref.provider}:${apiKey}:${ref.model}:${cacheDir ?? ''}`;
  const existing = modelCache.get(key);
  if (existing !== undefined) return existing;

  const model = providerFor(ref.provider, apiKey)(ref.model);
  const resolved =
    cacheDir === undefined
      ? model
      : wrapLanguageModel({ model, middleware: diskCacheMiddleware(cacheDir) });
  modelCache.set(key, resolved);
  return resolved;
}

/** Test seam: drop memoised providers and models. */
export function resetProviderCache(): void {
  providerCache.clear();
  modelCache.clear();
}
