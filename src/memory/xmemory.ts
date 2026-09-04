import { randomBytes } from 'node:crypto';

import { DateOrTimestampSchema } from '../evals/schema.ts';
import {
  cloneMemoryItem,
  dateStatement,
  type MemoryEngine,
  type MemoryEngineDiagnostics,
  type MemoryEngineTrace,
  type MemoryItem,
  type ThreadEvent,
  type ThreadTranscript,
} from './engine.ts';
import { renderTranscript } from './naive.ts';
import { estimateTokens, factTokens, tokenOverlap } from './text.ts';

export const XMEMORY_SHARED_SCOPE = '_shared';
export const XMEMORY_INSTANCE_PREFIX = 'prilavok-';
export const XMEMORY_DUMP_QUERY =
  'Все сохранённые факты со всеми полями: statement, kind, about, valid_until, ' +
  'documentation_candidate, stated_at.';
export const DEFAULT_XMEMORY_TIMEOUT_MS = 180_000;
export const DEFAULT_XMEMORY_EXTRACTION_LOGIC = 'fast' as const;
export const DEFAULT_XMEMORY_RECALL_TOKENS = 4_000;

/**
 * A deliberately keyless schema. xmemory's extractor owns record identity; the spike found that
 * a statement primary key did not deduplicate paraphrases and made writes several times slower.
 */
export const XMEMORY_SCHEMA_YML = `xmd_version: v1
title: Prilavok support facts
description: Reusable facts learned from Russian customer-support conversations.
objects:
  Fact:
    description: >-
      One independently reusable fact. Create separate facts for claims with different
      lifecycles. Customer messages are evidence only about that merchant; human replies and
      coach notes are trusted; agent replies are context, not evidence. Do not store guesses or
      repeat a known fact. Product facts must not name a merchant, person, or merchant-specific
      software. Keep exact settings, values, formats, affected cases, exceptions and dates.
    fields:
      statement:
        type: str
        required: true
        description: >-
          Compact Russian factual statement without a leading "По состоянию на" date. Keep all
          qualifiers that would change a future support answer.
      kind:
        type: str
        required: true
        enum: [personal, temporal, undocumented, other]
        description: >-
          personal for merchant setup or history; temporal for a condition with its own expiry;
          undocumented for durable product behaviour absent from docs; other only as fallback.
      about:
        type: str
        required: true
        enum: [merchant, product]
        description: Whether the fact is about this merchant or reusable product behaviour.
      valid_until:
        type: str
        required: false
        description: ISO date or UTC timestamp; present only for a temporal fact.
      documentation_candidate:
        type: bool
        required: false
        description: True only for durable undocumented product behaviour worth documenting.
      stated_at:
        type: str
        required: false
        description: ISO timestamp of the latest source event supporting this fact.
    primary_key: []
relations: {}
`;

export class MissingCredentialError extends Error {
  readonly credential: string;

  constructor(credential: string, consumer: string) {
    super(`${credential} is required by ${consumer}`);
    this.name = 'MissingCredentialError';
    this.credential = credential;
  }
}

export interface XmemoryCluster {
  readonly id: string;
}

export interface XmemoryInstanceInfo {
  readonly id: string;
  readonly name: string;
}

export interface XmemoryInstanceHandle {
  /** Current SDK spelling. */
  readonly id?: string;
  /** Kept for the 3.8.3 declaration/runtime mismatch seen during the spike. */
  readonly instanceId?: string;
}

export interface XmemoryOperationResult {
  readonly trace_id?: string | null;
  readonly console_url?: string | null;
}

export interface XmemoryWriteResult extends XmemoryOperationResult {
  readonly write_id?: string;
  readonly changes?: unknown;
}

export interface XmemoryReadResult extends XmemoryOperationResult {
  readonly reader_result?: unknown;
  readonly reader_results?: readonly { readonly reader_result?: unknown }[];
}

