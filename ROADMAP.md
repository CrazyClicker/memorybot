# ROADMAP — support agent with learning memory (restart)

**Status:** in progress. Decisions confirmed on 2026-09-03. Done so far: T0.1–T0.3, T1.1–T1.5 (wiki, `wiki/README.md`, scenarios 1–3), T2.1–T2.8 (runner, checks, judge, report; baseline in `evals/BASELINE.md`), T3.1–T3.3 (notes, mem0 and xmemory). T3.1 landed with the M1-lite checkpoint (`evals/M1-LITE.md`), whose three agent-level outcome patterns were then fixed in Track B (see below). Next: T3.4. Still open from the earlier tracks: T1.6 (wiki leak lint). The judge was calibrated on 2026-09-04 after a smoke run of scenarios 2–3 (evals/README §4); `baseline-4` (all three scenarios × {`none`, `naive`} × 3, after the fixes) is the reference in `evals/BASELINE.md`. `m1-lite-5` predates the fixes, so the six-config matrix has to be re-run before its engine columns are quoted again.

**Pre-matrix revision (2026-09-05):** research hypotheses and evidence references now live in scenario YAML; see `evals/EXPERIMENTS.md` for staged execution and decision rules, and `evals/REPORT-PREVIEW.md` for an offline format preview. Five core scenarios now include `customer-setup-change` and `human-reply-only`; `evals/stress/recall-under-noise.yaml` is opt-in. The incident distinguishes expiry from confirmed recovery, and the prompt no longer infers recovery from a deadline. `notes-both` now holds `read: hydrate` fixed. Result JSON records recall payloads, response timing, judge spend and saved scenario/config definitions; the report separates evidence, coverage, costs and manual decisions. Existing baseline/M1-lite results are historical and cannot establish quality under the revised scenarios/prompt. No paid matrix has run for this revision. T1.6 remains open.

**H2 refinement:** CSV K2 now contains the Only new mode rule and the BOM/title-matching exception. Three independent pre-release questions check its branches after consolidation; `evals/controls/csv-rule-source.yaml` supplies the identical original explanation and questions directly to the same support model with none. This is a meaning-preservation check, not a claim that structured memory beats a short transcript. The control is opt-in and costs three agent turns plus three rubric judgments per repeat. Revised core estimate: 26 agent turns / up to 70 judge calls per config-repeat. No paid control or eval has been run for this refinement.

**Milestone revision (2026-09-05):** the dev UI is no longer the second milestone. M2 is now a live demo on GitHub Issues in this repository: an issue is a ticket, the agent answers it as a comment with its trace, humans reply and coach in comments, documentation proposals arrive as pull requests against `wiki/`, and the recorded storyline (§9) is the hackathon submission. The dev UI moved to M3 (§10) and is not needed for the demo. Task numbering: T4 is the live loop (code), T5 the GitHub side and the recording, T6 the deferred dev UI. The M2 decisions in §2 are proposed, not confirmed.

## 0. Goal and milestones

A support agent receives a customer message, reads the wiki, checks its memory and either
answers or escalates to a human. The human replies to the customer and may leave a
**coach note** for the agent. Over this loop the agent learns from three sources:

1. facts stated in customer messages (personal setup, constraints),
2. human replies on escalated tickets,
3. coach notes attached to escalated tickets.

Evals come first. The live GitHub loop (M2) and the deferred dev UI (M3) reuse the eval
machinery instead of a separate runtime: the agent stays a pure function and the loop owns
the state.

| Milestone | Definition of done |
|---|---|
| **M1 — Evals report** | Execute the staged comparisons in [evals/RUNS.md](evals/RUNS.md): `--suite research` for source control, core engine matrix and long-history stress; add `--suite write-paths` when comparing writing mechanisms. Generate separate reports with `pnpm eval report`, link them in a campaign record, audit verdicts and complete hypothesis and engine/write-path decisions (T3.4). Record omitted comparisons as insufficient evidence. `--all` alone covers only core stories across all configs. |
| **M2 — GitHub Issues live demo** | The agent runs against this repository: an issue opened through the support form is a ticket; the agent answers, asks or escalates in a comment that carries a collapsed trace (wiki pages read, memory recalled, memory written, cost); humans reply as themselves and leave coach notes with a `/coach` comment; the loop consolidates on coach notes and on close; documentation proposals arrive as pull requests against `wiki/`, and merging one updates the live wiki; `/clock` moves the scenario clock; a pinned issue shows the memory per merchant. `DEMO.md` scripts the three-act storyline in §9, the rehearsed recording is submitted, and the README links the video, the demo issues, the merged proposal and the M1 report. |
| **M3 — Dev UI (deferred)** | A local web UI: chat as a customer, watch the agent's trace, act as the human on escalations, inspect memory and documentation proposals, accept a proposal into the wiki, advance the clock, and replay any scenario step by step. Not needed for the hackathon demo; see §10. |

