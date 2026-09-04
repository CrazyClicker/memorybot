# Eval report — `baseline-4`

Generated 2026-09-04T14:11:33.565Z from 18 result files: 3 scenarios × 2 configs × 3 repeats.

## Baseline notes

The floor and the bar for every engine in T3, re-measured after three wording fixes and with
three repeats instead of one. Supersedes `baseline-3` (1 repeat, before the fixes); the judge
calibration recorded there still applies. Judge on the OpenAI fallback (no Anthropic key yet),
cold cache, $1.53 ($0.91 `naive`, $0.62 `none`).

**What changed before this run.** M1-lite found three failures that hit every engine and hid the
differences between them (`evals/M1-LITE.md`). All three were the world and the agent reading
their own rules literally, so all three were fixed there — not in any scenario's expectations,
and not in an engine:

- `P-002` now escalates data missing *now*, and sends a question about *why* a since-restored
  import went wrong to the knowledge base.
- `P-001` lists the money cases that escalate (a charge without a paid order, a double charge, a
  missing or late payout, a chargeback, an unknown mass payment failure) and says outright that
  how payment works — the modes, the hold and its term, confirming a charge — is answered from
  the wiki. A known incident stays P-007's business.
- The agent prompt gained one clause: after `valid_until`, treat the temporal condition as over
  unless a newer note says otherwise, and invite the merchant to report the opposite.

**What the fixes did** (against `m1-lite-5`, same three repeats):

- Scenario 1 thread D2 (`t5-agent`): `answer` 3/3 for both configs, against `escalate` in 16 of
  18 m1-lite runs across all six configs. `none` answers it from the page the human updated, so
  the flywheel step of the demo storyline now works from the wiki alone, as designed.
- Scenario 1 threads B and C: `none` outcome ✓ 3/3 (baseline-3: ◐ and ✗). The P-002 clause, not
  memory — every `uses:` before the `wiki_update` still fails under `none`.
- Scenario 2 thread B (`t2-agent`): `naive` answers 3/3 with the rubric ✓ 3/3, against
  `escalate` 2/3 under the old P-001. The reply names the two-stage setup, the 7-day hold and
  the way out instead of passing a workflow question to an engineer.
- Scenario 3 thread C: unchanged here, and this is structural. `naive` answers 3/3 and hedges
  3/3 («подтверждения текущего статуса нет, проверьте страницу статуса»): the new clause fires
  on a note flagged expired, and transcript memory carries no expiry to flag. The clause is
  measured on `notes`, separately — see below.

**The `valid_until` clause, measured on `notes`** (`payment-provider-incident` × `notes` × 3,
runs `expiry-check-1` and `-2`, $0.64): thread C's rubric is ✓ 3/3, against 5 of 9 m1-lite runs
escalating «нужно подтвердить актуальный статус». The first of those two runs also exposed a
real bug the clause made load-bearing: one extraction wrote `valid_until: 2026-09-05` without a
time, midnight was read as the expiry, and the agent treated a live 15:00 incident as finished
and escalated it. A bare date is a day, not an instant, so `expiryMs` now resolves it to that
day's last millisecond (`src/evals/schema.ts`, used by the prompt, `recall_memory` and the
scenario lint). `expiry-check-2` is clean on every check of threads B and C in all three
repeats; the date-only case itself is covered by unit tests, as that run's extractions all
wrote full timestamps.

**No leak.** No `uses:` check passes under `none` before its scenario's `wiki_update`; the one
`none` pass on `uses:K2` is scenario 1 thread D2, after it. The manual grep list in
`wiki/README.md` stays clean — the P-001 wording avoids the word «сбой» for that reason.

**No regression.** `naive` has no outright failure in the nine runs (222 pass, 24 partial, 27
skipped). Every isolation check and every `must_not_use` holds. The standing partials are
judge-side and unchanged: `uses:K1` docks a complete reply for the clauses of a multi-part K
statement it does not repeat (scenario 1 thread C, scenario 2 thread B), and scenario 1 thread
D2's `must_not_use:K1` is partial for `none` too, which has nothing to leak — the judge reads
the wiki-correct "save without a BOM" advice as «Дом и сад»'s workaround.

**What `notes` has to beat.** Unchanged from baseline-3, minus what the fixes settled: scenario
1 `uses:K2` and the thread C rubric, scenario 2 threads B and C without the conditional hedge,
scenario 3 thread C without hedging. Proposals are served and clean, and nothing that regresses
is tuned away.

**Not comparable any more.** `m1-lite-5` ran on the previous wiki and prompt, so its `notes`,
`notes-agent` and `notes-both` columns cannot be read against this run. Re-run the six-config
matrix before drawing engine conclusions.

## How to read this

