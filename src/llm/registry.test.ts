import { beforeEach, describe, expect, it } from 'vitest';

import {
  cacheDirFrom,
  hasApiKey,
  MissingApiKeyError,
  resetProviderCache,
  resolveModel,
} from './registry.ts';

const env = { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test' };

beforeEach(() => {
  resetProviderCache();
});

describe('resolveModel', () => {
  it('builds the model a config names', () => {
    const model = resolveModel({ provider: 'openai', model: 'gpt-4o-mini' }, { env });
    expect(model.modelId).toBe('gpt-4o-mini');
    expect(model.provider).toContain('openai');
  });

  it('reuses one provider instance per key', () => {
    const ref = { provider: 'anthropic', model: 'claude-sonnet-5' } as const;
    expect(resolveModel(ref, { env })).toBe(resolveModel(ref, { env }));
  });

  it('names the missing environment variable and the model it was needed for', () => {
    expect(() => resolveModel({ provider: 'anthropic', model: 'claude-sonnet-5' }, { env: {} }))
      .toThrow(MissingApiKeyError);
    expect(() =>
      resolveModel({ provider: 'anthropic', model: 'claude-sonnet-5' }, { env: {} }),
    ).toThrow(/ANTHROPIC_API_KEY.*claude-sonnet-5/s);
  });

  it('treats an empty key as missing', () => {
    expect(() =>
      resolveModel({ provider: 'openai', model: 'gpt-4o-mini' }, { env: { OPENAI_API_KEY: '' } }),
    ).toThrow(MissingApiKeyError);
  });

  it('wraps the model when a cache directory is in play, and not otherwise', () => {
    const ref = { provider: 'openai', model: 'gpt-4o-mini' } as const;
    const plain = resolveModel(ref, { env, cache: false });
    const wrapped = resolveModel(ref, { env, cache: '.llm-cache' });

    expect(wrapped).not.toBe(plain);
    expect(wrapped.modelId).toBe(plain.modelId);
  });

  it('honours LLM_CACHE from the environment', () => {
    const ref = { provider: 'openai', model: 'gpt-4o-mini' } as const;
    const cachedEnv = { ...env, LLM_CACHE: '1' };
    expect(resolveModel(ref, { env: cachedEnv })).not.toBe(resolveModel(ref, { env, cache: false }));
  });
});

describe('hasApiKey', () => {
  it('reports what is configured, so the judge can fall back to another vendor', () => {
    expect(hasApiKey('openai', env)).toBe(true);
    expect(hasApiKey('anthropic', {})).toBe(false);
    expect(hasApiKey('anthropic', { ANTHROPIC_API_KEY: '' })).toBe(false);
  });
});

describe('cacheDirFrom', () => {
  it('is off unless LLM_CACHE is exactly 1', () => {
    expect(cacheDirFrom({})).toBeUndefined();
    expect(cacheDirFrom({ LLM_CACHE: '0' })).toBeUndefined();
    expect(cacheDirFrom({ LLM_CACHE: 'true' })).toBeUndefined();
    expect(cacheDirFrom({ LLM_CACHE: '1' })).toBe('.llm-cache');
  });

  it('respects LLM_CACHE_DIR', () => {
    expect(cacheDirFrom({ LLM_CACHE: '1', LLM_CACHE_DIR: '/tmp/x' })).toBe('/tmp/x');
  });
});
