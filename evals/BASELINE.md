# Eval report — `baseline-3`

Generated 2026-09-04T10:05:41.976Z from 6 result files: 3 scenarios × 2 configs × 1 repeat.

## Baseline notes

The floor and the bar for every engine in T3: `none` is what the wiki alone gives, `naive` is
what stuffing whole transcripts into the prompt gives. Three scenarios × {`none`, `naive`} ×
1 repeat, judge on the OpenAI fallback (no Anthropic key yet; see the judge column). Supersedes
`baseline-2`, which covered scenario 1 only and predates the judge calibration.

**Judge calibration.** First run with the calibrated fact judge (evals/README §4): `pass` is
about the substance of a statement, not every clause; generic or both-cases text does not
convey a personal fact; a `temporal` item on an agent turn counts as used only when asserted
as currently in force. Scenario 2's K1/K2 were trimmed to what the merchant actually said, and
its thread B/C rubrics now name the conditional both-modes answer as `partial`.

**Replayed agent turns.** `LLM_CACHE=1` replayed every agent turn from `baseline-2`
(scenario 1) and the 2026-09-04 smoke run of scenarios 2–3: identical replies, so every
verdict change against those runs is the judge or the scenario text, never the agent. The
latency column is replay time, not model latency. The USD column is the recorded agent cost
plus the real judge cost; this run actually spent $0.26 on the judge.

**What the calibration changed** (same replies, re-judged):

- `naive`: `uses:K3` before the release and `must_not_use:K3` after it (scenario 1),
  `uses:K1` during the incident and `must_not_use:K1` after it (scenario 3),
  `must_not_use:K1` on the other merchant and both `recalls:` probes (scenario 2) went from
  `partial` to `pass`. These were the false partials: complete replies docked for clauses they
  did not repeat, past-tense mentions read as current, a both-modes answer read as a leak.
- `none`: `uses:K1` on scenario 2's thread B and `uses:K2` on scenario 3's thread D went from
  `partial` to `fail`: a conditional rule from the wiki and an echo of the merchant's own
  message no longer count as conveying a fact. `must_not_use:K1` on scenario 2's thread D went
  to `pass` for the same reason. Scenario 2's thread C rubric went from `fail` to `partial`, as
  the new rubric defines "asks the merchant to check their zones".
- One flip the other way: scenario 1, `naive`, thread B rubric `pass` → `partial` on an
  identical reply ("does not identify this as the known issue from the earlier ticket"). The
  rubric prompt did not change; this is judge variance on a rubric, what `--repeat` exists to
  expose.

**Leak rule.** No `uses:` check passes under `none` in any scenario before its `wiki_update`.
The only `uses:` partial under `none` (scenario 3, thread B) is the reply repeating the
merchant's own "cards declined since noon": an echo, not a leak. T1.6 should count only `pass`
as a leak and list partials with the judge's reason.

**Reading per scenario.**

- Scenario 1 (`csv-import-dropped-rows`): `naive` lands the same-customer `uses:` but fails
  `uses:K2` on thread C (says products are matched by sku, contradicting the learned cause) and
  serves no proposals; `none` fails everything before the `wiki_update` and reaches K2 from the
  wiki after it (◐).
- Scenario 2 (`setup-from-the-question`): thread B now separates on `uses:K1` (`none` ✗,
  `naive` ◐) but not on the rubric: both hedge with a conditional both-modes answer, `naive`
  even with the transcript in the prompt. Thread C: `naive` names Томская область, but
  conditionally («если у вас по-прежнему настроена…»). Hedging with memory present is the
  standing finding.
- Scenario 3 (`payment-provider-incident`): the shared coach note reaches «Лаванда» during the
  incident (`naive` ✓ on outcome, QR and 18:00) and «Кофе-точка»'s orders do not leak; after
  `valid_until` `naive` hedges («подтверждения нет, проверьте баннер»), which the rubric scores
  `partial`; thread D surfaces order 1153 only with memory.

