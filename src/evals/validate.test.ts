import { describe, expect, it } from 'vitest';

import { type Issue, parseConfig, parseScenario, type ValidationContext } from './validate.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = any;

/**
 * A scenario that exercises every rule and produces no issue: two customers, a shared
 * temporal item, a customer-scoped product item promoted into the wiki, isolation checks.
 */
function fixture(): Loose {
  return structuredClone({
    id: 'fixture',
    title: 'Fixture',
    tags: ['memory:personal'],
    world: {
      knowledge_base: 'wiki',
      clock: '2026-09-01T09:00:00Z',
      customers: { alfa: { name: 'Альфа' }, beta: { name: 'Бета' } },
    },
    knowledge: {
      K1: { kind: 'personal', about: 'alfa', statement: 'Факт про Альфу.', source: ['a1-open'] },
      K2: {
        kind: 'temporal',
        about: 'product',
        scope: 'shared',
        statement: 'Сбой до вечера.',
        valid_until: '2026-09-01T18:00:00Z',
        source: ['a1-note'],
      },
      K3: {
        kind: 'undocumented',
        about: 'product',
        documentation_candidate: true,
        statement: 'Продуктовый факт.',
        source: ['a1-note'],
      },
    },
    steps: [
      { id: 'a1-open', type: 'customer_message', thread: 'tkt_alfa_1', customer: 'alfa', at: '2026-09-01T09:00:00Z', content: 'Вопрос.' },
      {
        id: 'a1-agent',
        type: 'agent_turn',
        thread: 'tkt_alfa_1',
        expect: { outcome: 'escalate', tolerated: ['ask'], escalation: { reason_must: ['/P-00\\d/'] }, reply: { must_not: ['/бета/i'] } },
      },
      { id: 'a1-note', type: 'coach_note', thread: 'tkt_alfa_1', author: 'eng.oleg', at: '2026-09-01T10:00:00Z', scope: 'product', content: 'Заметка.' },
      { id: 'a1-reply', type: 'human_reply', thread: 'tkt_alfa_1', author: 'eng.oleg', at: '2026-09-01T10:05:00Z', content: 'Ответ.' },
      { id: 'a1-close', type: 'close_ticket', thread: 'tkt_alfa_1', at: '2026-09-01T11:00:00Z' },
      { id: 'consolidate-1', type: 'consolidate', at: '2026-09-01T12:00:00Z' },
      { id: 'b1-open', type: 'customer_message', thread: 'tkt_beta_1', customer: 'beta', at: '2026-09-01T13:00:00Z', content: 'Вопрос Беты.' },
      { id: 'b1-agent', type: 'agent_turn', thread: 'tkt_beta_1', expect: { outcome: 'answer', uses: ['K2'], must_not_use: ['K1'] } },
      { id: 'wiki-1', type: 'wiki_update', page: 'import-eksport-csv', knowledge: ['K3'], at: '2026-09-01T14:00:00Z' },
      { id: 'b2-open', type: 'customer_message', thread: 'tkt_beta_2', customer: 'beta', at: '2026-09-02T09:00:00Z', content: 'Ещё вопрос.' },
      { id: 'b2-agent', type: 'agent_turn', thread: 'tkt_beta_2', expect: { outcome: 'answer', uses: ['K3'], must_not_use: ['K2'], reply: { must: ['BOM'] } } },
      { id: 'a2-open', type: 'customer_message', thread: 'tkt_alfa_2', customer: 'alfa', at: '2026-09-02T10:00:00Z', content: 'Снова Альфа.' },
      { id: 'a2-agent', type: 'agent_turn', thread: 'tkt_alfa_2', expect: { outcome: 'answer', uses: ['K1'] } },
    ],
    probes: [
      { id: 'recall-alfa', type: 'memory_recall', customer: 'alfa', query: 'Альфа', expect: { recalls: ['K1', 'K2'] } },
      { id: 'isolation-beta', type: 'memory_recall', customer: 'beta', query: 'Альфа', expect: { must_not_recall: ['K1'], must_not: ['/альфа/i'] } },
      { id: 'proposals', type: 'documentation_proposals', expect: { proposes: ['K3'] } },
    ],
  });
}

const CTX: ValidationContext = { wikiSlugs: new Set(['import-eksport-csv']), fileStem: 'fixture' };

