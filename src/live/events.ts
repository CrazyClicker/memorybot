/**
 * GitHub objects → loop inputs (ROADMAP §6, T4.3): the merchant and the message of an issue
 * opened through the support form, and the commands a human may put in a comment.
 *
 * The form (`.github/ISSUE_TEMPLATE/support.yml`) renders each field as a `### <label>`
 * heading followed by the value, so the merchant is the text under `### Магазин` and the
 * message the text under `### Сообщение`. The heading labels are the form's `label:` values;
 * change both together.
 */
import { customerByForm, customerByLogin, type LiveConfig } from './config.ts';

export const FORM_MERCHANT_HEADING = 'Магазин';
export const FORM_MESSAGE_HEADING = 'Сообщение';
/** What GitHub renders for an optional form field left empty. */
const NO_RESPONSE = '_No response_';

// ---------------------------------------------------------------------------------------------
// Issue form
// ---------------------------------------------------------------------------------------------

/**
 * `### Heading` sections of an issue body, heading → trimmed text under it. A body without
 * headings gives an empty map. The section before the first heading is dropped.
 */
export function parseIssueForm(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (heading === undefined) return;
    const text = lines.join('\n').trim();
    sections.set(heading, text === NO_RESPONSE ? '' : text);
  };
  for (const line of body.split(/\r?\n/)) {
    const match = /^###\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      heading = match[1];
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

export interface ResolvedCustomer {
  readonly id: string;
  readonly via: 'form' | 'login';
}

/**
 * The merchant an issue belongs to: the form's merchant field when it names a configured
 * customer, otherwise the author's login through the fallback map; undefined when neither.
 */
export function resolveIssueCustomer(
  issue: { readonly body: string; readonly author: string },
  config: LiveConfig,
  form: Map<string, string> = parseIssueForm(issue.body),
): ResolvedCustomer | undefined {
  const merchant = form.get(FORM_MERCHANT_HEADING);
  if (merchant !== undefined) {
    const id = customerByForm(config, merchant);
    if (id !== undefined) return { id, via: 'form' };
  }
  const id = customerByLogin(config, issue.author);
  return id === undefined ? undefined : { id, via: 'login' };
}

/**
 * The customer message an issue opens with: the subject line, then the form's message field
 * (or the whole body when the issue was not opened through the form).
 */
export function issueMessage(
  issue: { readonly title: string; readonly body: string },
  form: Map<string, string> = parseIssueForm(issue.body),
): string {
  const text = form.has(FORM_MERCHANT_HEADING) ? (form.get(FORM_MESSAGE_HEADING) ?? '') : issue.body;
  return [issue.title.trim(), text.trim()].filter((part) => part !== '').join('\n\n');
}

// ---------------------------------------------------------------------------------------------
// Human commands
// ---------------------------------------------------------------------------------------------

export type HumanCommand =
  | { readonly kind: 'coach'; readonly scope: 'customer' | 'product'; readonly text: string }
  | { readonly kind: 'clock'; readonly target: string }
  | { readonly kind: 'consolidate' }
  | { readonly kind: 'invalid'; readonly command: string; readonly reason: string };

const COMMAND = /^\/(coach|clock|consolidate)\b([\s\S]*)$/u;

/**
 * `/coach [product] <text>`, `/clock <ISO>` and `/consolidate` at the start of a human's
 * comment; anything else, unknown slash words included, is a plain human reply (undefined).
 * A known command with a bad argument comes back as `invalid` so the loop can say why.
 */
export function parseCommand(body: string): HumanCommand | undefined {
  const match = COMMAND.exec(body.trim());
  if (match?.[1] === undefined) return undefined;
  const command = match[1];
  const rest = (match[2] ?? '').trim();
  switch (command) {
    case 'coach': {
      const scoped = /^product\b([\s\S]*)$/u.exec(rest);
      const text = (scoped === null ? rest : (scoped[1] ?? '')).trim();
      if (text === '') return { kind: 'invalid', command, reason: 'the note text is missing' };
      return { kind: 'coach', scope: scoped === null ? 'customer' : 'product', text };
    }
    case 'clock': {
      const target = rest.split(/\s+/u)[0] ?? '';
      if (target === '' || !Number.isFinite(Date.parse(target))) {
        return { kind: 'invalid', command, reason: `expected an ISO timestamp, got "${rest}"` };
      }
      return { kind: 'clock', target };
    }
    case 'consolidate':
      if (rest !== '') return { kind: 'invalid', command, reason: 'takes no arguments' };
      return { kind: 'consolidate' };
    default:
      return undefined;
  }
}