Cells are pass rates over repeats: `✓` every repeat passed · `◐` mixed, or partial credit ·
`✗` every repeat failed · `–` nothing decided it (the engine does not serve the check, no
judge ran, or the run stopped first). The fraction counts outright passes, so two partials
read `◐ 0/2`. Scores are counts, never one number: which check failed is the finding.

`learned via` credits a write path with a K item when a memory write it produced repeats at
least 30% of that item's content words. The match is lexical and says only that the
path *wrote* something like the fact; whether the fact reached the merchant is the graded
`uses:`/`recalls:` columns beside it.

## Configs

| config  | engine | read    | write       | agent                | judge                                                      | runs | pass | partial | fail | skipped | USD    | median turn |
| ------- | ------ | ------- | ----------- | -------------------- | ---------------------------------------------------------- | ---- | ---- | ------- | ---- | ------- | ------ | ----------- |
| `naive` | naive  | hydrate | consolidate | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 9    | 222  | 24      | 0    | 27      | 0.9086 | 6.2 s       |
| `none`  | none   | hydrate | consolidate | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 9    | 149  | 29      | 68   | 27      | 0.6199 | 5.9 s       |

## `csv-import-dropped-rows` — CSV import silently drops rows — learn the cause, reuse it later

### Checks

| step                       | check                       | `naive` | `none` |
| -------------------------- | --------------------------- | ------- | ------ |
| `t1-agent`                 | `outcome`                   | ✓ 3/3   | ✓ 3/3  |
| `t1-agent`                 | `reply.must_not[0]`         | ✓ 3/3   | ✓ 3/3  |
| `t1-agent`                 | `escalation.reason_must[0]` | ✓ 3/3   | ✓ 3/3  |
| `t1-agent`                 | `reply.rubric`              | ✓ 3/3   | ✓ 3/3  |
| `t2-agent`                 | `outcome`                   | ✓ 3/3   | ✓ 3/3  |
| `t2-agent`                 | `reply.must[0]`             | ✓ 3/3   | ✗ 0/3  |
| `t2-agent`                 | `uses:K3`                   | ◐ 2/3   | ✗ 0/3  |
| `t2-agent`                 | `reply.rubric`              | ◐ 2/3   | ✗ 0/3  |
| `t3-agent`                 | `outcome`                   | ✓ 3/3   | ✓ 3/3  |
| `t3-agent`                 | `reply.must[0]`             | ✓ 3/3   | ✓ 3/3  |
| `t3-agent`                 | `reply.must[1]`             | ✓ 3/3   | ✓ 3/3  |
| `t3-agent`                 | `uses:K1`                   | ◐ 0/3   | ◐ 0/3  |
| `t3-agent`                 | `uses:K2`                   | ◐ 2/3   | ✗ 0/3  |
| `t3-agent`                 | `uses:K5`                   | ✓ 3/3   | ◐ 0/3  |
| `t3-agent`                 | `must_not_use:K3`           | ✓ 3/3   | ✓ 3/3  |
| `t3-agent`                 | `reply.rubric`              | ◐ 2/3   | ◐ 0/3  |
| `t4-agent`                 | `outcome`                   | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                 | `reply.must_not[0]`         | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                 | `reply.must_not[1]`         | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                 | `must_not_use:K1`           | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                 | `must_not_use:K4`           | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                 | `reply.rubric`              | ✓ 3/3   | ✓ 3/3  |
| `t5-agent`                 | `outcome`                   | ✓ 3/3   | ✓ 3/3  |
| `t5-agent`                 | `reply.must[0]`             | ✓ 3/3   | ✓ 3/3  |
| `t5-agent`                 | `reply.must_not[0]`         | ✓ 3/3   | ✓ 3/3  |
| `t5-agent`                 | `reply.must_not[1]`         | ✓ 3/3   | ✓ 3/3  |
| `t5-agent`                 | `uses:K2`                   | ◐ 1/3   | ◐ 1/3  |
| `t5-agent`                 | `must_not_use:K1`           | ◐ 2/3   | ◐ 1/3  |
| `t5-agent`                 | `must_not_use:K4`           | ✓ 3/3   | ✓ 3/3  |
| `t5-agent`                 | `reply.rubric`              | ✓ 3/3   | ✓ 3/3  |
| `recall-dom-i-sad`         | `recalls:K1`                | ✓ 3/3   | ✗ 0/3  |
| `recall-dom-i-sad`         | `recalls:K2`                | ✓ 3/3   | ✗ 0/3  |
| `isolation-velo-dvor`      | `must_not_recall:K1`        | ✓ 3/3   | ✓ 3/3  |
| `isolation-velo-dvor`      | `must_not_recall:K4`        | ✓ 3/3   | ✓ 3/3  |
| `documentation-candidates` | `must_not[0]`               | –       | –      |
| `documentation-candidates` | `must_not[1]`               | –       | –      |
| `documentation-candidates` | `proposes:K2`               | –       | –      |