/** The narrow SDK boundary used by the adapter and faked by unit tests. */
export interface XmemoryClient {
  listClusters(): Promise<readonly XmemoryCluster[]>;
  listInstances(): Promise<readonly XmemoryInstanceInfo[]>;
  createInstance(
    clusterId: string,
    name: string,
    schemaYml: string,
    options: { readonly description: string; readonly timeoutMs: number },
  ): Promise<XmemoryInstanceHandle>;
  deleteInstance(instanceId: string, options: { readonly timeoutMs: number }): Promise<unknown>;
  write(
    instanceId: string,
    text: string,
    options: { readonly extractionLogic: XmemoryExtractionLogic; readonly timeoutMs: number },
  ): Promise<XmemoryWriteResult>;
  read(
    instanceId: string,
    query: string,
    options: { readonly readMode: 'xresponse'; readonly timeoutMs: number },
  ): Promise<XmemoryReadResult>;
}

export type XmemoryExtractionLogic = 'fast' | 'deep';

export interface XmemoryMemoryOptions {
  readonly client?: XmemoryClient;
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly clusterId?: string;
  readonly extractionLogic?: XmemoryExtractionLogic;
  readonly timeoutMs?: number;
  readonly maxRecallTokens?: number;
  readonly countTokens?: (text: string) => number;
  /** Direct injection makes rate-limit tests immediate. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly tag?: string;
}

interface InstanceBinding {
  readonly id: string;
  readonly scopeKey: string;
}

interface ItemDefaults {
  readonly kind: MemoryItem['kind'];
  readonly about: string;
  readonly learnedFrom: string;
  readonly scope: MemoryItem['scope'];
  readonly source: MemoryItem['source'];
  readonly createdAt: string;
}

interface MutableCallCounts {
  creates: number;
  reads: number;
  writes: number;
  deletes: number;
}

/** Hosted xmemory with one physical instance per customer and a separate shared instance. */
export class XmemoryMemoryEngine implements MemoryEngine {
  readonly id = 'xmemory';

  private readonly client: XmemoryClient;
  private readonly clusterId?: string;
  private readonly extractionLogic: XmemoryExtractionLogic;
  private readonly timeoutMs: number;
  private readonly maxRecallTokens: number;
  private readonly countTokens: (text: string) => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly tag: string;
  private readonly instances = new Map<string, Promise<InstanceBinding>>();
  private readonly itemDefaults = new Map<string, ItemDefaults>();
  private traces: MemoryEngineTrace[] = [];
  private calls: MutableCallCounts = emptyCallCounts();
  private latestScenarioTime = new Date(0).toISOString();

  constructor(options: XmemoryMemoryOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_XMEMORY_TIMEOUT_MS;
    const maxRecallTokens = options.maxRecallTokens ?? DEFAULT_XMEMORY_RECALL_TOKENS;
    assertPositiveInteger('timeoutMs', timeoutMs);
    assertNonNegativeInteger('maxRecallTokens', maxRecallTokens);
    this.extractionLogic = options.extractionLogic ?? environmentExtractionLogic();
    this.timeoutMs = timeoutMs;
    this.maxRecallTokens = maxRecallTokens;
    this.countTokens = options.countTokens ?? estimateTokens;
    this.sleep = options.sleep ?? sleep;
    this.clusterId = nonEmpty(options.clusterId) ?? nonEmpty(process.env['XMEMORY_CLUSTER_ID']);
    this.tag = validateTag(options.tag ?? randomBytes(3).toString('hex'));

    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const apiKey = nonEmpty(options.apiKey) ?? nonEmpty(process.env['XMEMORY_API_KEY']);
      if (apiKey === undefined) throw new MissingCredentialError('XMEMORY_API_KEY', 'xmemory');
      this.client = new LazySdkXmemoryClient({
        apiKey,
        apiUrl: nonEmpty(options.apiUrl) ?? nonEmpty(process.env['XMEMORY_API_URL']),
        timeoutMs,
      });
    }
  }

  async reset(): Promise<void> {
    this.instances.clear();
    this.itemDefaults.clear();
    this.traces = [];
    this.calls = emptyCallCounts();
    this.latestScenarioTime = new Date(0).toISOString();

    const leftovers = (await this.retry('list', undefined, () => this.client.listInstances()))
      .filter(({ name }) => name.startsWith(XMEMORY_INSTANCE_PREFIX));
    await Promise.all(leftovers.map(async ({ id, name }) => {
      await this.retry('delete', scopeFromInstanceName(name), () =>
        this.client.deleteInstance(id, { timeoutMs: this.timeoutMs }));
    }));
  }

