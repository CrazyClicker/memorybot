# ROADMAP — support agent with learning memory (restart)

**Status:** in progress. Decisions confirmed on 2026-09-03. Done so far: T0.1 (repo skeleton), T0.2 (`src/llm`), T0.3 (eval format v2), T1.1–T1.5 (wiki, `wiki/README.md`, scenarios 1–3).

## 0. Goal and milestones

A support agent receives a customer message, reads the wiki, checks its memory and either
answers or escalates to a human. The human replies to the customer and may leave a
**coach note** for the agent. Over this loop the agent learns from three sources:

1. facts stated in customer messages (personal setup, constraints),
2. human replies on escalated tickets,
3. coach notes attached to escalated tickets.

Evals come first. The dev UI reuses the eval machinery instead of a separate runtime.

| Milestone | Definition of done |
|---|---|
| **M1 — Evals report** | `pnpm eval run --all` executes every scenario against a config matrix and writes `evals/results/REPORT.md` comparing memory engines: `none`, `naive`, `notes` (ours), `mem0`, `xmemory`, under both memory write paths. |
| **M2 — Dev UI** | A local web UI: chat as a customer, watch the agent's trace (wiki reads, memory recalls, memory writes, outcome), act as the human on escalations (reply + coach note), inspect memory and documentation proposals, accept a proposal into the wiki, advance the clock, and replay any scenario step by step. |

## 1. Principles for the restart

1. **Evals are the first consumer.** No queue, no poll loop, no messages table in M1. The agent is a pure function `runTurn(input) -> TurnResult` and the scenario is the only state.
2. **Two write paths, both first-class, selected by config.** `write: agent` — the agent calls a `remember` tool during the turn. `write: consolidate` — the engine extracts from the transcript at `consolidate` steps. `both` runs both. Every memory write is recorded with its source so the report can say which path learned a fact.
3. **The engine's note schema is the eval's knowledge schema.** `kind / about / statement / valid_until / source` are the same words in the scenario, in the `notes` engine, in the `remember` tool and in the judge prompt.
4. **Everything learned on a customer's ticket belongs to that customer, unless a human broadcasts it.** Product facts reach other customers in two ways only: a human accepts a documentation proposal into the wiki (`wiki_update` step), or a human marks a coach note `scope: product`, which stores the fact as `scope: shared` so every customer's recall sees it (incidents, platform-wide temporary conditions). The agent never promotes on its own. No shared-knowledge layer, no `by_config`.
5. **Every write is dated with the scenario clock** ("По состоянию на 2026-08-27: …"). Hosted engines stamp wall-clock time, so the date must live in the text.
6. **Anything an engine cannot serve is `skipped`, never `fail`.**
7. **Cheap first.** Deterministic checks before judge calls. Small model for the agent, a stronger model for the judge. Temperature 0.
8. **Content in Russian, development in English.** Wiki pages, customer messages, human replies, coach notes and knowledge statements are Russian. Ids, keys, rubrics, code, docs and reports are English.

## 2. Decisions (confirmed)

