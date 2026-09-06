/**
 * `live/config.yaml` (ROADMAP T5.1): the repository, the labels, the people and the merchants
 * of the live loop. Committed; secrets stay in `.env`. The loop (T4.3) reads it to map GitHub
 * logins and form values to session customers and to know whose comments are commands.
 */
import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { Customer } from '../evals/schema.ts';
import { DEFAULT_SESSION_CONFIG } from './session.ts';

export const DEFAULT_LIVE_CONFIG_PATH = 'live/config.yaml';
export const DEFAULT_POLL_SECONDS = 30;

const LoginSchema = z.string().trim().min(1);
const CUSTOMER_ID = /^[a-z0-9][a-z0-9_-]*$/;

export const LiveLabelsSchema = z.strictObject({
  /** Issues opened through the form carry it; the loop polls issues with this label. */
  support: z.string().trim().min(1).default('support'),
  answered: z.string().trim().min(1).default('agent:answered'),
  asked: z.string().trim().min(1).default('agent:asked'),
  escalated: z.string().trim().min(1).default('escalated'),
  failed: z.string().trim().min(1).default('agent:failed'),
  /** On documentation-proposal pull requests (T4.5). */
  proposal: z.string().trim().min(1).default('proposal'),
});
export type LiveLabels = z.infer<typeof LiveLabelsSchema>;

export const LiveCustomerSchema = z.strictObject({
  /** The dropdown value in `.github/ISSUE_TEMPLATE/support.yml`. */
  form: z.string().trim().min(1),
  name: z.string().trim().min(1),
  /** Free text shown to the agent as the CRM record. */
  profile: z.string().optional(),
  /** Fallback when an issue was not opened through the form. */
  logins: z.array(LoginSchema).default([]),
});
export type LiveCustomer = z.infer<typeof LiveCustomerSchema>;

export const LiveConfigSchema = z
  .strictObject({
    repo: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo must be "owner/name"'),
    poll_seconds: z.number().int().positive().default(DEFAULT_POLL_SECONDS),
    /** The eval config the loop runs; its `judge` block is ignored (D15). */
    config: z.string().trim().min(1).default(DEFAULT_SESSION_CONFIG),
    labels: LiveLabelsSchema.prefault({}),
    /** The pinned "🧠 Память агента" issue (T4.4); absent until it exists. */
    memory_issue: z.number().int().positive().optional(),
    /** Support engineers: their comments are `human_reply` events and may carry commands. */
    humans: z.array(LoginSchema).min(1),
    customers: z.record(z.string(), LiveCustomerSchema),
  })
  .superRefine((config, context) => {
    const humans = new Set(config.humans.map(lower));
    if (humans.size !== config.humans.length) {
      context.addIssue({ code: 'custom', path: ['humans'], message: 'duplicate login' });
    }
    const forms = new Map<string, string>();
    const logins = new Map<string, string>();
    for (const [id, customer] of Object.entries(config.customers)) {
      if (!CUSTOMER_ID.test(id)) {
        context.addIssue({
          code: 'custom',
          path: ['customers', id],
          message: `customer ids use lowercase letters, digits, "-" or "_", got "${id}"`,
        });
      }
      const form = lower(customer.form);
      const formOwner = forms.get(form);
      if (formOwner !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['customers', id, 'form'],
          message: `form value "${customer.form}" is already used by "${formOwner}"`,
        });
      }
      forms.set(form, id);
      for (const login of customer.logins) {
        const key = lower(login);
        const owner = logins.get(key);
        if (owner !== undefined) {
          context.addIssue({
            code: 'custom',
            path: ['customers', id, 'logins'],
            message: `login "${login}" is already mapped to "${owner}"`,
          });
        }
        if (humans.has(key)) {
          context.addIssue({
            code: 'custom',
            path: ['customers', id, 'logins'],
            message: `login "${login}" is listed under humans`,
          });
        }
        logins.set(key, id);
      }
    }
  });
export type LiveConfig = z.infer<typeof LiveConfigSchema>;

export function parseLiveConfig(raw: unknown, source = '<live config>'): LiveConfig {
  const parsed = LiveConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid live config ${source}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function loadLiveConfig(path: string = DEFAULT_LIVE_CONFIG_PATH): Promise<LiveConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read live config ${path}: ${(error as Error).message}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new Error(`Invalid YAML in live config ${path}: ${(error as Error).message}`, { cause: error });
  }
  return parseLiveConfig(raw, path);
}

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

/** The CRM records `Session` shows the agent, by customer id. */
export function sessionCustomers(config: LiveConfig): Record<string, Customer> {
  return Object.fromEntries(
    Object.entries(config.customers).map(([id, customer]) => [
      id,
      { name: customer.name, ...(customer.profile === undefined ? {} : { profile: customer.profile }) },
    ]),
  );
}

/** Customer id for a merchant dropdown value; whitespace and case are forgiven. */
export function customerByForm(config: LiveConfig, value: string): string | undefined {
  const wanted = lower(value);
  if (wanted === '') return undefined;
  return Object.entries(config.customers).find(([, customer]) => lower(customer.form) === wanted)?.[0];
}

/** Customer id for a GitHub login from the fallback map; GitHub logins are case-insensitive. */
export function customerByLogin(config: LiveConfig, login: string): string | undefined {
  const wanted = lower(login);
  if (wanted === '') return undefined;
  return Object.entries(config.customers).find(([, customer]) =>
    customer.logins.some((candidate) => lower(candidate) === wanted),
  )?.[0];
}

export function isHuman(config: LiveConfig, login: string): boolean {
  const wanted = lower(login);
  return config.humans.some((human) => lower(human) === wanted);
}

export function sameLogin(a: string, b: string): boolean {
  return lower(a) === lower(b);
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}