  async recall(customer: string, query: string, now: string): Promise<MemoryItem[]> {
    this.latestScenarioTime = now;
    const bindings = await this.existingBindings([customer, XMEMORY_SHARED_SCOPE]);
    const batches = await Promise.all(bindings.map(async (binding) => ({
      binding,
      result: await this.retry('read', binding.scopeKey, () =>
        this.client.read(binding.id, XMEMORY_DUMP_QUERY, {
          readMode: 'xresponse',
          timeoutMs: this.timeoutMs,
        })),
    })));
    const items = batches.flatMap(({ binding, result }) =>
      objectsFromRead(result).flatMap((object) => {
        const remembered = this.itemDefaults.get(objectId(object) ?? '');
        const defaults = remembered ?? defaultsForBinding(binding, now);
        const item = fromXmemoryObject(object, defaults, now);
        return item === undefined ? [] : [item];
      }));
    return rankAndLimit(items, query, this.maxRecallTokens, this.countTokens);
  }

  async write(items: MemoryItem[], now: string): Promise<void> {
    this.latestScenarioTime = now;
    const groups = groupByScope(items);
    await Promise.all([...groups].map(async ([scopeKey, group]) => {
      const binding = await this.instance(scopeKey);
      const result = await this.retry('write', scopeKey, () =>
        this.client.write(binding.id, explicitItemsText(group, now), {
          extractionLogic: this.extractionLogic,
          timeoutMs: this.timeoutMs,
        }));
      const first = group[0];
      if (first !== undefined) {
        rememberDefaults(result.changes, this.itemDefaults, {
          kind: first.kind,
          about: first.about,
          learnedFrom: first.learnedFrom,
          scope: first.scope,
          source: first.source,
          createdAt: now,
        });
      }
    }));
  }

  async consolidate(thread: ThreadTranscript, now: string): Promise<MemoryItem[]> {
    this.latestScenarioTime = now;
    if (thread.events.length === 0) return [];

    const customerEvents = thread.events.filter((event) => !isSharedProductNote(event));
    const productEvents = thread.events.filter(isSharedProductNote);
    const writes: Array<{ scopeKey: string; transcript: ThreadTranscript; defaults: ItemDefaults }> = [];
    if (customerEvents.length > 0) {
      writes.push({
        scopeKey: thread.customer,
        transcript: { ...thread, events: customerEvents },
        defaults: defaultsForTranscript(thread, 'customer', now),
      });
    }
    if (productEvents.length > 0) {
      writes.push({
        scopeKey: XMEMORY_SHARED_SCOPE,
        transcript: { ...thread, events: productEvents },
        defaults: defaultsForTranscript(thread, 'shared', now),
      });
    }

    const results = await Promise.all(writes.map(async (write) => {
      const binding = await this.instance(write.scopeKey);
      const result = await this.retry('write', write.scopeKey, () =>
        this.client.write(binding.id, toXmemoryText(write.transcript, now), {
          extractionLogic: this.extractionLogic,
          timeoutMs: this.timeoutMs,
        }));
      rememberDefaults(result.changes, this.itemDefaults, write.defaults);
      return changedObjects(result.changes).flatMap((object) => {
        const item = fromXmemoryObject(object, write.defaults, now);
        return item === undefined ? [] : [item];
      });
    }));
    return results.flat().map(cloneMemoryItem);
  }

  async proposals(): Promise<MemoryItem[]> {
    const bindings = await this.existingBindings([...this.instances.keys()]);
    const results = await Promise.all(bindings.map(async (binding) => ({
      binding,
      result: await this.retry('read', binding.scopeKey, () =>
        this.client.read(binding.id, XMEMORY_DUMP_QUERY, {
          readMode: 'xresponse',
          timeoutMs: this.timeoutMs,
        })),
    })));
    return results.flatMap(({ binding, result }) =>
      objectsFromRead(result).flatMap((object) => {
        const remembered = this.itemDefaults.get(objectId(object) ?? '');
        const item = fromXmemoryObject(
          object,
          remembered ?? defaultsForBinding(binding, this.latestScenarioTime),
          this.latestScenarioTime,
        );
        return item?.about === 'product' && item.documentationCandidate === true ? [item] : [];
      }));
  }