| # | Decision | Value |
|---|---|---|
| D1 | Domain | E-commerce platform for small merchants: **«Прилавок»**. Fictional integrations: «Оплатим» (payments), «Курьерика» (delivery), «Чек-Онлайн» (receipts). Names, customers and the wiki page list live in `DOMAIN.md`. |
| D2 | Runtime | Node 22+, TypeScript via `tsx`, pnpm. |
| D3 | LLM/agent layer | Vercel AI SDK 7: `ai@7`, `@ai-sdk/openai@4`, `@ai-sdk/anthropic@4` (judge). v7 renamed most of what older examples show — use `instructions` (not `system`), `isStepCount` (not `stepCountIs`), `generateText({output: Output.object({schema})})` (not `generateObject`, deprecated in v6), `onEnd`/`onStepEnd` (not `onFinish`/`onStepFinish`), `usage.inputTokenDetails.cacheReadTokens` (not `usage.cachedInputTokens`). `result.usage` and `result.toolCalls` total **all** steps; the last step is `result.finalStep`. Tools take `inputSchema` and no `name` (the key in `tools` is the name). The deprecated v5/v6 spellings still compile, so `tsc` will not catch them. |
| D4 | Learning signal | `coach_note` step. `internal_discussion` is out of v1. |
| D5 | Outcome signalling | The agent ends every turn by calling a `finish` tool with `{outcome: answer\|ask\|escalate, reply, escalation_reason?}`. `outcome` is deterministic; the judge scores only content. |
| D6 | Wiki access | Page index (slug, title, summary) in the system prompt plus a `read_page(slug)` tool. Optional `search_wiki` via MiniSearch. |
| D7 | Cross-customer facts | Durable product facts: through the wiki via a `wiki_update` step. Time-sensitive platform-wide facts (an outage, a delayed payout run): a coach note with `scope: product` becomes a memory item with `scope: shared`. Both gates are human; the agent's `remember` tool is always `scope: customer`. |
| D8 | Language | Content Russian, development English. The judge is told the text may be in either language. |
| D9 | Models | Agent: OpenAI, `gpt-4o-mini` as in the v1 README or the current mini model, pinned in the config. Judge: a stronger model, preferably another vendor (`claude-sonnet-5`) to avoid self-preference; otherwise the strongest OpenAI model available. mem0 uses the OpenAI key for its LLM and embeddings. |
| D10 | Memory read/write axes | `memory.read: hydrate \| tool \| both`, `memory.write: consolidate \| agent \| both`. Full matrix runs `write: consolidate` first, then `both`. |

## 3. Target repository layout

```
src/
  llm/         provider registry, model catalogue with prices, usage -> USD, optional disk cache
  wiki/        loader (frontmatter: slug, title, summary), tools: read_page, search_wiki; update(page, text)
  agent/       runTurn(), system prompt, tools: finish, remember, recall_memory
  memory/      engine.ts (interface), none.ts, naive.ts, notes.ts, mem0.ts, xmemory.ts
  evals/       schema.ts (zod), runner.ts, checks.ts, judge.ts, report.ts, cli.ts
  ui/          M2: server (Hono) + client (Vite + React)
evals/
  README.md    format v2 (see §7)
  scenarios/   *.yaml
  configs/     *.yaml
  results/     git-ignored
wiki/
  README.md    the list of facts deliberately absent from the wiki
  *.md         Russian
DOMAIN.md      names, integrations, customers, wiki page list
.env.example
```

## 4. Core interfaces (write these first; everything plugs into them)

```ts
// src/memory/engine.ts
export type Kind = 'personal' | 'temporal' | 'undocumented' | 'other';

export interface MemoryItem {
  id: string;
  kind: Kind;
  about: string;            // customer id or 'product'
  learnedFrom: string;      // customer id whose thread produced it; recall scope (principle 4)
  scope: 'customer' | 'shared';  // shared only from a coach note with scope: product
  statement: string;        // Russian, starts with the scenario date
  validUntil?: string;      // ISO date, temporal only
  documentationCandidate?: boolean;
  source: { thread: string; step?: string; via: 'agent' | 'consolidate' };
  createdAt: string;        // scenario clock, not wall clock
}

export interface ThreadEvent {
  type: 'customer_message' | 'agent_reply' | 'human_reply' | 'coach_note';
  at: string;
  author?: string;
  content: string;
}

export interface ThreadTranscript {
  id: string;
  customer: string;
  events: ThreadEvent[];
  closedAt?: string;
}

export interface MemoryEngine {
  id: string;
  reset(): Promise<void>;                                                     // fresh state per run
  recall(customer: string, query: string, now: string): Promise<MemoryItem[]>; // items with scope==shared, about==customer or learnedFrom==customer
  write(items: MemoryItem[], now: string): Promise<void>;                     // explicit items (agent `remember` tool)
  consolidate(thread: ThreadTranscript, now: string): Promise<MemoryItem[]>;  // engine-driven extraction; returns what it wrote, [] if opaque
  proposals?(): Promise<MemoryItem[]>;                                        // documentation candidates, customer names stripped
}
```

Engine mapping of the two write paths:

