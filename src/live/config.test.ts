import { describe, expect, it } from 'vitest';

import {
  customerByForm,
  customerByLogin,
  DEFAULT_POLL_SECONDS,
  isHuman,
  loadLiveConfig,
  parseLiveConfig,
  sessionCustomers,
} from './config.ts';
import { DEFAULT_SESSION_CONFIG } from './session.ts';

const MINIMAL = {
  repo: 'CrazyClicker/memorybot',
  humans: ['CrazyClicker'],
  customers: {
    dom_i_sad: { form: 'Дом и сад', name: 'Дом и сад', profile: 'Магазин товаров для дома.' },
    velo_dvor: { form: 'ВелоДвор', name: 'ВелоДвор', logins: ['velo-dvor'] },
  },
};

describe('live config', () => {
  it('loads the committed live/config.yaml', async () => {
    const config = await loadLiveConfig();
    expect(config.repo).toBe('CrazyClicker/memorybot');
    expect(config.humans).toContain('CrazyClicker');
    expect(Object.keys(config.customers).sort()).toEqual(['dom_i_sad', 'kofe_tochka', 'lavanda', 'velo_dvor']);
    expect(config.labels.support).toBe('support');
    expect(config.labels.escalated).toBe('escalated');
    expect(config.config).toBe(DEFAULT_SESSION_CONFIG);
    expect(config.memory_issue).toBe(1);
  });

  it('fills the defaults and validates the shape', () => {
    const config = parseLiveConfig(MINIMAL);
    expect(config.poll_seconds).toBe(DEFAULT_POLL_SECONDS);
    expect(config.config).toBe(DEFAULT_SESSION_CONFIG);
    expect(config.labels).toEqual({
      support: 'support',
      answered: 'agent:answered',
      asked: 'agent:asked',
      escalated: 'escalated',
      failed: 'agent:failed',
      proposal: 'proposal',
    });
    expect(config.customers['dom_i_sad']?.logins).toEqual([]);

    expect(() => parseLiveConfig({ ...MINIMAL, repo: 'memorybot' })).toThrow(/owner\/name/);
    expect(() => parseLiveConfig({ ...MINIMAL, humans: [] })).toThrow(/humans/);
    expect(() => parseLiveConfig({ ...MINIMAL, extra: 1 })).toThrow(/extra/);
    expect(() => parseLiveConfig({ ...MINIMAL, customers: { 'Bad Id': MINIMAL.customers.dom_i_sad } })).toThrow(
      /customer ids/,
    );
  });

  it('rejects form values and logins that point two ways', () => {
    const sameForm = {
      ...MINIMAL,
      customers: { ...MINIMAL.customers, lavanda: { form: 'дом и сад', name: 'Лаванда' } },
    };
    expect(() => parseLiveConfig(sameForm)).toThrow(/already used by "dom_i_sad"/);

    const sameLogin = {
      ...MINIMAL,
      customers: { ...MINIMAL.customers, lavanda: { form: 'Лаванда', name: 'Лаванда', logins: ['Velo-Dvor'] } },
    };
    expect(() => parseLiveConfig(sameLogin)).toThrow(/already mapped to "velo_dvor"/);

    const humanLogin = {
      ...MINIMAL,
      customers: { ...MINIMAL.customers, lavanda: { form: 'Лаванда', name: 'Лаванда', logins: ['crazyclicker'] } },
    };
    expect(() => parseLiveConfig(humanLogin)).toThrow(/listed under humans/);
  });

  it('maps forms, logins and humans case-insensitively and builds the session customers', () => {
    const config = parseLiveConfig(MINIMAL);
    expect(customerByForm(config, ' дом и сад ')).toBe('dom_i_sad');
    expect(customerByForm(config, 'Лаванда')).toBeUndefined();
    expect(customerByForm(config, '')).toBeUndefined();
    expect(customerByLogin(config, 'Velo-Dvor')).toBe('velo_dvor');
    expect(customerByLogin(config, 'nobody')).toBeUndefined();
    expect(isHuman(config, 'crazyclicker')).toBe(true);
    expect(isHuman(config, 'velo-dvor')).toBe(false);
    expect(sessionCustomers(config)).toEqual({
      dom_i_sad: { name: 'Дом и сад', profile: 'Магазин товаров для дома.' },
      velo_dvor: { name: 'ВелоДвор' },
    });
  });
});