  async cleanup(): Promise<void> {
    const bindings = await this.existingBindings([...this.instances.keys()]);
    await Promise.all(bindings.map(async (binding) => {
      await this.retry('delete', binding.scopeKey, () =>
        this.client.deleteInstance(binding.id, { timeoutMs: this.timeoutMs }));
    }));
    this.instances.clear();
    this.itemDefaults.clear();
  }

  diagnostics(): MemoryEngineDiagnostics {
    return {
      calls: { ...this.calls },
      traces: this.traces.map((trace) => ({ ...trace })),
    };
  }

  private async instance(scopeKey: string): Promise<InstanceBinding> {
    let pending = this.instances.get(scopeKey);
    if (pending === undefined) {
      pending = this.createInstance(scopeKey);
      this.instances.set(scopeKey, pending);
      pending.catch(() => this.instances.delete(scopeKey));
    }
    return pending;
  }

  private async createInstance(scopeKey: string): Promise<InstanceBinding> {
    const name = instanceName(this.tag, scopeKey);
    const clusterId = await this.resolveClusterId();
    const handle = await this.retry('create', scopeKey, () =>
      this.client.createInstance(clusterId, name, XMEMORY_SCHEMA_YML, {
        description: `Temporary Prilavok eval memory for scope ${scopeKey}`,
        timeoutMs: this.timeoutMs,
      }));
    const id = nonEmpty(handle.id) ?? nonEmpty(handle.instanceId) ??
      nonEmpty((await this.retry('list', scopeKey, () => this.client.listInstances()))
        .find((candidate) => candidate.name === name)?.id);
    if (id === undefined) throw new Error(`xmemory created instance "${name}" but returned no id`);
    return { id, scopeKey };
  }

  private async resolveClusterId(): Promise<string> {
    if (this.clusterId !== undefined) return this.clusterId;
    const clusters = await this.retry('list', undefined, () => this.client.listClusters());
    if (clusters.length !== 1 || clusters[0] === undefined) {
      throw new Error(
        `xmemory needs XMEMORY_CLUSTER_ID when the account has ${clusters.length} clusters`,
      );
    }
    return clusters[0].id;
  }

  private async existingBindings(scopeKeys: readonly string[]): Promise<InstanceBinding[]> {
    const unique = [...new Set(scopeKeys)];
    const bindings = await Promise.all(unique.map(async (scopeKey) => {
      const pending = this.instances.get(scopeKey);
      return pending === undefined ? undefined : pending;
    }));
    return bindings.filter((binding): binding is InstanceBinding => binding !== undefined);
  }

  private async retry<T>(
    operation: MemoryEngineTrace['operation'] | 'list',
    scopeKey: string | undefined,
    call: () => Promise<T>,
  ): Promise<T> {
    for (let retry = 0; ; retry += 1) {
      if (operation !== 'list') this.calls[`${operation}s`] += 1;
      try {
        const result = await call();
        if (operation !== 'list') this.recordTrace(operation, scopeKey, result);
        return result;
      } catch (error) {
        if (errorCode(error) === 'QUOTA_EXCEEDED') throw quotaError(error);
        if (errorCode(error) !== 'RATE_LIMITED' || retry >= 3) throw error;
        await this.sleep(Math.max(0, retryAfterSeconds(error) ?? 1) * 1_000);
      }
    }
  }