| engine | `write(items)` | `consolidate(thread)` | `recall` | `proposals` |
|---|---|---|---|---|
| none | no-op | no-op | [] | – |
| naive | append statement text to the customer's log | append the whole transcript | the customer's log, newest first, token-capped | – |
| notes | insert rows | one structured-output LLM call → rows, dedup by similarity | rows with `scope=shared` or `about`/`learnedFrom` = customer, expired temporal rows flagged, keyword-ranked | product rows with `documentationCandidate` |
| mem0 | `add(statement, {userId: learnedFrom})`; shared items under `userId: '_shared'` | `add(messages, {userId})` | `search(query, {userId})` merged with `search(query, {userId: '_shared'})` | – (skipped) |
| xmemory | natural-language write, scoped to the customer or to the shared scope | write of the transcript | natural-language read over the customer scope plus the shared scope | – unless the schema supports it |

```ts
// src/agent/runTurn.ts
export interface TurnInput {
  now: string;
  customer: { id: string; name: string; profile?: string };     // the CRM record the platform attaches
  thread: ThreadTranscript;                                      // includes the pending customer message(s)
  memory: MemoryItem[];                                          // hydrated by the runner via engine.recall (read: hydrate|both)
  tools: { recallMemory: boolean; remember: boolean };           // from memory.read / memory.write
  wiki: Wiki;
  model: ModelRef;
}

export interface TurnResult {
  outcome: 'answer' | 'ask' | 'escalate';
  reply: string;                                                 // customer-facing, Russian
  escalationReason?: string;                                     // internal
  memoryWrites: MemoryItem[];                                    // via the remember tool
  trace: TraceStep[];                                            // tool calls with args and results, model text, usage per step
  usage: { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number };
}
```

```yaml
# evals/configs/notes-consolidate.yaml
id: notes-consolidate
agent:  { provider: openai, model: gpt-4o-mini, temperature: 0 }
memory: { engine: notes, read: hydrate, write: consolidate }   # engine: none | naive | notes | mem0 | xmemory
judge:  { provider: anthropic, model: claude-sonnet-5 }
```

## 5. Milestone 1 — task list

Sizes: **S** ≤ 2 h, **M** half a day, **L** a day. Track A (code) and Track B (content) run in
parallel and meet at T2.8.

### T0 — Setup (Track A)

- [x] **T0.1 (S)** Repo skeleton: pnpm, TypeScript strict, `tsx`, vitest, `.env.example` with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (judge, optional), `XMEMORY_API_KEY`. Scripts: `pnpm eval validate|run|report|lint-wiki`, `pnpm test`.
- [x] **T0.2 (S)** `src/llm`: provider registry over AI SDK, `ModelRef = {provider, model}`, price table → `costUsd`. Optional disk cache keyed by hash(model, messages, tools) behind `LLM_CACHE=1` for cheap re-runs while developing checks.
- [x] **T0.3 (S)** Rewrite `evals/README.md` as format v2 from §7. *Done when:* no references to DAL, queue, hydrator, summarizer, M5/M8, `by_config`, `shared_knowledge`.

### T1 — Domain content (Track B)