## 1. Principles for the restart

1. **Evals are the first consumer.** No queue, no poll loop, no messages table in M1. The agent is a pure function `runTurn(input) -> TurnResult` and the scenario is the only state. M2 adds a poll loop around the agent, not inside it: GitHub is the queue and the UI (issues are tickets, comments are replies and coach notes, pull requests are documentation proposals), and the loop's SQLite state plays the scenario's role. `runTurn`, the engines and `Wiki` do not change for M2.
2. **Two write paths, both first-class, selected by config.** `write: agent` — the agent calls a `remember` tool during the turn. `write: consolidate` — the engine extracts from the transcript at `consolidate` steps. `both` runs both. Every memory write is recorded with its source so the report can say which path learned a fact.
3. **The engine's note schema is the eval's knowledge schema.** `kind / about / statement / valid_until / source` are the same words in the scenario, in the `notes` engine, in the `remember` tool and in the judge prompt.
4. **Everything learned on a customer's ticket belongs to that customer, unless a human broadcasts it.** Product facts reach other customers in two ways only: a human accepts a documentation proposal into the wiki (`wiki_update` step), or a human marks a coach note `scope: product`, which stores the fact as `scope: shared` so every customer's recall sees it (incidents, platform-wide temporary conditions). The agent never promotes on its own. No shared-knowledge layer, no `by_config`.
5. **Every write is dated with the scenario clock** ("По состоянию на 2026-08-27: …"). Hosted engines stamp wall-clock time, so the date must live in the text.
6. **Anything an engine cannot serve is `skipped`, never `fail`.**
7. **Cheap first.** Deterministic checks before judge calls. Small model for the agent, a stronger model for the judge. Sampling temperature is set only for models that support it; GPT-5.6 reasoning models omit it.
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
| D9 | Models | Agent: OpenAI, `gpt-5.6-terra`, pinned in the config. Judge: a stronger model, preferably another vendor (`claude-sonnet-5`) to avoid self-preference; otherwise the strongest OpenAI model priced in `MODEL_PRICES`, today `gpt-5.6-sol` (`JUDGE_FALLBACK_MODEL`). mem0 uses the OpenAI key for its LLM and embeddings. |
| D10 | Memory read/write axes | `memory.read: hydrate \| tool \| both`, `memory.write: consolidate \| agent \| both`. Full matrix runs `write: consolidate` first, then `both`. |

M2 decisions, proposed on 2026-09-05. D11, D12 and D15 confirmed on 2026-09-06; D13 revised the same day; D14 and D16 still proposed:

| # | Decision | Value |
|---|---|---|
| D11 | Demo surface | GitHub Issues in this repository (`CrazyClicker/memorybot`): one link for the judges covers code, evals, issues and proposal PRs. Confirmed 2026-09-06. |
| D12 | Human console | GitHub itself. Escalation = label `escalated` + assignee; the human replies as a normal comment; a coach note is a comment starting with `/coach` (`/coach product` broadcasts, D7); `pnpm live coach` files a note privately when the comment must not be public. No web UI in M2. Confirmed 2026-09-06; a public coach comment is acceptable for the demo. |
| D13 | Bot identity | Either a dedicated machine account added as a collaborator with Write access and authenticated with a **classic** PAT (`repo` scope), or a GitHub App owned by `CrazyClicker` and installed on this repository (issues, pull requests, contents: read/write; metadata: read). Fine-grained PATs are out: GitHub does not let them act on a repository the account does not own. The App needs no second e-mail or 2FA and shows a bot badge; the T4.1 client takes either a token or app credentials. |
| D14 | Live clock | `now = wall clock + offset`; `/clock <ISO>` moves the offset forward only; demo texts carry the dates of the recording week; every note keeps its date in the text (principle 5). |
| D15 | Demo engine | `notes` (the only engine that honours `valid_until` and serves proposals) with `evals/configs/notes-both.yaml`, so act 1 shows the `remember` tool and act 2 shows consolidation. Confirmed 2026-09-06 for the recording. `xmemory` is to be tried in the live loop afterwards, hosted quota permitting, which is why the loop takes any eval config (`config:` in `live/config.yaml`). |
| D16 | Transport | Polling every 10 s with a cursor, one process on a laptop. No webhooks, no public URL, no GitHub Actions in M2 (§11). |

## 3. Target repository layout