  private recordTrace(operation: MemoryEngineTrace['operation'], scopeKey: string | undefined, raw: unknown): void {
    const result = record(raw);
    const instanceId = nonEmpty(result?.['id']) ?? nonEmpty(result?.['instanceId']);
    this.traces.push({
      operation,
      ...(scopeKey === undefined ? {} : { scope: scopeKey }),
      ...(instanceId === undefined ? {} : { instanceId }),
      ...(nonEmpty(result?.['trace_id']) === undefined ? {} : { traceId: nonEmpty(result?.['trace_id']) }),
      ...(nonEmpty(result?.['console_url']) === undefined ? {} : { consoleUrl: nonEmpty(result?.['console_url']) }),
    });
  }
}

export function createXmemoryMemoryEngine(options: XmemoryMemoryOptions = {}): XmemoryMemoryEngine {
  return new XmemoryMemoryEngine(options);
}

export function toXmemoryText(thread: ThreadTranscript, now: string): string {
  return [
    'Извлеки только подтверждённые факты по правилам схемы. Времена событий — время сценария.',
    renderTranscript(thread, now),
  ].join('\n\n');
}

export function fromXmemoryObject(
  raw: unknown,
  defaults: ItemDefaults,
  now?: string,
): MemoryItem | undefined {
  const fields = objectFields(raw);
  const statement = nonEmpty(fields.get('statement'));
  if (statement === undefined) return undefined;
  const aboutValue = nonEmpty(fields.get('about'));
  const about = aboutValue === 'product' ? 'product' : defaults.about;
  const validUntil = normalizeDate(fields.get('valid_until'));
  const documentationCandidate = booleanValue(fields.get('documentation_candidate'));
  const statedAt = normalizeDate(fields.get('stated_at')) ?? now ?? defaults.createdAt;
  const id = objectId(raw) ?? stableFallbackId(statement, defaults);
  return {
    id,
    kind: memoryKind(fields.get('kind')) ?? defaults.kind,
    about,
    learnedFrom: defaults.learnedFrom,
    scope: defaults.scope,
    statement: dateStatement(statement, statedAt),
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(documentationCandidate === undefined ? {} : { documentationCandidate }),
    source: { ...defaults.source },
    createdAt: defaults.createdAt,
  };
}

interface SdkClientOptions {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly timeoutMs: number;
}

/** Delay importing the hosted SDK until an xmemory config performs its first operation. */
class LazySdkXmemoryClient implements XmemoryClient {
  private sdk?: Promise<import('xmemory').XmemoryClient>;

  constructor(private readonly options: SdkClientOptions) {}

  async listClusters(): Promise<readonly XmemoryCluster[]> {
    return (await this.get()).admin.listClusters({ timeoutMs: this.options.timeoutMs });
  }

  async listInstances(): Promise<readonly XmemoryInstanceInfo[]> {
    return (await this.get()).admin.listInstances({ timeoutMs: this.options.timeoutMs });
  }

  async createInstance(
    clusterId: string,
    name: string,
    schemaYml: string,
    options: { readonly description: string; readonly timeoutMs: number },
  ): Promise<XmemoryInstanceHandle> {
    const { SchemaType } = await import('xmemory');
    return (await this.get()).admin.createInstance(clusterId, name, schemaYml, SchemaType.YML, options);
  }

  async deleteInstance(instanceId: string, options: { readonly timeoutMs: number }): Promise<unknown> {
    return (await this.get()).admin.deleteInstance(instanceId, options);
  }

  async write(
    instanceId: string,
    text: string,
    options: { readonly extractionLogic: XmemoryExtractionLogic; readonly timeoutMs: number },
  ): Promise<XmemoryWriteResult> {
    return (await this.get()).instance(instanceId).write(text, options);
  }

  async read(
    instanceId: string,
    query: string,
    options: { readonly readMode: 'xresponse'; readonly timeoutMs: number },
  ): Promise<XmemoryReadResult> {
    return (await this.get()).instance(instanceId).read(query, options);
  }

  private get(): Promise<import('xmemory').XmemoryClient> {
    if (this.sdk === undefined) this.sdk = this.load();
    return this.sdk;
  }

  private async load(): Promise<import('xmemory').XmemoryClient> {
    const { XmemoryClient: SdkClient } = await import('xmemory');
    return new SdkClient({
      apiKey: this.options.apiKey,
      ...(this.options.apiUrl === undefined ? {} : { url: this.options.apiUrl }),
      timeoutMs: this.options.timeoutMs,
    });
  }
}