- [x] **T1.1 (M)** Write the wiki in Russian (11 pages, ≈2 700 words, leak grep clean): 10–15 pages with frontmatter `slug`, `title`, `summary`. Suggested pages: начало работы; платежи и выплаты; доставка и зоны; налоги и чеки; импорт и экспорт товаров CSV; домены и SSL; заказы и возвраты; скидки и промокоды; интеграции (вебхуки, API-ключи); тарифы и оплата; правила поддержки: когда эскалировать (платежи, юридические вопросы, потеря данных, безопасность всегда эскалируются).
- [x] **T1.2 (S)** `wiki/README.md`: facts deliberately absent from the wiki = every K item of every scenario. Update it whenever a scenario is added.
- [x] **T1.3 (M)** Scenario 1 `csv-import-dropped-rows.yaml` (written). Thread A: escalate (P-002), merchant follow-up with K1, coach note + human reply with K2 and K3 → consolidate → thread B before `valid_until` (`uses: [K3]`) → thread C after (`uses: [K1, K2]`, `must_not_use: [K3]`) → thread D, another merchant (escalate, isolation) → `wiki_update` with K2 → thread D2 (`answer`, `uses: [K2]`) → 3 probes.
- [x] **T1.4 (S)** Scenario 2 `setup-from-the-question.yaml` (written): learning source 1 only. «Кофе-точка» asks a delivery-zone question the wiki answers and states its setup on the way: K1 two-stage payments because coffee is roasted to order (background), K2 delivery only within Томская область (the subject) → `answer`, no escalation → consolidate → thread B "can the order wait two weeks?" needs K1 (`answer`, `uses: [K1]`, rubric: does not ask which payment mode) → thread C "buyer from Novosibirsk cannot order" needs K2 → thread D, «Лаванда» asks B's question (`must_not_use: [K1, K2]`) → 3 probes. Separates the write paths: `write: agent` must catch K1/K2 in-turn with no coach note to lean on, `write: consolidate` must extract them from a two-message transcript.
- [x] **T1.5 (S)** Scenario 3 `payment-provider-incident.yaml` (written): the **shared temporal** case. «Кофе-точка» reports card payments failing → escalate (P-001). Human reply + two coach notes: `scope: product` with the incident (K1 temporal, shared: «Оплатим» не проводит карты с 12:00 5 сентября, восстановление к 18:00, QR работает) and `scope: customer` with the reporter's orders and the open double-charge case (K2 personal). Consolidate at 14:00. «Лаванда» asks at 15:00 → `answer`, `uses: [K1]`, `must_not_use: [K2]`, no new escalation (P-007). «Лаванда» asks on 7 September → `must_not_use: [K1]`, rubric "treats it as resolved". «Кофе-точка» chases order 1153 on 7 September without naming it → `escalate`, `uses: [K2]`, `must_not_use: [K1]`. Probes: recall for «Лаванда» returns K1 and not K2, recall for «Кофе-точка» returns both, no documentation candidates.
- [ ] **T1.6 (S)** Wiki leak lint (`pnpm eval lint-wiki`): run every scenario with engine `none`; every `uses:` must fail, except checks after a `wiki_update` that promoted the item. A passing `uses` means the fact is in the wiki; remove it from the wiki, not from the scenario. Run after every wiki edit.

### T2 — Runner core (Track A)

- [ ] **T2.1 (M)** `src/evals/schema.ts`: zod schemas for scenario, config, results. Validation: monotonic `at`, K references exist, thread/customer references exist, `valid_until` only on `temporal`, regexes parse, `wiki_update.page` exists. `pnpm eval validate`.
- [x] **T2.2 (S)** `src/wiki`: loader, index text for the system prompt, `read_page` tool, `update(page, text)` that appends a dated section to a per-run copy of the wiki; `search_wiki` (MiniSearch) behind a flag.
- [ ] **T2.3 (S)** `MemoryEngine` interface + `none` + `naive` (per-customer text log; `recall` returns the log newest first, token-capped). `naive` is the baseline every real engine must beat.
- [ ] **T2.4 (M)** `runTurn`: system prompt (persona, clock, CRM record, wiki index, hydrated memory items with kind and validity, escalate-or-answer pointer, "reply in the customer's language"), AI SDK tool loop with `read_page`, `recall_memory` (read `tool|both`), `remember` (write `agent|both`; args = `kind, about, statement, valid_until?`; the runner prefixes the date, fills `learnedFrom` and forces `scope: customer`), mandatory `finish`. Max 8 steps. Unit test with a stubbed model.
- [ ] **T2.5 (M)** `runner.ts`: executes steps in order under the scenario clock; threads in memory; on `agent_turn` hydrates via `engine.recall(customer, latestCustomerMessage, now)`, calls `runTurn`, appends `agent_reply`, passes `memoryWrites` to `engine.write`; on `consolidate` calls `engine.consolidate` for every thread with new events since the last consolidate; under `write: agent` the transcript is reduced to `coach_note` events only, so human notes are ingested in every mode and the modes differ in who extracts facts from the conversation; coach notes with `scope: product` yield `scope: shared` items; on `wiki_update` appends the K statements to the page; probes at the end. `engine.reset()` before each run. `--repeat N`.
- [ ] **T2.6 (M)** `checks.ts` + `judge.ts`: deterministic first (`outcome`, `tolerated`, `reply.must/must_not`, `escalation.reason_must`), then judge (`uses`, `must_not_use`, `reply.rubric`, probe `recalls/must_not_recall/proposes`). One judge prompt template: fact statement + text + "does the text convey this fact? Text may be Russian or English." → `pass|partial|fail` + one-line why. Every judge call logged with its prompt.
- [ ] **T2.7 (M)** `report.ts`: results JSON per run (`evals/results/<run-id>/<scenario>.<config>.<rep>.json`) and `REPORT.md`: one table per scenario, rows = checks, columns = configs, cells = pass rate over repeats (✓ ◐ ✗ –), totals, cost and median latency per config, a "which path learned it" column per K item (agent / consolidate / none), and a findings section listing every check where configs disagree.
- [ ] **T2.8 (S)** Smoke run: scenario 1 × {`none`, `naive`}. *Done when:* `none` fails every `uses`, passes every isolation check; `naive` passes at least the same-customer `uses` checks. Commit the report as the first baseline.