```
src/
  llm/         provider registry, model catalogue with prices, usage -> USD, optional disk cache
  wiki/        loader (frontmatter: slug, title, summary), tools: read_page, search_wiki; update(page, text)
  agent/       runTurn(), system prompt, tools: finish, remember, recall_memory
  memory/      engine.ts (interface), none.ts, naive.ts, notes.ts, mem0.ts, xmemory.ts
  evals/       schema.ts (zod), runner.ts, checks.ts, judge.ts, report.ts, cli.ts
  live/        M2: github.ts (client + fake), session.ts, state.ts, loop.ts, render.ts, cli.ts
  ui/          M3 (deferred): server (Hono) + client (Vite + React)
evals/
  README.md    format v2 (see §7)
  scenarios/   *.yaml
  configs/     *.yaml
  results/     git-ignored
wiki/
  README.md    the list of facts deliberately absent from the wiki
  *.md         Russian
live/
  config.yaml  repo, human logins, merchant login map and CRM profiles, engine config
  *.db         git-ignored: state.db (threads, cursor, clock), memory.db (notes engine)
.github/ISSUE_TEMPLATE/support.yml   the support form: merchant dropdown, subject, message
DEMO.md        M2: the storyline in §9 with exact texts and commands
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
  scope?: 'customer' | 'product'; // coach_note only; product is the human broadcast gate
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
| mem0 | `add(statement, {userId: learnedFrom})`; shared items under `userId: '_shared'` | `add(messages, {userId})` | SDK v3 `search(query, {filters: {user_id}})` for the customer merged with `_shared` | – (skipped) |
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
  usage: TokenUsage;                                              // total over all AI SDK steps
  costUsd?: number;                                               // absent when the model has no price entry
  latencyMs: number;
}
```