function issuesFor(mutate: (scenario: Loose) => void, ctx: ValidationContext = CTX): readonly Issue[] {
  const scenario = fixture();
  mutate(scenario);
  return parseScenario(scenario, ctx).issues;
}

function errorsFor(mutate: (scenario: Loose) => void, ctx?: ValidationContext): readonly Issue[] {
  return issuesFor(mutate, ctx).filter((issue) => issue.severity === 'error');
}

function expectOnly(issues: readonly Issue[], path: string, message: RegExp): void {
  expect(issues.map((issue) => `${issue.path}: ${issue.message}`)).toHaveLength(1);
  expect(issues[0]?.path).toBe(path);
  expect(issues[0]?.message).toMatch(message);
}

describe('validateScenario', () => {
  it('accepts the fixture without a single issue', () => {
    expect(issuesFor(() => {})).toEqual([]);
  });

  it('keeps the parsed value alongside semantic errors', () => {
    const scenario = fixture();
    scenario.id = 'other';
    const parsed = parseScenario(scenario, CTX);
    expect(parsed.value?.id).toBe('other');
    expectOnly(parsed.issues, 'id', /does not match the file name "fixture"/);
  });

  it('reports shape errors with a document path', () => {
    const issues = errorsFor((s) => {
      s.steps[0].at = 'yesterday';
    });
    expectOnly(issues, 'steps[0].at', /ISO datetime/);
  });

  it('rejects duplicate step ids', () => {
    expectOnly(errorsFor((s) => { s.steps[5].id = 'a1-open'; }), 'steps[5].id', /duplicate step id "a1-open", first used at steps\[0\]/);
  });

  it('rejects a clock that goes backwards, including before world.clock', () => {
    expectOnly(errorsFor((s) => { s.steps[3].at = '2026-09-01T09:30:00Z'; }), 'steps[3].at', /earlier than steps\[2\]\.at \(2026-09-01T10:00:00Z\)/);
    expectOnly(errorsFor((s) => { s.steps[0].at = '2026-08-31T09:00:00Z'; }), 'steps[0].at', /earlier than world\.clock/);
  });

  it('rejects an unknown customer on a message and on a probe', () => {
    expect(errorsFor((s) => { s.steps[0].customer = 'gamma'; }).map((i) => i.path)).toContain('steps[0].customer');
    expectOnly(errorsFor((s) => { s.probes[0].customer = 'gamma'; }), 'probes[0].customer', /unknown customer "gamma"/);
  });

  it('binds a thread to the customer who opened it', () => {
    expectOnly(
      errorsFor((s) => {
        s.steps[9].thread = 'tkt_beta_1';
        s.steps[9].customer = 'alfa';
        s.steps[10].thread = 'tkt_beta_1';
      }),
      'steps[9].customer',
      /belongs to "beta", not "alfa"/,
    );
  });

  it('rejects an agent turn, reply or close on a thread nobody opened', () => {
    expectOnly(errorsFor((s) => { s.steps[1].thread = 'tkt_nobody'; }), 'steps[1].thread', /no customer_message has opened thread "tkt_nobody"/);
    expectOnly(errorsFor((s) => { s.steps[4].thread = 'tkt_nobody'; }), 'steps[4].thread', /no customer_message has opened/);
  });

  it('rejects customer-facing steps after close_ticket and a double close', () => {
    expectOnly(
      errorsFor((s) => {
        s.steps.splice(5, 0, {
          id: 'a1-message-after-close',
          type: 'customer_message',
          thread: 'tkt_alfa_1',
          customer: 'alfa',
          at: '2026-09-01T11:30:00Z',
          content: 'Новое сообщение в закрытом треде.',
        });
      }),
      'steps[5].thread',
      /was closed at steps\[4\]/,
    );
    expectOnly(errorsFor((s) => { s.steps.splice(5, 0, { id: 'a1-close-2', type: 'close_ticket', thread: 'tkt_alfa_1', at: '2026-09-01T11:30:00Z' }); }), 'steps[5].thread', /was closed at steps\[4\]/);
  });

  it('allows a coach note after the close', () => {
    expect(errorsFor((s) => { s.steps.splice(5, 0, { id: 'a1-late-note', type: 'coach_note', thread: 'tkt_alfa_1', author: 'eng.oleg', at: '2026-09-01T11:30:00Z', content: 'Поздняя заметка.' }); })).toEqual([]);
  });

  it('rejects an agent turn with nothing pending', () => {
    expectOnly(errorsFor((s) => { s.steps.splice(2, 0, { id: 'a1-agent-2', type: 'agent_turn', thread: 'tkt_alfa_1' }); }), 'steps[2]', /nothing is pending/);
    expectOnly(errorsFor((s) => { s.steps.splice(4, 0, { id: 'a1-agent-2', type: 'agent_turn', thread: 'tkt_alfa_1' }); }), 'steps[4]', /nothing is pending/);
  });

  it('rejects unknown knowledge ids wherever they are referenced', () => {
    expectOnly(errorsFor((s) => { s.steps[12].expect.uses = ['K9']; }), 'steps[12].expect.uses[0]', /unknown knowledge item K9; declared: "K1", "K2", "K3"/);
    expectOnly(errorsFor((s) => { s.steps[8].knowledge = ['K3', 'K9']; }), 'steps[8].knowledge[1]', /unknown knowledge item K9/);
    expectOnly(errorsFor((s) => { s.probes[1].expect.must_not_recall = ['K9']; }), 'probes[1].expect.must_not_recall[0]', /unknown knowledge item K9/);
    expectOnly(errorsFor((s) => { s.probes[2].expect.proposes = ['K9']; }), 'probes[2].expect.proposes[0]', /unknown knowledge item K9/);
  });

  it('rejects the same item in uses and must_not_use, or recalls and must_not_recall', () => {
    expectOnly(errorsFor((s) => { s.steps[12].expect.must_not_use = ['K1']; }), 'steps[12].expect.uses', /K1 is in both uses and must_not_use/);
    expectOnly(errorsFor((s) => { s.probes[0].expect.must_not_recall = ['K2']; }), 'probes[0].expect.recalls', /K2 is in both recalls and must_not_recall/);
  });

  it('checks tolerated against outcome', () => {
    expectOnly(errorsFor((s) => { delete s.steps[1].expect.outcome; }), 'steps[1].expect.tolerated', /needs an outcome/);
    expectOnly(errorsFor((s) => { s.steps[1].expect.tolerated = ['escalate']; }), 'steps[1].expect.tolerated', /"escalate" is the expected outcome/);
  });

  it('checks knowledge.about and knowledge.source', () => {
    expectOnly(errorsFor((s) => { s.knowledge.K1.about = 'gamma'; }), 'knowledge.K1.about', /neither a customer nor "product"/);
    expectOnly(errorsFor((s) => { s.knowledge.K1.source = ['nope']; }), 'knowledge.K1.source[0]', /unknown step "nope"/);
    expectOnly(errorsFor((s) => { s.knowledge.K1.source = ['a1-agent']; }), 'knowledge.K1.source[0]', /"a1-agent" is a agent_turn; knowledge comes from/);
  });

  it('requires valid_until on temporal items and forbids it elsewhere', () => {
    expect(errorsFor((s) => { delete s.knowledge.K2.valid_until; }).map((i) => i.path)).toEqual(['knowledge.K2.valid_until']);
    expectOnly(errorsFor((s) => { s.knowledge.K1.valid_until = '2026-09-10'; }), 'knowledge.K1.valid_until', /only temporal knowledge has valid_until \(this item is personal\)/);
  });

  it('allows documentation_candidate only on undocumented items', () => {
    expectOnly(errorsFor((s) => { s.knowledge.K1.documentation_candidate = true; }), 'knowledge.K1.documentation_candidate', /only undocumented knowledge/);
  });

  it('requires shared knowledge to come from a product-scoped coach note', () => {
    expectOnly(errorsFor((s) => { s.steps[2].scope = 'customer'; }), 'knowledge.K2.scope', /shared knowledge comes only from a coach_note with scope: product/);
    expectOnly(errorsFor((s) => { s.knowledge.K2.source = ['a1-reply']; }), 'knowledge.K2.scope', /none of its source steps is one/);
  });

  it('checks wiki_update against the wiki and the knowledge base', () => {
    expectOnly(errorsFor((s) => { s.steps[8].page = 'nope'; }), 'steps[8].page', /no wiki page "nope"; pages: "import-eksport-csv"/);
    expect(errorsFor((s) => { s.steps[8].page = 'nope'; }, { fileStem: 'fixture' })).toEqual([]);
    expectOnly(errorsFor((s) => { s.world.knowledge_base = 'none'; }), 'steps[8]', /needs world\.knowledge_base: wiki/);
  });

  it('rejects uses before the item is learned', () => {
    expectOnly(errorsFor((s) => { s.steps[1].expect.uses = ['K3']; }), 'steps[1].expect.uses', /uses K3 before it is learned; its first source is steps\[2\] \("a1-note"\)/);
  });

  it('enforces isolation: customer-scoped knowledge reaches another customer only through the wiki', () => {
    expectOnly(errorsFor((s) => { s.steps[7].expect.uses = ['K1', 'K2']; s.steps[7].expect.must_not_use = []; }), 'steps[7].expect.uses', /K1 is customer-scoped knowledge learned from "alfa"; "beta"'s thread can use it only after a wiki_update/);
    expectOnly(errorsFor((s) => { s.steps[7].expect.uses = ['K3']; }), 'steps[7].expect.uses', /K3 is customer-scoped/);
    expect(errorsFor((s) => { s.steps[10].expect.uses = ['K3']; })).toEqual([]);
    expectOnly(errorsFor((s) => { s.probes[1].expect.recalls = ['K1']; s.probes[1].expect.must_not_recall = []; }), 'probes[1].expect.recalls', /recall for "beta" never returns it/);
  });

  it('rejects a probe that expects nothing and proposes only documentation candidates', () => {
    expectOnly(errorsFor((s) => { s.probes[2].expect = {}; }), 'probes[2].expect', /expects nothing/);
    expectOnly(errorsFor((s) => { s.probes[2].expect.proposes = ['K1']; }), 'probes[2].expect.proposes', /K1 is not a documentation_candidate/);
  });

  it('rejects duplicate probe ids', () => {
    expectOnly(errorsFor((s) => { s.probes[1].id = 'recall-alfa'; }), 'probes[1].id', /duplicate probe id/);
  });

  it('warns about knowledge nothing tests', () => {
    const issues = issuesFor((s) => { s.knowledge.K4 = { kind: 'personal', about: 'beta', statement: 'Лишний факт.', source: ['b1-open'] }; });
    expectOnly(issues, 'knowledge.K4', /K4 is declared, but no uses/);
    expect(issues[0]?.severity).toBe('warning');
  });

  it('warns about a temporal item never checked after its valid_until', () => {
    const issues = issuesFor((s) => { s.steps[10].expect.must_not_use = []; });
    expectOnly(issues, 'knowledge.K2', /no agent_turn after valid_until \(2026-09-01T18:00:00Z\) has must_not_use: \[K2\]/);
    expect(issues[0]?.severity).toBe('warning');
  });
});

describe('validateConfig', () => {
  const config = {
    id: 'notes',
    agent: { provider: 'openai', model: 'gpt-4o-mini', temperature: 0 },
    memory: { engine: 'notes', read: 'hydrate', write: 'consolidate' },
    judge: { provider: 'anthropic', model: 'claude-sonnet-5' },
  };

  it('accepts a config whose id matches the file', () => {
    expect(parseConfig(config, { fileStem: 'notes' }).issues).toEqual([]);
  });

  it('rejects an id that does not match the file name', () => {
    expectOnly(parseConfig(config, { fileStem: 'notes-agent' }).issues, 'id', /does not match the file name "notes-agent"/);
  });

  it('warns about a model without a price and a judge from the same vendor', () => {
    const issues = parseConfig({ ...config, judge: { provider: 'openai', model: 'gpt-9-imaginary' } }, { fileStem: 'notes' }).issues;
    expect(issues.map((issue) => `${issue.severity} ${issue.path}`)).toEqual(['warning judge.model', 'warning judge.provider']);
  });

  it('reports shape errors with a path', () => {
    const issues = parseConfig({ ...config, memory: { engine: 'notes', read: 'hydrate' } }).issues;
    expect(issues.map((issue) => issue.path)).toEqual(['memory.write']);
  });
});