**What `notes` has to beat (T3.1, M1-lite).** Scenario 1: `uses:K2` and the thread C rubric.
Scenario 2: threads B and C without the conditional hedge. Scenario 3: thread C without
hedging. Every isolation check and every `must_not_use` stays ✓, `documentation-candidates`
is served and clean, and nothing that regresses is tuned away.

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
| `naive` | naive  | hydrate | consolidate | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 3    | 70   | 11      | 1    | 9       | 0.3038 | 3 ms        |
| `none`  | none   | hydrate | consolidate | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 3    | 49   | 6       | 27   | 9       | 0.2227 | 4 ms        |

## `csv-import-dropped-rows` — CSV import silently drops rows — learn the cause, reuse it later

### Checks

| step                       | check                       | `naive` | `none` |
| -------------------------- | --------------------------- | ------- | ------ |
| `t1-agent`                 | `outcome`                   | ✓       | ✓      |
| `t1-agent`                 | `reply.must_not[0]`         | ✓       | ✓      |
| `t1-agent`                 | `escalation.reason_must[0]` | ✓       | ✓      |
| `t1-agent`                 | `reply.rubric`              | ✓       | ✓      |
| `t2-agent`                 | `outcome`                   | ✓       | ◐      |
| `t2-agent`                 | `reply.must[0]`             | ✓       | ✗      |
| `t2-agent`                 | `uses:K3`                   | ✓       | ✗      |
| `t2-agent`                 | `reply.rubric`              | ◐       | ✗      |
| `t3-agent`                 | `outcome`                   | ✓       | ✗      |
| `t3-agent`                 | `reply.must[0]`             | ✓       | ✓      |
| `t3-agent`                 | `reply.must[1]`             | ✓       | ✗      |
| `t3-agent`                 | `uses:K1`                   | ◐       | ✗      |
| `t3-agent`                 | `uses:K2`                   | ✗       | ✗      |
| `t3-agent`                 | `uses:K5`                   | ◐       | ✗      |
| `t3-agent`                 | `must_not_use:K3`           | ✓       | ✓      |
| `t3-agent`                 | `reply.rubric`              | ◐       | ✗      |
| `t4-agent`                 | `outcome`                   | ✓       | ✓      |
| `t4-agent`                 | `reply.must_not[0]`         | ✓       | ✓      |
| `t4-agent`                 | `reply.must_not[1]`         | ✓       | ✓      |
| `t4-agent`                 | `must_not_use:K1`           | ✓       | ✓      |
| `t4-agent`                 | `must_not_use:K4`           | ✓       | ✓      |
| `t4-agent`                 | `reply.rubric`              | ✓       | ✓      |
| `t5-agent`                 | `outcome`                   | ✓       | ✓      |
| `t5-agent`                 | `reply.must[0]`             | ✓       | ✓      |
| `t5-agent`                 | `reply.must_not[0]`         | ✓       | ✓      |
| `t5-agent`                 | `reply.must_not[1]`         | ✓       | ✓      |
| `t5-agent`                 | `uses:K2`                   | ◐       | ◐      |
| `t5-agent`                 | `must_not_use:K1`           | ✓       | ✓      |
| `t5-agent`                 | `must_not_use:K4`           | ✓       | ✓      |
| `t5-agent`                 | `reply.rubric`              | ✓       | ✓      |
| `recall-dom-i-sad`         | `recalls:K1`                | ✓       | ✗      |
| `recall-dom-i-sad`         | `recalls:K2`                | ✓       | ✗      |
| `isolation-velo-dvor`      | `must_not_recall:K1`        | ✓       | ✓      |
| `isolation-velo-dvor`      | `must_not_recall:K4`        | ✓       | ✓      |
| `documentation-candidates` | `must_not[0]`               | –       | –      |
| `documentation-candidates` | `must_not[1]`               | –       | –      |
| `documentation-candidates` | `proposes:K2`               | –       | –      |

### Knowledge