```yaml
# evals/configs/notes-consolidate.yaml
id: notes-consolidate
agent:  { provider: openai, model: gpt-5.6-terra }
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
- [x] **T1.3 (M)** Scenario 1 `csv-import-dropped-rows.yaml` (written). Thread A: escalate (P-002), merchant follow-up with K1, coach note + human reply with K2, the dated obligation K3 and the manual fix K4 → consolidate → thread B before `valid_until` (`uses: [K3]`) → a second coach note confirming the release shipped (K5) → consolidate → thread C after (`uses: [K1, K2, K5]`, `must_not_use: [K3]`) → thread D, another merchant (escalate, isolation on K1/K4) → `wiki_update` with K2 → thread D2 (`answer`, `uses: [K2]`, `must_not_use: [K1, K4]`) → 3 probes.
- [x] **T1.4 (S)** Scenario 2 `setup-from-the-question.yaml` (written): learning source 1 only. «Кофе-точка» asks a delivery-zone question the wiki answers and states its setup on the way: K1 two-stage payments because coffee is roasted to order (background), K2 delivery only within Томская область (the subject) → `answer`, no escalation → consolidate → thread B "can the order wait two weeks?" needs K1 (`answer`, `uses: [K1]`, rubric: does not ask which payment mode) → thread C "buyer from Novosibirsk cannot order" needs K2 → thread D, «Лаванда» asks B's question (`must_not_use: [K1, K2]`) → 3 probes. Separates the write paths: `write: agent` must catch K1/K2 in-turn with no coach note to lean on, `write: consolidate` must extract them from a two-message transcript.
- [x] **T1.5 (S)** Scenario 3 `payment-provider-incident.yaml` (written): the **shared temporal** case. «Кофе-точка» reports card payments failing → escalate (P-001). Human reply + two coach notes: `scope: product` with the incident (K1 temporal, shared: «Оплатим» не проводит карты с 12:00 5 сентября, восстановление к 18:00, QR работает) and `scope: customer` with the reporter's orders and the open double-charge case (K2 personal). Consolidate at 14:00. «Лаванда» asks at 15:00 → `answer`, `uses: [K1]`, `must_not_use: [K2]`, no new escalation (P-007). «Лаванда» asks on 7 September → `must_not_use: [K1]`, rubric "treats it as resolved". «Кофе-точка» chases order 1153 on 7 September without naming it → `escalate`, `uses: [K2]`, `must_not_use: [K1]`. Probes: recall for «Лаванда» returns K1 and not K2, recall for «Кофе-точка» returns both, no documentation candidates.
- [ ] **T1.6 (S)** Wiki leak lint (`pnpm eval lint-wiki`): run every scenario with engine `none`; every `uses:` must fail, except checks after a `wiki_update` that promoted the item. A passing `uses` means the fact is in the wiki; remove it from the wiki, not from the scenario. Run after every wiki edit.

### T2 — Runner core (Track A)

- [x] **T2.1 (M)** `src/evals/schema.ts`: zod schemas for scenario, config, results. Validation: monotonic `at`, K references exist, thread/customer references exist, `valid_until` only on `temporal`, regexes parse, `wiki_update.page` exists. `pnpm eval validate`.
- [x] **T2.2 (S)** `src/wiki`: loader, index text for the system prompt, `read_page` tool, `update(page, text)` that appends a dated section to a per-run copy of the wiki; `search_wiki` (MiniSearch) behind a flag.
- [x] **T2.3 (S)** `MemoryEngine` interface + `none` + `naive` (per-customer text log; `recall` returns the log newest first, token-capped). `naive` is the baseline every real engine must beat.
- [x] **T2.4 (M)** `runTurn`: system prompt (persona, clock, CRM record, wiki index, hydrated memory items with kind and validity, escalate-or-answer pointer, "reply in the customer's language"), AI SDK tool loop with `read_page`, `recall_memory` (read `tool|both`), `remember` (write `agent|both`; args = `kind, about, statement, valid_until?`; the runner prefixes the date, fills `learnedFrom` and forces `scope: customer`), mandatory `finish`. Max 8 steps. Unit test with a stubbed model.
- [x] **T2.5 (M)** `runner.ts`: executes steps in order under the scenario clock; threads in memory; on `agent_turn` hydrates via `engine.recall(customer, latestCustomerMessage, now)`, calls `runTurn`, appends `agent_reply`, passes `memoryWrites` to `engine.write`; on `consolidate` calls `engine.consolidate` for every thread with new events since the last consolidate; under `write: agent` the transcript is reduced to `coach_note` events only, so human notes are ingested in every mode and the modes differ in who extracts facts from the conversation; coach notes with `scope: product` yield `scope: shared` items; on `wiki_update` appends the K statements to the page; probes at the end. `engine.reset()` before each run. `--repeat N`.
- [x] **T2.6 (M)** `checks.ts` + `judge.ts`: deterministic first (`outcome`, `tolerated`, `reply.must/must_not`, `escalation.reason_must`), then judge (`uses`, `must_not_use`, `reply.rubric`, probe `recalls/must_not_recall/proposes`). One judge prompt template: fact statement + text + "does the text convey this fact? Text may be Russian or English." → `pass|partial|fail` + one-line why. Every judge call logged with its prompt. Calibrated 2026-09-04 (evals/README §4): substance over clauses; generic or both-cases text is not a use; a temporal fact on an agent turn counts only when asserted as currently in force.
- [x] **T2.7 (M)** `report.ts`: results JSON per run (`evals/results/<run-id>/<scenario>.<config>.<rep>.json`) and `REPORT.md`: one table per scenario, rows = checks, columns = configs, cells = pass rate over repeats (✓ ◐ ✗ –), totals, cost and median latency per config, a "which path learned it" column per K item (agent / consolidate / none), and a findings section listing every check where configs disagree.
- [x] **T2.8 (S)** Baseline: all three scenarios × {`none`, `naive`} → `evals/BASELINE.md` (run `baseline-4`, 2026-09-04, 3 repeats, after the Track B rule fixes; it supersedes `baseline-3`, 1 repeat, which superseded `baseline-2`, scenario 1 only and before the judge calibration). `none` passes no `uses` before a `wiki_update` and every isolation check, so the wiki is clean. `naive` lands the same-customer `uses` and both `recalls:` probes, fails `uses:K2` on scenario 1's thread C, hedges conditionally on scenario 2's threads B/C and scenario 3's thread C even with the transcript in the prompt, and serves no proposals. Left standing as the bar `notes` has to clear, not tuned away.

**Checkpoint M1-lite:** reached 2026-09-04 with 3 scenarios × {none, naive, naive-agent, notes, notes-agent, notes-both} × 3 repeats → `evals/M1-LITE.md`.

### T3 — Memory engines (Track A, after T2.8)

- [x] **T3.1 (M)** `notes` engine (ours): SQLite (`node:sqlite`, in-memory for evals, a file for M2). `write` inserts with Jaccard dedup. `consolidate` = one structured-output call over the transcript (numbered events with their trust, the known notes as "do not repeat"), the engine fills scope (shared only from a product coach note), the date from the latest source event and `documentationCandidate`; general note-taking rules only, no scenario objects, so scenarios 2–3 stayed a valid out-of-sample check. `recall` = scoped rows ranked by token overlap, zero-overlap and expired rows kept, token-capped. `proposals` = product rows flagged as candidates. `usage()` charges the extraction to the run. Landed 2026-09-04 with the M1-lite checkpoint (`evals/M1-LITE.md`, run `m1-lite-5`, cold cache, 3 repeats): `notes` matches `naive` on the shared checks, serves proposals and states personal setup as known where `naive` hedges; the remaining failures were agent outcome decisions (P-001/P-002 read literally, expired incidents not treated as over) that hit every engine, fixed in Track B on 2026-09-04 and re-measured in `baseline-4`.
- [x] **T3.2 (M)** `mem0` adapter: `mem0ai/oss` `Memory`, in-memory vector store, the same OpenAI model as the agent for like-for-like extraction + OpenAI embedder. `write` → `add(statement, {userId})`; `consolidate` → `add(messages, {userId})`; `recall` → SDK v3 `search(query, {filters: {user_id}})`; `proposals` undefined. Record in the report: wall-clock timestamps, extraction tuned to personal-assistant facts.
- [x] **T3.3 (M)** `xmemory` adapter: `xmemory@3.8.3`, synchronous `fast` writes, one temporary instance per customer plus `_shared`, fixed dump reads ranked locally, and operation diagnostics with trace/console links (the API exposes no token usage). Missing credentials skip the config; rate limits retry and quota failures do not. Smoke `t33-xmemory-smoke` on scenario 3, 2026-09-04: 3 creates + 3 writes + 12 reads in 169 s, 6 extracted rows, no consolidation errors; both isolation probes and the no-proposals probe passed. Score 25 pass / 2 partial / 1 fail: the misses were answer completeness (18:00 and K2 detail), not memory isolation. The three remote instances were deleted after the run. A synthetic write-change id (`#1`) observed in the live response is now replaced with a scoped stable fallback; normal CLI runs clean up only the exact instances they created.
- [ ] **T3.4 (L)** Staged matrix (protocol: `evals/EXPERIMENTS.md`; run catalogue and commands: [evals/RUNS.md](evals/RUNS.md)): start with the CSV source control, then five core scenarios × {none, naive, notes, mem0, xmemory}, first `read: hydrate / write: consolidate` with one repeat; review controls, judge disputes, operation counts and spend, then complete selected comparisons to three fresh repeats. The main `--suite research` selection has 31 scenario/config pairs per repeat. Add `--suite write-paths` (15 more pairs) when comparing `agent / consolidate / both` within an engine with read fixed, reusing comparable core baselines; otherwise leave writing-mode superiority untested. Run the opt-in long-history case on selected consolidate configs. Produce separate reports and a campaign record linking their evidence and omissions, audit at least 10 targeted judge verdicts, complete each hypothesis decision and the engine/write-path decision record. Record unknown internal spend separately; do not rank by total passes. **M1 done only after these reviews and decisions.**

