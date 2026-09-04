import { Buffer } from 'node:buffer';

/** Words too common in Russian support prose to carry a fact; short tokens are dropped too. */
const STOPWORDS = new Set([
  'который', 'которая', 'которые', 'этого', 'этот', 'эта', 'это', 'если', 'чтобы', 'также',
  'может', 'можно', 'нужно', 'после', 'перед', 'через', 'когда', 'пока', 'ещё', 'еще',
  'всё', 'все', 'весь', 'быть', 'была', 'было', 'были', 'есть',
  'состоянию', 'состояние', 'клиент', 'клиента', 'магазин', 'магазина',
  'that', 'this', 'with', 'from', 'have', 'been', 'they', 'their', 'about', 'because',
]);

const DATE_PREFIX = /^По состоянию на \d{4}-\d{2}-\d{2}:\s*/u;

/**
 * Crude Russian stemming shared by recall, deduplication and report attribution. Tokens with a
 * digit stay whole because dates, order numbers and article numbers are highly discriminating.
 */
export function stem(token: string): string {
  return /\d/.test(token) ? token : token.slice(0, 5);
}

/** Content words of a statement, stemmed and deduplicated. The write date is not content. */
export function factTokens(text: string): Set<string> {
  const tokens = text
    .replace(DATE_PREFIX, '')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== '' && !STOPWORDS.has(token) && (token.length >= 4 || /\d/.test(token)));
  return new Set(tokens.map(stem));
}

/** Dependency-free conservative token estimate used to enforce hard recall budgets. */
export function estimateTokens(text: string): number {
  return text === '' ? 0 : Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

export function tokenOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap;
}

export function jaccardSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  const overlap = tokenOverlap(left, right);
  return overlap / (left.size + right.size - overlap);
}
