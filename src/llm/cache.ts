/**
 * Disk cache for model calls, behind `LLM_CACHE=1`.
 *
 * Developing checks and report code means re-running the same scenario many times over the
 * same prompts. This middleware makes those re-runs free and instant. It is a development
 * aid, never on by default: a cached run reports the recorded usage and cost, and a real
 * measurement must come from a cold cache.
 *
 * The key is a hash of the provider, the model id and the call parameters (messages, tools,
 * temperature, response format), so any change to the prompt or the tool set is a miss.
 * Only `generateText` is cached — streaming (`streamText`, used by the M2 UI) passes through.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { LanguageModelMiddleware } from 'ai';

type WrapGenerate = NonNullable<LanguageModelMiddleware['wrapGenerate']>;

/** The model version the middleware works with, without depending on a `LanguageModelV*` export. */
export type ResolvedModel = Parameters<WrapGenerate>[0]['model'];
type GenerateResult = Awaited<ReturnType<WrapGenerate>>;

interface CacheFile {
  readonly provider: string;
  readonly modelId: string;
  readonly params: unknown;
  readonly result: GenerateResult;
}

export const DEFAULT_CACHE_DIR = '.llm-cache';

export function cacheKey(provider: string, modelId: string, params: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ provider, modelId, params }))
    .digest('hex')
    .slice(0, 32);
}

/**
 * `doGenerate` results are JSON round-tripped, which turns the response timestamp into a
 * string. Put the Date back so callers see the same shape on a hit as on a miss.
 */
function reviveResult(result: GenerateResult): GenerateResult {
  const timestamp = result.response?.timestamp;
  if (timestamp === undefined) return result;
  return { ...result, response: { ...result.response, timestamp: new Date(timestamp) } };
}

export function diskCacheMiddleware(dir: string = DEFAULT_CACHE_DIR): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const key = cacheKey(model.provider, model.modelId, params);
      const file = join(dir, `${key}.json`);

      try {
        const cached = JSON.parse(await readFile(file, 'utf8')) as CacheFile;
        return reviveResult(cached.result);
      } catch {
        // A missing or unreadable entry is a miss; never let the cache fail a run.
      }

      const result = await doGenerate();
      const entry: CacheFile = {
        provider: model.provider,
        modelId: model.modelId,
        params,
        result,
      };
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(entry, null, 2), 'utf8');
      } catch {
        // Caching is best-effort.
      }
      return result;
    },
  };
}