## 6. Milestone 2 — GitHub Issues live demo

The agent, the engines and the wiki are the ones the evals run; what M2 adds is a loop that
turns GitHub events into the same thread events the runner feeds them, and GitHub back into
the place where humans answer escalations. Track A (T4, code) and Track B (T5, GitHub side,
texts, recording) run in parallel and meet at the rehearsal (T5.3). T4 does not edit
`src/evals/runner.ts` while T3.4 is running; T4.7 folds the runner onto the shared session
afterwards.

Event mapping (the loop's whole contract):

| GitHub event | Session event | Loop action |
|---|---|---|
| issue opened through the support form (label `support`) | new thread + `customer_message` | agent turn |
| comment by a merchant login on an issue that is not `escalated` | `customer_message` | agent turn |
| comment by a human login | `human_reply` | none; the thread stays with the human |
| comment `/coach [product] …` by a human | `coach_note` (scope `customer` / `product`) | 🧠 reaction, minimize the comment, consolidate the thread |
| comment `/clock <ISO>` by a human | – | move the scenario clock forward |
| comment `/consolidate` by a human | – | consolidate the thread |
| issue closed | `close_ticket` | consolidate the thread |
| proposal PR merged | `wiki_update` | reload the wiki from `main`, comment on the source issue |

Agent turn outcome → GitHub: `answer` → comment + label `agent:answered`; `ask` → comment +
`agent:asked`, the loop waits for the merchant; `escalate` → the customer-facing reply as a
comment + label `escalated` + assign the human logins, the escalation reason inside the
collapsed trace. Once `escalated` the agent never posts on that issue again.

### T4 — Live loop (Track A)

- [x] **T4.1 (M)** `src/live/github.ts`: one thin client over `@octokit/rest` + GraphQL with a token: issues with the `support` label updated since a cursor, their comments, create comment, add/remove labels, assign, add a reaction, minimize a comment (`minimizeComment`, reason OUTDATED), edit an issue body, create a branch + commit + PR through the contents API, list PRs by head-branch prefix with merge state, read `wiki/*.md` from `main`, delete an issue (GraphQL, owner token). Every method returns plain data; an in-memory fake implements the same interface for tests. Polling, not webhooks (D16). Done 2026-09-06: `src/live/github.ts` (`GithubClient` interface, `OctokitGithubClient`, `githubAuthFromEnv` for a PAT or App credentials) and `src/live/fake-github.ts` (`FakeGithubClient` with `openIssue`, `commentAs`, `closeIssue`, `mergePullRequest` to play the people; issues and PRs share one number space, `updatedAt` moves on every change so `since` cursors work). Extras the later tasks need: `closePullRequest` and `deleteBranch` for `reset --issues`, `getIssue`. `readWiki` is one GraphQL tree query. GitHub has no 🧠 reaction, so the loop picks one of GitHub's eight (`eyes`). Tests drive the real client through a scripted `fetch` (Octokit percent-encodes `:` and `/` in path parameters). Read-only smoke against `CrazyClicker/memorybot` with the bot PAT passed; the write paths get their live run at the rehearsal (T5.3).
- [x] **T4.2 (M)** `src/live/session.ts` + `state.ts`: the runner's glue as a reusable object. `Session({config, engine, wiki, clock})` with `customerMessage`, `agentTurn` (hydrate through `engine.recall` → `runTurn` with the recall callback → `agent_reply` → `engine.write` of the dated, customer-scoped writes; identical to the runner's `agent_turn` step), `humanReply`, `coachNote`, `close`, `consolidate(thread)` (under `write: agent` the transcript is reduced to coach notes, as in the runner), `wikiReload(pages)` and `newProposals()`. State in SQLite `live/state.db`: threads and events with their GitHub ids, processed event ids, clock offset, proposal ↔ PR. Memory is the `notes` engine on `live/memory.db` through its `path` option; `reset()` runs only from `pnpm live reset`. Clock per D14. Config is an eval config file (`evals/configs/notes-both.yaml` by default); its `judge` is ignored. Done 2026-09-06: `src/live/state.ts` (`LiveState` over `node:sqlite`: threads with their issue number and consolidation watermark, events with their GitHub id and the turn record as JSON on the `agent_reply` event, processed ids, `meta` with the clock offset, proposal ↔ PR with a status; `appendEvent` returns the existing row for a GitHub id it already holds, `transaction()` nests through savepoints, `reset()` empties every table) and `src/live/session.ts` (`Session({config, engine, wiki, state, customers, clock?, runAgent?})`: `now`/`setClock` forward-only, `customerMessage`/`humanReply`/`coachNote` idempotent on `githubId`, `close`, `agentTurn` returning a `SessionTurn` = the runner's `StepResult` minus checks, `consolidate(thread)` one thread at a time with engine errors propagated so the thread stays pending, `wikiReload` + `wikiPagesFromFiles` for `readWiki` output, `newProposals`, `reset`, `dispose`; `createSessionEngine` puts `notes` on `live/memory.db`, `openSession` loads the config file, the local wiki and both DBs). Events are stamped with the session clock, never GitHub's timestamps, so a comment after a `/clock` jump carries the jumped date. The turn helpers are copied from the runner until T4.7 folds them.
- [x] **T4.3 (M)** `src/live/loop.ts`: poll every 30 s, map GitHub events to session events by the table above, act, record. Customer = the merchant field of the issue form (the `### Магазин` heading in the body), falling back to the login map in `live/config.yaml`; humans = the logins listed there; the bot's own comments are skipped. Idempotency: an event id is marked processed together with the comment it produced, in one transaction, so a crash mid-turn re-runs the turn but never posts twice. Errors on one issue are logged and never stop the loop; `AgentDidNotFinishError` posts nothing, retries on the next two polls, then labels `agent:failed`. Done 2026-09-06: `src/live/config.ts` (`LiveConfigSchema`, `loadLiveConfig` for `live/config.yaml`, lookups by form value and login, `sessionCustomers`), `src/live/events.ts` (`parseIssueForm` over the `### Магазин`/`### Сообщение` headings, `resolveIssueCustomer`, `issueMessage` = subject + message field, `parseCommand` for `/coach [product] …`, `/clock <ISO>`, `/consolidate`) and `src/live/loop.ts` (`LiveLoop.poll()` / `run(signal)`; ids `issue:N`, `comment:ID`, `close:N`, `pr:N:merged` in `processed`; the cursor `meta.issues_since` is the latest `updatedAt` of the issues handled completely and is held back to the `updatedAt` of an issue that errored, so it is listed again; comments of a listed issue are fetched in full). A merchant comment on an escalated issue is recorded without a turn; `/clock` backwards, malformed commands, issues without a merchant and messages on closed threads are skipped once with the reason in `processed`; a turn recorded before a crash is posted without a new agent call; labels and assignees follow the transaction and are best effort; a merged proposal PR reloads the wiki from `main` and comments on the source issue, a closed one drops the proposal (T4.5 opens them). `LoopRenderer` with a plain default until T4.4. Offline tests over the fake client, 20 for the loop.
- [ ] **T4.4 (S)** `src/live/render.ts`: the bot comment is the customer-facing reply followed by a collapsed `<details>` "Как я отвечал": outcome, wiki pages read, memory recalled (kind, scope, validity, statement), memory written this turn, escalation reason, cost and latency. The consolidation comment lists the notes written (kind, scope, `valid_until`, text) and links the proposal PRs. The pinned "🧠 Память агента" issue body is regenerated after every write: one section per merchant plus shared notes, expired ones struck through. Snapshot-tested offline.
- [ ] **T4.5 (S)** Proposal PRs: after every consolidation, each new item from `engine.proposals()` becomes a PR on branch `wiki/proposal-<id>` that appends `## Обновление от <date>` + statement to `wiki/<slug>.md`, the same text `Wiki.update` produces. The page is chosen by one small structured call over the wiki index (slug + one line why); the human may edit the page or the text before merging, so on merge the loop reloads the whole wiki from `main` instead of replaying the statement. The PR body links the source issue; merchant names were already stripped by the engine, and the `wiki/README.md` leak grep runs on the diff.
- [ ] **T4.6 (S)** `pnpm live run|once|status|memory|coach|clock|reset`: `run` polls forever, `once` does one poll (tests, rehearsals), `status` prints threads and clock, `memory [--customer]` dumps the notes DB, `coach <issue> [--product] <text>` files a coach note without a public comment (the private path; `/coach` in a comment is the on-camera path), `clock <ISO>` moves the clock, `reset` clears the local DBs and with `--issues` deletes the demo issues and closes proposal PRs using the owner's `gh auth token`. Without a token the commands run against the fake client on a recorded fixture.
- [ ] **T4.7 (S, after T3.4 lands)** Fold the runner's `agent_turn` and `consolidate` steps onto `Session` so evals and the live loop share one implementation. Behaviour-preserving: `pnpm test` and one cached scenario run before and after produce identical result JSON apart from timing.

### T5 — GitHub side, demo texts and recording (Track B)

- [ ] **T5.1 (S)** Repository setup on `CrazyClicker/memorybot`: issue form `.github/ISSUE_TEMPLATE/support.yml` (merchant dropdown with the four merchants from `DOMAIN.md`, message, auto-label `support`; the issue title is the subject); labels `support`, `agent:answered`, `agent:asked`, `escalated`, `agent:failed`, `proposal`; the bot identity (D13) in `.env`; `live/config.yaml` with the repository, the human logins, the merchant form values and login map, the CRM profiles and the engine config; the pinned memory issue, its number recorded in `live/config.yaml`. Optional second account for the merchant so the two roles look different on camera. Touches nothing under `src/`, so it runs alongside T3.4. Done 2026-09-06: bot `crazyclicker-bot` (collaborator with Write, classic PAT `repo`), the six labels, pinned issue #1 «Память агента», `live/config.yaml`, the form file. The form is live only once `.github/ISSUE_TEMPLATE/support.yml` is on `main`.
- [ ] **T5.2 (M)** `DEMO.md`: the storyline in §9 with every issue text, human reply, `/coach` note and `/clock` value copy-paste ready, adapted from scenarios 2, 1 and 3 with dates shifted to the recording week, and for each step what the viewer must see (label, trace block, consolidation comment, PR, memory issue). Texts stay Russian; the narration is in the hackathon's language.
- [ ] **T5.3 (S)** Rehearsal: run the storyline end-to-end twice from a clean state (`pnpm live reset --issues`) with `LLM_CACHE` off, timing every step; fix prompt and rendering glitches; decide what to cut so the video stays under seven minutes.
- [ ] **T5.4 (S)** Record and submit: screen recording of the storyline with the poller log picture-in-picture, captions or voice-over; README gets a "Live demo" section linking the video, the demo issues, the merged proposal PR and the M1 report. **M2 done.**

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
- **xmemory.** Hosted limits observed during the T3.3 spike: 35k tokens/day, 70k/month and 5 instances; responses do not expose usage, so result JSON keeps operation counts and console trace links for manual accounting. The adapter uses synchronous writes, works around synthetic/keyless object ids, and isolates customers structurally with per-scope instances. Run xmemory last and start with 1 repeat; the full T3.4 matrix needs the Developer-level quota.
- **mem0** needs an embedder key, may drop technical facts, has no scenario clock. Findings, not bugs.
- **Two write paths blur attribution.** `source.via` on every item and the per-K "which path learned it" column in the report keep them separable.
- **Nondeterminism:** GPT-5.6 reasoning models do not support `temperature`, so `--repeat 3` and pass rates are the primary way to expose model variance. For models that support sampling temperature, pin it explicitly in the config.
- **Wiki leaks** make memory look good for the wrong reason: T1.6 after every wiki edit.
- **Judge self-preference:** judge model ≠ agent model where a second key exists; spot-check verdicts.
- **Russian content and the judge:** the judge prompt states the language explicitly; regex checks in scenarios must use Russian stems (`/таблиц|table/i`) where the reply is Russian.
- **Cost surprises:** print the estimated call count before a matrix run and require `--yes`.
- **Coach notes are public comments (M2).** Minimizing hides them from the default view only. Say in the video that a real deployment keeps them internal; `pnpm live coach` is the private path.
- **Two clocks on camera (M2).** Demo texts carry the dates of the recording week; `/clock` is forward-only; the bot's trace block prints the clock it used, so an expired note is explainable.
- **Latency on camera (M2).** 15–40 s per agent turn, up to a minute for a consolidation that also opens a PR. Rehearse with timing, keep the poller log visible, cut the waits.
- **Double posting and lost events (M2).** One transaction per event; the comment id is stored before the labels; the cursor is the last processed comment id, not a timestamp.
- **Public repository (M2).** Every demo text is public and fictional; tokens live only in `.env`; the bot token is scoped to this repository.
- **Runner churn (M2).** T3.4 runs in a parallel session; T4 does not edit `src/evals/runner.ts` until T4.7.

## 9. Demo storyline (M2)

Three acts, one merchant story each, all adapted from existing scenarios so the texts and the
expected behaviour are already known. Every step names what the viewer sees on GitHub.

**Act 1 — learning in passing (scenario 2, ≈ 90 s).** «Кофе-точка» opens a support issue about
delivery zones and mentions on the way that they use two-stage payments and deliver only within
Томская область. The bot answers from the wiki; the trace block shows two `remember` writes
(personal). Second issue: "can the order wait two weeks?" The bot answers without asking about
the payment mode; the trace shows the recall hit. Nobody from support touched either ticket.

**Act 2 — escalation, coach note, proposal, isolation (scenario 1, ≈ 4 min).** «Дом и сад»
reports 37 rows missing after a clean CSV import → label `escalated`, assignee, the reason in the
trace. The engineer replies as themselves, then adds `/coach …` with the BOM cause, the workaround
until the release date and the manual load. The bot reacts, minimizes the note, consolidates: a
comment lists the personal, temporal and undocumented notes and links a new PR "wiki: BOM breaks
the sku header". «Дом и сад» asks whether the workaround is permanent → answered from memory,
cites the release date. «ВелоДвор» asks the product-level question → escalated, no mention of
«Дом и сад» (isolation on camera). The engineer merges the PR → «ВелоДвор» asks again → answered
from the wiki. Flywheel closed. Optional tail: `/clock` past the release, `/coach` that it
shipped, «Дом и сад»'s integrator asks → the answer says the workaround is no longer needed.

**Act 3 — broadcast and expiry (scenario 3, ≈ 2 min).** «Кофе-точка» reports card payments
failing → escalated. The engineer posts `/coach product` with the incident and its 18:00 horizon
→ the consolidation comment shows a `scope: shared` temporal note. «Лаванда» asks at once →
answered from shared memory, no new escalation. `/clock` past 18:00 → «Лаванда» asks again → the
bot says the status is unknown and does not claim recovery.

**Closing shot.** The pinned memory issue: notes per merchant, one shared, one struck through
as expired; then the M1 report with the engine comparison.

Optional beats if time allows: an `ask` outcome (P-005 clarifying question, then the answer on
the merchant's follow-up); `customer-setup-change` (the merchant changes their payment mode and
the newer note wins); `human-reply-only` (the agent learns from the operator's public reply with
no coach note at all).

## 10. Milestone 3 — dev UI (deferred past the hackathon)

Kept as specified on 2026-09-03; nothing here is needed for the M2 demo. After T4.7 the UI
server wraps the same `Session` the live loop uses.

- [ ] **T6.1 (M)** Server (Hono): in-memory or SQLite session with threads, clock, engine, per-session wiki copy. Endpoints: create thread / send customer message, run agent turn (streamed steps), escalation queue, human reply + coach note, consolidate, memory inspector, proposals, accept proposal (wiki update + index reload), set clock.
- [ ] **T6.2 (M)** Client (Vite + React, three panes): **Customer** (pick customer, chat) · **Agent trace** (wiki reads, memory recalls with kind and validity, `remember` calls, tool calls, outcome and escalation reason, cost) · **Human console** (escalation queue, reply, coach note, proposals with "accept into wiki"). Clock widget and "consolidate now".
- [ ] **T6.3 (M)** Scenario player: load any `evals/scenarios/*.yaml`, "next step" executes one step through the same runner, checks render live next to the trace.
- [ ] **T6.4 (S)** Memory and wiki inspectors: per-customer notes with expiry state and write source; wiki page viewer with a diff after an accepted proposal.
- [ ] **T6.5 (S)** Dev UI walkthrough appended to `DEMO.md`. **M3 done.**

## 11. Later / out of scope for the hackathon

- `internal_discussion` step with withdrawn hypotheses.
- Agent-initiated promotion (the agent proposing `scope: shared` itself). Today only humans broadcast.
- English-language scenarios for an international demo.
- HTML report; per-check trend across runs.
- Live loop as a GitHub Actions workflow (the memory DB would have to be committed to a branch), webhook transport, GitHub App identity.
