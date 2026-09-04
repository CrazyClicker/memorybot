import { describe, expect, it } from 'vitest';

import { dateStatement } from './engine.ts';

const NOW = '2026-09-16T10:10:00Z';

describe('dateStatement', () => {
  it('prefixes an undated statement with the scenario date', () => {
    expect(dateStatement('  Личный факт.  ', NOW)).toBe('По состоянию на 2026-09-16: Личный факт.');
  });

  it('keeps a canonical prefix the writer supplied, with the writer\'s date', () => {
    expect(dateStatement('По состоянию на 2026-09-01: Личный факт.', NOW)).toBe(
      'По состоянию на 2026-09-01: Личный факт.',
    );
  });

  it('normalises a writer prefix without the colon instead of dating the statement twice', () => {
    expect(
      dateStatement('По состоянию на 2026-09-16 интегратор автоматизирует выгрузку.', NOW),
    ).toBe('По состоянию на 2026-09-16: интегратор автоматизирует выгрузку.');
    expect(dateStatement('По состоянию на 2026-09-05T13:20:00Z: сбой у «Оплатим».', NOW)).toBe(
      'По состоянию на 2026-09-05: сбой у «Оплатим».',
    );
  });
});