**Checkpoint M1-lite:** 1 scenario × {none, naive, notes} × {consolidate, agent} → report. Reachable before any external engine.

### T3 — Memory engines (Track A, after T2.8)

- [ ] **T3.1 (M)** `notes` engine (ours): SQLite (`node:sqlite` or `better-sqlite3`). `write` inserts. `consolidate` = one LLM call over the transcript with a structured-output schema identical to `MemoryItem[]`, dedup by statement similarity against existing rows. `recall` = rows with `about == customer || learnedFrom == customer`, expired temporal rows returned flagged as expired, keyword-ranked, token-capped. `proposals` = product rows with `documentationCandidate`, customer names stripped.
- [ ] **T3.2 (M)** `mem0` adapter: `mem0ai/oss` `Memory`, in-memory vector store, OpenAI LLM + embedder. `write` → `add(statement, {userId})`; `consolidate` → `add(messages, {userId})`; `recall` → `search(query, {userId})`; `proposals` undefined. Record in the report: wall-clock timestamps, extraction tuned to personal-assistant facts.
- [ ] **T3.3 (M)** `xmemory` adapter: TS SDK or REST. Decide isolation: one instance per customer vs one instance with a `customer` field; verify with the isolation probe that reads scoped to merchant B never return merchant A's facts. Use synchronous writes, or poll until applied, before the next step. Track token usage against the plan's limits.
- [ ] **T3.4 (L)** Full matrix: 3 scenarios × {none, naive, notes, mem0, xmemory} × `write: consolidate` × 3 repeats, then `write: both`. Print the estimated call count first (≈ 5 agent turns + ≈ 12 judge calls per scenario-run) and require `--yes`. Produce `REPORT.md`, spot-check 10 judge verdicts by hand, write a one-paragraph conclusion per engine and per write path. **M1 done.**

## 6. Milestone 2 — dev UI

- [ ] **T4.1 (M)** Server (Hono): in-memory or SQLite session with threads, clock, engine, per-session wiki copy. Endpoints: create thread / send customer message, run agent turn (streamed steps), escalation queue, human reply + coach note, consolidate, memory inspector, proposals, accept proposal (wiki update + index reload), set clock.
- [ ] **T4.2 (M)** Client (Vite + React, three panes): **Customer** (pick customer, chat) · **Agent trace** (wiki reads, memory recalls with kind and validity, `remember` calls, tool calls, outcome and escalation reason, cost) · **Human console** (escalation queue, reply, coach note, proposals with "accept into wiki"). Clock widget and "consolidate now".
- [ ] **T4.3 (M)** Scenario player: load any `evals/scenarios/*.yaml`, "next step" executes one step through the same runner, checks render live next to the trace.
- [ ] **T4.4 (S)** Memory and wiki inspectors: per-customer notes with expiry state and write source; wiki page viewer with a diff after an accepted proposal.
- [ ] **T4.5 (S)** `DEMO.md`: the storyline in §9 with exact clicks. **M2 done.**

## 7. Eval format v2 — diff against `evals/README.md`

**Keep unchanged:** `id/title/tags`, `world.clock`, `world.customers`, `knowledge` (K items with `kind/about/statement/source/valid_until/documentation_candidate`), steps `customer_message`, `agent_turn`, `human_reply`, `close_ticket`, `consolidate`; expectation keys `outcome`, `tolerated`, `uses`, `must_not_use`, `reply.must`, `reply.must_not`, `reply.rubric`, `escalation.reason_must`; probes `memory_recall`, `documentation_proposals`; the `skipped` rule; results as counts; judge logging.