| K   | kind         | about     | scope    | learned via | `naive` | `none` |
| --- | ------------ | --------- | -------- | ----------- | ------- | ------ |
| K1  | personal     | dom_i_sad | customer | consolidate | ◐       | ✗      |
| K2  | undocumented | product   | customer | consolidate | ◐       | ◐      |
| K3  | temporal     | dom_i_sad | customer | consolidate | ✓       | ✗      |
| K4  | personal     | dom_i_sad | customer | consolidate | –       | –      |
| K5  | undocumented | product   | customer | consolidate | ◐       | ✗      |

## `payment-provider-incident` — Payment provider incident — broadcast via a coach note, relay while it lasts, drop it after

### Checks

| step                          | check                       | `naive` | `none` |
| ----------------------------- | --------------------------- | ------- | ------ |
| `t1-agent`                    | `outcome`                   | ✓       | ✓      |
| `t1-agent`                    | `reply.must_not[0]`         | ✓       | ✓      |
| `t1-agent`                    | `escalation.reason_must[0]` | ✓       | ✓      |
| `t1-agent`                    | `reply.rubric`              | ✓       | ✓      |
| `t2-agent`                    | `outcome`                   | ✓       | ✗      |
| `t2-agent`                    | `reply.must[0]`             | ✓       | ✗      |
| `t2-agent`                    | `reply.must[1]`             | ✓       | ✗      |
| `t2-agent`                    | `reply.must_not[0]`         | ✓       | ✓      |
| `t2-agent`                    | `reply.must_not[1]`         | ✓       | ✓      |
| `t2-agent`                    | `reply.must_not[2]`         | ✓       | ✓      |
| `t2-agent`                    | `uses:K1`                   | ✓       | ◐      |
| `t2-agent`                    | `must_not_use:K2`           | ✓       | ✓      |
| `t2-agent`                    | `reply.rubric`              | ✓       | ✗      |
| `t3-agent`                    | `outcome`                   | ✓       | ✗      |
| `t3-agent`                    | `must_not_use:K1`           | ✓       | ✓      |
| `t3-agent`                    | `reply.rubric`              | ◐       | ✗      |
| `t4-agent`                    | `outcome`                   | ✓       | ✓      |
| `t4-agent`                    | `reply.must[0]`             | ✓       | ✗      |
| `t4-agent`                    | `uses:K2`                   | ◐       | ✗      |
| `t4-agent`                    | `must_not_use:K1`           | ✓       | ✓      |
| `t4-agent`                    | `reply.rubric`              | ✓       | ◐      |
| `recall-lavanda`              | `recalls:K1`                | ✓       | ✗      |
| `recall-lavanda`              | `must_not_recall:K2`        | ✓       | ✓      |
| `recall-kofe-tochka`          | `recalls:K1`                | ✓       | ✗      |
| `recall-kofe-tochka`          | `recalls:K2`                | ✓       | ✗      |
| `no-documentation-candidates` | `must_not[0]`               | –       | –      |
| `no-documentation-candidates` | `must_not[1]`               | –       | –      |
| `no-documentation-candidates` | `must_not[2]`               | –       | –      |

### Knowledge

| K   | kind     | about       | scope    | learned via | `naive` | `none` |
| --- | -------- | ----------- | -------- | ----------- | ------- | ------ |
| K1  | temporal | product     | shared   | consolidate | ✓       | ◐      |
| K2  | personal | kofe_tochka | customer | consolidate | ◐       | ✗      |

## `setup-from-the-question` — Setup mentioned in passing — remember it, answer later tickets without asking again

### Checks