function isSharedProductNote(event: ThreadEvent): boolean {
  return event.type === 'coach_note' && event.scope === 'product';
}

function defaultsForTranscript(
  thread: ThreadTranscript,
  scope: MemoryItem['scope'],
  now: string,
): ItemDefaults {
  return {
    kind: 'other',
    about: scope === 'shared' ? 'product' : thread.customer,
    learnedFrom: thread.customer,
    scope,
    source: { thread: thread.id, via: 'consolidate' },
    createdAt: now,
  };
}

function defaultsForBinding(binding: InstanceBinding, now: string): ItemDefaults {
  const shared = binding.scopeKey === XMEMORY_SHARED_SCOPE;
  return {
    kind: 'other',
    about: shared ? 'product' : binding.scopeKey,
    learnedFrom: shared ? XMEMORY_SHARED_SCOPE : binding.scopeKey,
    scope: shared ? 'shared' : 'customer',
    source: { thread: `xmemory-${binding.scopeKey}`, via: 'consolidate' },
    createdAt: now,
  };
}

function groupByScope(items: readonly MemoryItem[]): Map<string, MemoryItem[]> {
  const groups = new Map<string, MemoryItem[]>();
  for (const item of items) {
    const key = item.scope === 'shared' ? XMEMORY_SHARED_SCOPE : item.learnedFrom;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function explicitItemsText(items: readonly MemoryItem[], now: string): string {
  return items.map((raw, index) => {
    const item = { ...raw, statement: dateStatement(raw.statement, now) };
    return [
      `Факт ${index + 1}: ${item.statement}`,
      `kind=${item.kind}; about=${item.about === 'product' ? 'product' : 'merchant'};`,
      `valid_until=${item.validUntil ?? 'none'};`,
      `documentation_candidate=${item.documentationCandidate ?? false}; stated_at=${item.createdAt}`,
    ].join(' ');
  }).join('\n');
}

function rankAndLimit(
  items: readonly MemoryItem[],
  query: string,
  maxTokens: number,
  countTokens: (text: string) => number,
): MemoryItem[] {
  const queryTokens = factTokens(query);
  const ranked = [...items].sort((left, right) =>
    tokenOverlap(queryTokens, factTokens(right.statement)) -
      tokenOverlap(queryTokens, factTokens(left.statement)) ||
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.id.localeCompare(left.id),
  );
  const recalled: MemoryItem[] = [];
  let used = 0;
  for (const item of ranked) {
    const tokens = normalizedTokenCount(countTokens(item.statement));
    if (used + tokens > maxTokens) break;
    recalled.push(cloneMemoryItem(item));
    used += tokens;
  }
  return recalled;
}

function changedObjects(changes: unknown): unknown[] {
  const root = record(changes);
  if (root === undefined) return [];
  return ['created', 'updated'].flatMap((change) => {
    const group = record(root[change]);
    if (group === undefined) return [];
    return [
      ...array(group['objects']),
      ...array(group['keyless_objects']),
      ...array(group['created_keyless_objects']),
    ];
  }).concat(array(root['created_keyless_objects']));
}

function objectsFromRead(result: XmemoryReadResult): unknown[] {
  const direct = objectsFromReaderResult(result.reader_result);
  if (direct.length > 0) return direct;
  return (result.reader_results ?? []).flatMap(({ reader_result }) => objectsFromReaderResult(reader_result));
}

function objectsFromReaderResult(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = record(value);
  return object === undefined ? [] : array(object['objects']);
}

function rememberDefaults(changes: unknown, target: Map<string, ItemDefaults>, defaults: ItemDefaults): void {
  for (const object of changedObjects(changes)) {
    const id = objectId(object);
    if (id !== undefined) target.set(id, defaults);
  }
}

function objectFields(raw: unknown): Map<string, unknown> {
  const object = record(raw);
  const fields = new Map<string, unknown>();
  if (object === undefined) return fields;
  const rawFields = object['fields'];
  if (Array.isArray(rawFields)) {
    for (const rawField of rawFields) {
      const field = record(rawField);
      const name = nonEmpty(field?.['name']);
      if (name !== undefined) fields.set(name, unwrapValue(field?.['value']));
    }
  } else {
    const fieldRecord = record(rawFields);
    if (fieldRecord !== undefined) {
      for (const [name, value] of Object.entries(fieldRecord)) fields.set(name, unwrapValue(value));
    }
  }
  return fields;
}

function unwrapValue(value: unknown): unknown {
  const object = record(value);
  if (object === undefined) return value;
  for (const key of ['string_value', 'boolean_value', 'integer_value', 'float_value', 'value']) {
    if (key in object) return object[key];
  }
  return value;
}

function objectId(raw: unknown): string | undefined {
  const object = record(raw);
  if (object === undefined) return undefined;
  const identifier = record(object['identifier']);
  const opaqueIdentifier = nonEmpty(object['identifier']);
  return nonEmpty(object['xuid']) ?? nonEmpty(object['id']) ?? nonEmpty(identifier?.['xuid']) ??
    (opaqueIdentifier !== undefined && !/^#\d+$/.test(opaqueIdentifier) ? opaqueIdentifier : undefined);
}

function stableFallbackId(statement: string, defaults: ItemDefaults): string {
  let hash = 2_166_136_261;
  for (const char of `${defaults.scope}\0${defaults.learnedFrom}\0${statement}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `xmemory-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeDate(value: unknown): string | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  if (DateOrTimestampSchema.safeParse(text).success) return text;
  const bare = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(text);
  if (bare === null) return undefined;
  const candidate = `${bare[1]}T${bare[2]}:${bare[3] ?? '00'}Z`;
  return DateOrTimestampSchema.safeParse(candidate).success ? candidate : undefined;
}

function memoryKind(value: unknown): MemoryItem['kind'] | undefined {
  return value === 'personal' || value === 'temporal' || value === 'undocumented' || value === 'other'
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function environmentExtractionLogic(): XmemoryExtractionLogic {
  const value = nonEmpty(process.env['XMEMORY_EXTRACTION_LOGIC']) ?? DEFAULT_XMEMORY_EXTRACTION_LOGIC;
  if (value !== 'fast' && value !== 'deep') {
    throw new Error(`XMEMORY_EXTRACTION_LOGIC must be "fast" or "deep", got "${value}"`);
  }
  return value;
}

function validateTag(tag: string): string {
  if (!/^[a-z0-9]{1,20}$/.test(tag)) throw new Error(`xmemory tag must be 1-20 lowercase letters or digits, got "${tag}"`);
  return tag;
}

function instanceName(tag: string, scopeKey: string): string {
  return `${XMEMORY_INSTANCE_PREFIX}${tag}-${scopeKey}`;
}

function scopeFromInstanceName(name: string): string | undefined {
  const parts = name.split('-');
  return parts.length >= 3 ? parts.slice(2).join('-') : undefined;
}

function normalizedTokenCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`countTokens must return a finite non-negative number, got ${value}`);
  }
  return Math.ceil(value);
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer, got ${value}`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer, got ${value}`);
  }
}

function emptyCallCounts(): MutableCallCounts {
  return { creates: 0, reads: 0, writes: 0, deletes: 0 };
}

function errorCode(error: unknown): string | undefined {
  return nonEmpty(record(error)?.['code']);
}

function retryAfterSeconds(error: unknown): number | undefined {
  const object = record(error);
  const direct = object?.['retryAfter'];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const detail = record(object?.['details'])?.['retry_after_seconds'];
  return typeof detail === 'number' && Number.isFinite(detail) ? detail : undefined;
}

function quotaError(error: unknown): Error {
  const original = error instanceof Error ? error.message : String(error);
  const details = record(record(error)?.['details']);
  const kind = nonEmpty(details?.['kind']);
  const retryAfter = retryAfterSeconds(error);
  return new Error(
    `xmemory quota exceeded${kind === undefined ? '' : ` (${kind})`}: ${original}; ` +
    `retry_after=${retryAfter === undefined ? 'unknown' : `${retryAfter}s`}`,
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