### Knowledge

| K   | kind         | about     | scope    | learned via | `naive` | `none` |
| --- | ------------ | --------- | -------- | ----------- | ------- | ------ |
| K1  | personal     | dom_i_sad | customer | consolidate | ◐ 3/6   | ◐ 0/6  |
| K2  | undocumented | product   | customer | consolidate | ◐ 6/12  | ◐ 1/12 |
| K3  | temporal     | dom_i_sad | customer | consolidate | ◐ 2/3   | ✗ 0/3  |
| K4  | personal     | dom_i_sad | customer | consolidate | –       | –      |
| K5  | undocumented | product   | customer | consolidate | ✓ 3/3   | ◐ 0/3  |

## `payment-provider-incident` — Payment provider incident — broadcast via a coach note, relay while it lasts, drop it after

### Checks

| step                          | check                       | `naive` | `none` |
| ----------------------------- | --------------------------- | ------- | ------ |
| `t1-agent`                    | `outcome`                   | ✓ 3/3   | ✓ 3/3  |
| `t1-agent`                    | `reply.must_not[0]`         | ✓ 3/3   | ✓ 3/3  |
| `t1-agent`                    | `escalation.reason_must[0]` | ✓ 3/3   | ✓ 3/3  |
| `t1-agent`                    | `reply.rubric`              | ✓ 3/3   | ✓ 3/3  |
| `t2-agent`                    | `outcome`                   | ✓ 3/3   | ✗ 0/3  |
| `t2-agent`                    | `reply.must[0]`             | ✓ 3/3   | ✗ 0/3  |
| `t2-agent`                    | `reply.must[1]`             | ✓ 3/3   | ✗ 0/3  |
| `t2-agent`                    | `reply.must_not[0]`         | ✓ 3/3   | ✓ 3/3  |
| `t2-agent`                    | `reply.must_not[1]`         | ✓ 3/3   | ✓ 3/3  |
| `t2-agent`                    | `reply.must_not[2]`         | ✓ 3/3   | ✓ 3/3  |
| `t2-agent`                    | `uses:K1`                   | ✓ 3/3   | ◐ 0/3  |
| `t2-agent`                    | `must_not_use:K2`           | ✓ 3/3   | ✓ 3/3  |
| `t2-agent`                    | `reply.rubric`              | ✓ 3/3   | ◐ 0/3  |
| `t3-agent`                    | `outcome`                   | ✓ 3/3   | ✗ 0/3  |
| `t3-agent`                    | `must_not_use:K1`           | ✓ 3/3   | ◐ 2/3  |
| `t3-agent`                    | `reply.rubric`              | ◐ 0/3   | ✗ 0/3  |
| `t4-agent`                    | `outcome`                   | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                    | `reply.must[0]`             | ✓ 3/3   | ✗ 0/3  |
| `t4-agent`                    | `uses:K2`                   | ◐ 0/3   | ◐ 0/3  |
| `t4-agent`                    | `must_not_use:K1`           | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                    | `reply.rubric`              | ✓ 3/3   | ◐ 0/3  |
| `recall-lavanda`              | `recalls:K1`                | ✓ 3/3   | ✗ 0/3  |
| `recall-lavanda`              | `must_not_recall:K2`        | ✓ 3/3   | ✓ 3/3  |
| `recall-kofe-tochka`          | `recalls:K1`                | ✓ 3/3   | ✗ 0/3  |
| `recall-kofe-tochka`          | `recalls:K2`                | ✓ 3/3   | ✗ 0/3  |
| `no-documentation-candidates` | `must_not[0]`               | –       | –      |
| `no-documentation-candidates` | `must_not[1]`               | –       | –      |
| `no-documentation-candidates` | `must_not[2]`               | –       | –      |

### Knowledge

| K   | kind     | about       | scope    | learned via | `naive` | `none` |
| --- | -------- | ----------- | -------- | ----------- | ------- | ------ |
| K1  | temporal | product     | shared   | consolidate | ✓ 9/9   | ◐ 0/9  |
| K2  | personal | kofe_tochka | customer | consolidate | ◐ 3/6   | ◐ 0/6  |

## `setup-from-the-question` — Setup mentioned in passing — remember it, answer later tickets without asking again

### Checks