| step                          | check                | `naive` | `none` |
| ----------------------------- | -------------------- | ------- | ------ |
| `t1-agent`                    | `outcome`            | ✓       | ✓      |
| `t1-agent`                    | `reply.must[0]`      | ✓       | ✓      |
| `t1-agent`                    | `reply.rubric`       | ✓       | ✓      |
| `t2-agent`                    | `outcome`            | ✓       | ✓      |
| `t2-agent`                    | `reply.must[0]`      | ✓       | ✓      |
| `t2-agent`                    | `reply.must[1]`      | ✓       | ✓      |
| `t2-agent`                    | `uses:K1`            | ◐       | ✗      |
| `t2-agent`                    | `reply.rubric`       | ◐       | ◐      |
| `t3-agent`                    | `outcome`            | ✓       | ✓      |
| `t3-agent`                    | `reply.must[0]`      | ✓       | ✗      |
| `t3-agent`                    | `uses:K2`            | ◐       | ✗      |
| `t3-agent`                    | `reply.rubric`       | ◐       | ◐      |
| `t4-agent`                    | `outcome`            | ✓       | ✓      |
| `t4-agent`                    | `reply.must_not[0]`  | ✓       | ✓      |
| `t4-agent`                    | `reply.must_not[1]`  | ✓       | ✓      |
| `t4-agent`                    | `reply.must_not[2]`  | ✓       | ✓      |
| `t4-agent`                    | `must_not_use:K1`    | ✓       | ✓      |
| `t4-agent`                    | `must_not_use:K2`    | ✓       | ✓      |
| `t4-agent`                    | `reply.rubric`       | ✓       | ✓      |
| `recall-kofe-tochka`          | `recalls:K1`         | ✓       | ✗      |
| `recall-kofe-tochka`          | `recalls:K2`         | ✓       | ✗      |
| `isolation-lavanda`           | `must_not_recall:K1` | ✓       | ✓      |
| `isolation-lavanda`           | `must_not_recall:K2` | ✓       | ✓      |
| `no-documentation-candidates` | `must_not[0]`        | –       | –      |
| `no-documentation-candidates` | `must_not[1]`        | –       | –      |
| `no-documentation-candidates` | `must_not[2]`        | –       | –      |

### Knowledge

| K   | kind     | about       | scope    | learned via | `naive` | `none` |
| --- | -------- | ----------- | -------- | ----------- | ------- | ------ |
| K1  | personal | kofe_tochka | customer | consolidate | ◐       | ✗      |
| K2  | personal | kofe_tochka | customer | consolidate | ◐       | ✗      |

## Findings

Checks the configs do not agree on.

- `csv-import-dropped-rows` · `t2-agent` · `outcome` — ✓ `naive` · ◐ `none`
- `csv-import-dropped-rows` · `t2-agent` · `reply.must[0]` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t2-agent` · `uses:K3` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t2-agent` · `reply.rubric` — ◐ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `outcome` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `reply.must[1]` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `uses:K1` — ◐ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `uses:K5` — ◐ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `reply.rubric` — ◐ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `recall-dom-i-sad` · `recalls:K1` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `recall-dom-i-sad` · `recalls:K2` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t2-agent` · `outcome` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t2-agent` · `reply.must[0]` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t2-agent` · `reply.must[1]` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t2-agent` · `uses:K1` — ✓ `naive` · ◐ `none`
- `payment-provider-incident` · `t2-agent` · `reply.rubric` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t3-agent` · `outcome` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t3-agent` · `reply.rubric` — ◐ `naive` · ✗ `none`
- `payment-provider-incident` · `t4-agent` · `reply.must[0]` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `t4-agent` · `uses:K2` — ◐ `naive` · ✗ `none`
- `payment-provider-incident` · `t4-agent` · `reply.rubric` — ✓ `naive` · ◐ `none`
- `payment-provider-incident` · `recall-lavanda` · `recalls:K1` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `recall-kofe-tochka` · `recalls:K1` — ✓ `naive` · ✗ `none`
- `payment-provider-incident` · `recall-kofe-tochka` · `recalls:K2` — ✓ `naive` · ✗ `none`
- `setup-from-the-question` · `t2-agent` · `uses:K1` — ◐ `naive` · ✗ `none`
- `setup-from-the-question` · `t3-agent` · `reply.must[0]` — ✓ `naive` · ✗ `none`
- `setup-from-the-question` · `t3-agent` · `uses:K2` — ◐ `naive` · ✗ `none`
- `setup-from-the-question` · `recall-kofe-tochka` · `recalls:K1` — ✓ `naive` · ✗ `none`
- `setup-from-the-question` · `recall-kofe-tochka` · `recalls:K2` — ✓ `naive` · ✗ `none`