**Change:**
- `internal_discussion` → `coach_note` (`thread`, `author`, `at`, `content`): a human's explicit note to the agent, never customer-visible. Feeds memory only.
- `outcome` is deterministic for all values (D5). Drop `close` as an outcome; the platform closes tickets.
- `world.customers.<id>` = `{ name, profile }`; `profile` is free text shown as the CRM record. Drop `plan/notes/company`.
- `world.knowledge_base`: `wiki` or `none`.
- `consolidate` runs immediately; no engine idle window.
- Config: `agent`, `memory {engine, read, write}`, `judge`. Drop `hydration_budget`, `shared_knowledge`, `thinking`.
- Results: add `repeat`, `latencyMs`, per-check `judgePrompt` when judged, `memoryWrites` with `source.via`.
- Language: content fields Russian, structural fields and rubrics English.

**Cut for v1:** `by_config`, `shared_knowledge`, `tools.called/not_called` (brittle across agent libraries; the trace is in the results), `world.extends`, `source_issues`.

**Add:**
- Step `wiki_update` (`page`, `knowledge: [K..]`, `at`): the human accepted a proposal; the runner appends the K statements to the page for the rest of the run. This replaces `by_config`: the same scenario expects `escalate` before and `answer` after.
- `must_not_use` on the post-`valid_until` thread in every temporal scenario.
- `--repeat N` with pass rates.
- The wiki leak lint (T1.6).
- Every memory write is dated with the scenario clock (principle 5).

## 8. Risks and gotchas

- **Clocks.** Hosted engines stamp wall-clock time; weeks of scenario time pass in minutes, so any engine-internal recency or expiry logic sees all writes as simultaneous. Dated statements (principle 5) keep the temporal test meaningful: the agent reasons about the date in the text against the prompt clock. Only `notes` honours `validUntil` natively. State this in the report.
- **xmemory.** Verify the TS SDK API before T3.3 (the Python client and `xmemcli` are documented; a REST adapter is the fallback). Async writes need a sync flag or polling. Free tier today: 70k tokens/month and 5 instances (console shows 0/70K). Run xmemory last, 1 repeat; upgrade only if it proves interesting.
- **mem0** needs an embedder key, may drop technical facts, has no scenario clock. Findings, not bugs.
- **Two write paths blur attribution.** `source.via` on every item and the per-K "which path learned it" column in the report keep them separable.
- **Nondeterminism:** `--repeat 3`, temperature 0, pass rates.
- **Wiki leaks** make memory look good for the wrong reason: T1.6 after every wiki edit.
- **Judge self-preference:** judge model ≠ agent model where a second key exists; spot-check verdicts.
- **Russian content and the judge:** the judge prompt states the language explicitly; regex checks in scenarios must use Russian stems (`/таблиц|table/i`) where the reply is Russian.
- **Cost surprises:** print the estimated call count before a matrix run and require `--yes`.

## 9. Demo storyline (M2)

1. Merchant A asks about dropped CSV rows. Trace: wiki pages read, memory empty, outcome `escalate` with a data-loss reason.
2. Human console: reply to A, add a coach note with the merchant's setup, the product internals, and the fix date.
3. Advance the clock, consolidate. Memory inspector shows a personal note, a temporal note with expiry, and a product note flagged as a documentation candidate, each with its write source.
4. Merchant A asks again later. Trace shows the recall hit; the answer cites the scheduled fix.
5. Merchant B asks the product-level question. Agent escalates (isolation); the proposals pane shows the candidate. Accept it into the wiki, re-run B's turn: answered from the wiki page. Flywheel closed.
6. Load scenario 1 in the player and step through; checks go green in real time.

## 10. Later / out of scope for the hackathon

- `internal_discussion` step with withdrawn hypotheses.
- Agent-initiated promotion (the agent proposing `scope: shared` itself). Today only humans broadcast.
- English-language scenarios for an international demo.
- HTML report; per-check trend across runs.
- Real ticketing integration (queue, poll loop, messages table).