| step                          | check                | `naive` | `none` |
| ----------------------------- | -------------------- | ------- | ------ |
| `t1-agent`                    | `outcome`            | ✓ 3/3   | ✓ 3/3  |
| `t1-agent`                    | `reply.must[0]`      | ✓ 3/3   | ✓ 3/3  |
| `t1-agent`                    | `reply.rubric`       | ✓ 3/3   | ✓ 3/3  |
| `t2-agent`                    | `outcome`            | ✓ 3/3   | ✓ 3/3  |
| `t2-agent`                    | `reply.must[0]`      | ✓ 3/3   | ◐ 1/3  |
| `t2-agent`                    | `reply.must[1]`      | ✓ 3/3   | ◐ 1/3  |
| `t2-agent`                    | `uses:K1`            | ◐ 0/3   | ✗ 0/3  |
| `t2-agent`                    | `reply.rubric`       | ◐ 2/3   | ◐ 0/3  |
| `t3-agent`                    | `outcome`            | ✓ 3/3   | ✓ 3/3  |
| `t3-agent`                    | `reply.must[0]`      | ✓ 3/3   | ✗ 0/3  |
| `t3-agent`                    | `uses:K2`            | ◐ 2/3   | ◐ 0/3  |
| `t3-agent`                    | `reply.rubric`       | ◐ 1/3   | ◐ 0/3  |
| `t4-agent`                    | `outcome`            | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                    | `reply.must_not[0]`  | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                    | `reply.must_not[1]`  | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                    | `reply.must_not[2]`  | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                    | `must_not_use:K1`    | ◐ 2/3   | ✓ 3/3  |
| `t4-agent`                    | `must_not_use:K2`    | ✓ 3/3   | ✓ 3/3  |
| `t4-agent`                    | `reply.rubric`       | ✓ 3/3   | ◐ 2/3  |
| `recall-kofe-tochka`          | `recalls:K1`         | ✓ 3/3   | ✗ 0/3  |
| `recall-kofe-tochka`          | `recalls:K2`         | ✓ 3/3   | ✗ 0/3  |
| `isolation-lavanda`           | `must_not_recall:K1` | ✓ 3/3   | ✓ 3/3  |
| `isolation-lavanda`           | `must_not_recall:K2` | ✓ 3/3   | ✓ 3/3  |
| `no-documentation-candidates` | `must_not[0]`        | –       | –      |
| `no-documentation-candidates` | `must_not[1]`        | –       | –      |
| `no-documentation-candidates` | `must_not[2]`        | –       | –      |

### Knowledge

| K   | kind     | about       | scope    | learned via | `naive` | `none` |
| --- | -------- | ----------- | -------- | ----------- | ------- | ------ |
| K1  | personal | kofe_tochka | customer | consolidate | ◐ 3/6   | ✗ 0/6  |
| K2  | personal | kofe_tochka | customer | consolidate | ◐ 5/6   | ◐ 0/6  |

## Findings

Checks the configs do not agree on.

- `csv-import-dropped-rows` · `t2-agent` · `reply.must[0]` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t2-agent` · `uses:K3` — ◐ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t2-agent` · `reply.rubric` — ◐ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `uses:K2` — ◐ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `uses:K5` — ✓ `naive` · ◐ `none`
- `csv-import-dropped-rows` · `recall-dom-i-sad` · `recalls:K1` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `recall-dom-i-sad` · `recalls:K2` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t2-agent` · `outcome` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t2-agent` · `reply.must[0]` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t2-agent` · `reply.must[1]` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t2-agent` · `uses:K1` — ✓ `naive` · ◐ `none`
- `payment-provider-incident` · `t2-agent` · `reply.rubric` — ✓ `naive` · ◐ `none`
- `payment-provider-incident` · `t3-agent` · `outcome` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t3-agent` · `must_not_use:K1` — ✓ `naive` · ◐ `none`
- `payment-provider-incident` · `t3-agent` · `reply.rubric` — ◐ `naive` · ✗ `none`
- `payment-provider-incident` · `t4-agent` · `reply.must[0]` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t4-agent` · `reply.rubric` — ✓ `naive` · ◐ `none`
- `payment-provider-incident` · `recall-lavanda` · `recalls:K1` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `recall-kofe-tochka` · `recalls:K1` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `recall-kofe-tochka` · `recalls:K2` — ✓ `naive` · ✗ `none`
- `setup-from-the-question` · `t2-agent` · `reply.must[0]` — ✓ `naive` · ◐ `none`
- `setup-from-the-question` · `t2-agent` · `reply.must[1]` — ✓ `naive` · ◐ `none`
- `setup-from-the-question` · `t2-agent` · `uses:K1` — ◐ `naive` · ✗ `none`
- `setup-from-the-question` · `t3-agent` · `reply.must[0]` — ✓ `naive` · ✗ `none`
- `setup-from-the-question` · `t4-agent` · `must_not_use:K1` — ✓ `none` · ◐ `naive`
- `setup-from-the-question` · `t4-agent` · `reply.rubric` — ✓ `naive` · ◐ `none`
- `setup-from-the-question` · `recall-kofe-tochka` · `recalls:K1` — ✓ `naive` · ✗ `none`
- `setup-from-the-question` · `recall-kofe-tochka` · `recalls:K2` — ✓ `naive` · ✗ `none`
