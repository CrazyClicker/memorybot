# Eval report — `m1-lite-5`

Generated 2026-09-04T13:31:06.198Z from 54 result files: 3 scenarios × 6 configs × 3 repeats.

## Checkpoint notes

The T3.1 checkpoint: three scenarios × {`none`, `naive`, `naive-agent`, `notes`, `notes-agent`,
`notes-both`} × 3 repeats with the LLM disk cache off, so every repeat is a fresh sample
(`pnpm eval run` now refuses cached repeats). Judge on the OpenAI fallback: no Anthropic key
yet, agent and judge share a vendor. Recorded cost $5.42, extraction included. Supersedes
`m1-lite-4`, whose repeats were cache replays and whose `uses:K2` dispute the judge rule below
settles. The engine's prompts were developed on scenario 1; scenarios 2 and 3 were run as
acceptance without tuning against them.

**What holds up.** `notes` and `naive` are level on the checks both can serve (`notes` has 27
more decided checks because it serves proposals); the difference is *where*, not how much:

- Scenario 2 thread C: `notes` states the merchant's delivery setup as known (`uses:K2` and the
  rubric 3/3) where `naive` hedges («если у вас по-прежнему настроена…», 1/3 and 1/3).
- Scenario 1 thread C: the rubric is ✓ 2/3 for `notes` and 3/3 for `notes-agent` against 1/3 for
  `naive`; `uses:K2` 3/3 for `notes-agent`, 2/3 for `notes`, 1/3 for `naive`. `notes-both` hedges
  the cause («могли обновляться») and lands ◐ 3/3.
- Proposals, served only by `notes`: `proposes:K2` ✓ 8/9 (one hedged «может»), and the two
  "no candidates" probes clean 9/9 — an incident and a merchant's setup are never proposed.
- Isolation and the shared scope: every deterministic `must_not` and every `must_not_recall`
  passes in all 54 runs; the shared incident reaches «Лаванда» 9/9 with memory. The only
  isolation partials are the judge reading shared incident advice («заказы оплатят после
  восстановления») as a fragment of «Кофе-точка»'s private K2.
- Recall: `notes` holds K1 and K2 of every scenario 3/3, except scenario 3's K2 (◐ 2/3: the
  engineer's ownership of case 1153 is sometimes dropped). `notes-agent` never holds
  scenario 1's K1 (◐ 3/3): the export details arrive in a message with no agent turn, and
  `write: agent` consolidates coach notes only — structural, not a bug.
- Cost: `notes` spends less on agent and judge than `naive` (a shorter memory in the prompt)
  and ≈ $0.015 per consolidation on extraction; $0.97 against $0.88 over nine runs.

**What fails for every engine.** Three outcome patterns, visible only with real repeats, that
hide engine differences in the totals:

- Scenario 1 thread D2 (`t5-agent`): 16 of 18 runs escalate, `none` included. P-002 as written
  («импорт, после которого чего-то не хватает… и когда отчёт без ошибок») covers a past import
  the merchant has already fixed; the scenario expects an answer. Track B: P-002 should say a
  *current* loss, or the scenario should tolerate `escalate`.
- Scenario 2 thread B (`t2-agent`): the more the agent knows about the hold, the more often
  P-001 («любые вопросы о списаниях») fires — `none` escalates 0/3 with its generic both-modes
  answer, `naive`, `notes` and `notes-agent` 2/3 each. Knowing K1 turns a workflow question into
  a "money question". Track B: P-001 should separate disputes and charges from how the hold
  works.
- Scenario 3 thread C, after `valid_until` (`t3-agent`): the configs that see an explicit expired
  note escalate «нужно подтвердить актуальный статус» in 5 of 9 `notes` runs (`naive`, whose
  transcript memory carries no expiry flag, answers 3/3 but hedges, ◐ 3/3). The prompt forbids
  asserting an expired note as current and P-006 forbids naming a recovery, so the agent asks;
  the rubric wants "the incident is over". The candidate fix is one prompt clause — after
  `valid_until` the condition is over unless a newer note says otherwise — applied to every
  engine alike.

**Superseded by the Track B fixes (2026-09-04).** All three patterns above were fixed the same
day, in the world and the agent rather than in any scenario: `P-002` now asks whether data is
missing *now*, `P-001` separates money disputes from how payment and the hold work, and the
agent prompt treats a temporal note as over after its `valid_until`. Their effect is measured
in `evals/BASELINE.md` (`baseline-4`, `none` and `naive`) and, for the expiry clause, in the
`payment-provider-incident` × `notes` runs recorded there. The tables below therefore describe
the previous wiki and prompt: the engine comparison stands, the absolute outcome numbers do
not, and the six-config matrix needs a re-run before it is quoted again.

**Extraction.** 6–7 notes per consolidation of scenario 1's thread A with the merchant's export
setup captured 3/3, one merged setup note 3/3 on scenario 2, 4–7 notes on scenario 3 with the
incident as `temporal/shared`. Variance is real: `notes-both` once wrote a single note on
scenario 3 after the agent's own `remember` calls had filled the "known" list. Two of 54 runs
crashed on the extractor's zod schema (a bare timestamp without a timezone); the engine was
hardened — a loose model boundary with per-note acceptance, timestamp normalisation, one retry,
and the runner now records a failed consolidation instead of aborting the run — and those two
cells (`payment-provider-incident` × `notes` and `notes-both`, repeat 1) were rerun on the
hardened engine. The other 52 ran before it; the change touches failure handling only.

**Judge.** The baseline-3 calibration plus one rule from the first M1-lite: a non-temporal fact
told as former behaviour counts as conveyed. Verdict variance shows in the fractions
(`uses:K5` for `notes` reads ✓◐◐ on the same kind of reply); every verdict carries its prompt in
the JSON. `uses:K1` on scenario 1 thread C is ◐ for every memory engine: the reply needs one
clause of K1 and the judge grades the whole statement, so K1 completeness is read off the recall
probe instead.

**Write paths.** `write: agent` learns what the merchant states in passing: on scenario 2
`remember` fired 3/3 (two writes each) and `notes-agent` holds K1 and K2 3/3; on scenario 1 it
cannot learn the export details (no agent turn on that message) and on scenario 3 it wrote 0–2
notes per run. The `learned via` column is aggregated across configs (a T2.7 limitation): read
"agent + consolidate" as "some config's agent wrote it".

**Nudge.** Once in 234 turns the model stopped in plain text without `finish`; the one-message
nudge recovered the turn (scenario 2, `none`, repeat 2, thread A), visible in the trace as a text
step followed by tool steps.

**Next.** Before T3.4: settle the three agent patterns (Track B wording or tolerances, one prompt
clause for expiry), write a fourth scenario after the extractor is frozen as the true hold-out,
and get a second-vendor judge key.

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

| config        | engine | read    | write       | agent                | judge                                                      | runs | pass | partial | fail | skipped | USD    | median turn |
| ------------- | ------ | ------- | ----------- | -------------------- | ---------------------------------------------------------- | ---- | ---- | ------- | ---- | ------- | ------ | ----------- |
| `naive-agent` | naive  | hydrate | agent       | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 9    | 210  | 28      | 8    | 27      | 0.8748 | 7.2 s       |
| `naive`       | naive  | hydrate | consolidate | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 9    | 213  | 25      | 8    | 27      | 0.8820 | 5.8 s       |
| `none`        | none   | hydrate | consolidate | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 9    | 141  | 29      | 76   | 27      | 0.6365 | 6.2 s       |
| `notes-agent` | notes  | hydrate | agent       | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 9    | 240  | 23      | 10   | 0       | 0.9493 | 7.1 s       |
| `notes-both`  | notes  | both    | both        | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 9    | 237  | 26      | 10   | 0       | 1.1113 | 7.7 s       |
| `notes`       | notes  | hydrate | consolidate | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 9    | 240  | 25      | 8    | 0       | 0.9657 | 5.9 s       |

## `csv-import-dropped-rows` — CSV import silently drops rows — learn the cause, reuse it later

### Checks

| step                       | check                       | `naive-agent` | `naive` | `none` | `notes-agent` | `notes-both` | `notes` |
| -------------------------- | --------------------------- | ------------- | ------- | ------ | ------------- | ------------ | ------- |
| `t1-agent`                 | `outcome`                   | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t1-agent`                 | `reply.must_not[0]`         | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t1-agent`                 | `escalation.reason_must[0]` | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t1-agent`                 | `reply.rubric`              | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                 | `outcome`                   | ✓ 3/3         | ✓ 3/3   | ◐ 1/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                 | `reply.must[0]`             | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                 | `uses:K3`                   | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                 | `reply.rubric`              | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ◐ 2/3         | ◐ 1/3        | ◐ 2/3   |
| `t3-agent`                 | `outcome`                   | ✓ 3/3         | ✓ 3/3   | ◐ 2/3  | ✓ 3/3         | ◐ 2/3        | ✓ 3/3   |
| `t3-agent`                 | `reply.must[0]`             | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t3-agent`                 | `reply.must[1]`             | ✓ 3/3         | ✓ 3/3   | ◐ 1/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t3-agent`                 | `uses:K1`                   | ◐ 0/3         | ◐ 0/3   | ◐ 0/3  | ◐ 0/3         | ◐ 0/3        | ◐ 0/3   |
| `t3-agent`                 | `uses:K2`                   | ◐ 2/3         | ◐ 1/3   | ✗ 0/3  | ✓ 3/3         | ◐ 0/3        | ◐ 2/3   |
| `t3-agent`                 | `uses:K5`                   | ✓ 3/3         | ◐ 2/3   | ◐ 0/3  | ◐ 2/3         | ◐ 2/3        | ◐ 1/3   |
| `t3-agent`                 | `must_not_use:K3`           | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t3-agent`                 | `reply.rubric`              | ◐ 0/3         | ◐ 1/3   | ◐ 0/3  | ✓ 3/3         | ◐ 1/3        | ◐ 2/3   |
| `t4-agent`                 | `outcome`                   | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                 | `reply.must_not[0]`         | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                 | `reply.must_not[1]`         | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                 | `must_not_use:K1`           | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                 | `must_not_use:K4`           | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                 | `reply.rubric`              | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t5-agent`                 | `outcome`                   | ✗ 0/3         | ◐ 1/3   | ✗ 0/3  | ✗ 0/3         | ◐ 1/3        | ✗ 0/3   |
| `t5-agent`                 | `reply.must[0]`             | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t5-agent`                 | `reply.must_not[0]`         | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t5-agent`                 | `reply.must_not[1]`         | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t5-agent`                 | `uses:K2`                   | ◐ 1/3         | ◐ 1/3   | ◐ 0/3  | ◐ 0/3         | ◐ 2/3        | ◐ 1/3   |
| `t5-agent`                 | `must_not_use:K1`           | ◐ 1/3         | ✓ 3/3   | ◐ 0/3  | ✓ 3/3         | ✓ 3/3        | ◐ 1/3   |
| `t5-agent`                 | `must_not_use:K4`           | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t5-agent`                 | `reply.rubric`              | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `recall-dom-i-sad`         | `recalls:K1`                | ◐ 0/3         | ✓ 3/3   | ✗ 0/3  | ◐ 0/3         | ◐ 1/3        | ✓ 3/3   |
| `recall-dom-i-sad`         | `recalls:K2`                | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `isolation-velo-dvor`      | `must_not_recall:K1`        | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `isolation-velo-dvor`      | `must_not_recall:K4`        | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `documentation-candidates` | `must_not[0]`               | –             | –       | –      | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `documentation-candidates` | `must_not[1]`               | –             | –       | –      | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `documentation-candidates` | `proposes:K2`               | –             | –       | –      | ✓ 3/3         | ✓ 3/3        | ◐ 2/3   |

### Knowledge

| K   | kind         | about     | scope    | learned via         | `naive-agent` | `naive` | `none` | `notes-agent` | `notes-both` | `notes` |
| --- | ------------ | --------- | -------- | ------------------- | ------------- | ------- | ------ | ------------- | ------------ | ------- |
| K1  | personal     | dom_i_sad | customer | agent + consolidate | ◐ 0/6         | ◐ 3/6   | ◐ 0/6  | ◐ 0/6         | ◐ 1/6        | ◐ 3/6   |
| K2  | undocumented | product   | customer | consolidate         | ◐ 6/12        | ◐ 5/12  | ◐ 0/12 | ◐ 9/12        | ◐ 8/12       | ◐ 8/12  |
| K3  | temporal     | dom_i_sad | customer | consolidate         | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| K4  | personal     | dom_i_sad | customer | agent + consolidate | –             | –       | –      | –             | –            | –       |
| K5  | undocumented | product   | customer | agent + consolidate | ✓ 3/3         | ◐ 2/3   | ◐ 0/3  | ◐ 2/3         | ◐ 2/3        | ◐ 1/3   |

## `payment-provider-incident` — Payment provider incident — broadcast via a coach note, relay while it lasts, drop it after

### Checks

| step                          | check                       | `naive-agent` | `naive` | `none` | `notes-agent` | `notes-both` | `notes` |
| ----------------------------- | --------------------------- | ------------- | ------- | ------ | ------------- | ------------ | ------- |
| `t1-agent`                    | `outcome`                   | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t1-agent`                    | `reply.must_not[0]`         | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t1-agent`                    | `escalation.reason_must[0]` | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t1-agent`                    | `reply.rubric`              | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                    | `outcome`                   | ✓ 3/3         | ✓ 3/3   | ◐ 1/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                    | `reply.must[0]`             | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                    | `reply.must[1]`             | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                    | `reply.must_not[0]`         | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                    | `reply.must_not[1]`         | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                    | `reply.must_not[2]`         | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                    | `uses:K1`                   | ✓ 3/3         | ✓ 3/3   | ◐ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                    | `must_not_use:K2`           | ◐ 1/3         | ✓ 3/3   | ✓ 3/3  | ◐ 2/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                    | `reply.rubric`              | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t3-agent`                    | `outcome`                   | ◐ 2/3         | ✓ 3/3   | ✗ 0/3  | ◐ 1/3         | ◐ 1/3        | ◐ 2/3   |
| `t3-agent`                    | `must_not_use:K1`           | ✓ 3/3         | ✓ 3/3   | ◐ 2/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t3-agent`                    | `reply.rubric`              | ◐ 0/3         | ◐ 0/3   | ✗ 0/3  | ◐ 0/3         | ◐ 0/3        | ◐ 0/3   |
| `t4-agent`                    | `outcome`                   | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                    | `reply.must[0]`             | ◐ 2/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                    | `uses:K2`                   | ◐ 0/3         | ◐ 0/3   | ◐ 0/3  | ◐ 0/3         | ◐ 0/3        | ◐ 0/3   |
| `t4-agent`                    | `must_not_use:K1`           | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                    | `reply.rubric`              | ◐ 2/3         | ◐ 2/3   | ◐ 0/3  | ✓ 3/3         | ✓ 3/3        | ◐ 1/3   |
| `recall-lavanda`              | `recalls:K1`                | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `recall-lavanda`              | `must_not_recall:K2`        | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `recall-kofe-tochka`          | `recalls:K1`                | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `recall-kofe-tochka`          | `recalls:K2`                | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ◐ 2/3        | ◐ 1/3   |
| `no-documentation-candidates` | `must_not[0]`               | –             | –       | –      | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `no-documentation-candidates` | `must_not[1]`               | –             | –       | –      | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `no-documentation-candidates` | `must_not[2]`               | –             | –       | –      | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |

### Knowledge

| K   | kind     | about       | scope    | learned via         | `naive-agent` | `naive` | `none` | `notes-agent` | `notes-both` | `notes` |
| --- | -------- | ----------- | -------- | ------------------- | ------------- | ------- | ------ | ------------- | ------------ | ------- |
| K1  | temporal | product     | shared   | agent + consolidate | ✓ 9/9         | ✓ 9/9   | ◐ 0/9  | ✓ 9/9         | ✓ 9/9        | ✓ 9/9   |
| K2  | personal | kofe_tochka | customer | agent + consolidate | ◐ 3/6         | ◐ 3/6   | ◐ 0/6  | ◐ 3/6         | ◐ 2/6        | ◐ 1/6   |

## `setup-from-the-question` — Setup mentioned in passing — remember it, answer later tickets without asking again

### Checks

| step                          | check                | `naive-agent` | `naive` | `none` | `notes-agent` | `notes-both` | `notes` |
| ----------------------------- | -------------------- | ------------- | ------- | ------ | ------------- | ------------ | ------- |
| `t1-agent`                    | `outcome`            | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t1-agent`                    | `reply.must[0]`      | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t1-agent`                    | `reply.rubric`       | ✓ 3/3         | ◐ 2/3   | ◐ 2/3  | ✓ 3/3         | ◐ 2/3        | ✓ 3/3   |
| `t2-agent`                    | `outcome`            | ◐ 2/3         | ◐ 1/3   | ✓ 3/3  | ◐ 1/3         | ✓ 3/3        | ◐ 1/3   |
| `t2-agent`                    | `reply.must[0]`      | ✓ 3/3         | ◐ 2/3   | ◐ 2/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                    | `reply.must[1]`      | ✓ 3/3         | ◐ 2/3   | ◐ 2/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t2-agent`                    | `uses:K1`            | ◐ 1/3         | ◐ 0/3   | ◐ 0/3  | ◐ 0/3         | ◐ 0/3        | ◐ 0/3   |
| `t2-agent`                    | `reply.rubric`       | ◐ 2/3         | ◐ 1/3   | ◐ 0/3  | ◐ 1/3         | ◐ 1/3        | ◐ 2/3   |
| `t3-agent`                    | `outcome`            | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t3-agent`                    | `reply.must[0]`      | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t3-agent`                    | `uses:K2`            | ✓ 3/3         | ◐ 2/3   | ◐ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t3-agent`                    | `reply.rubric`       | ✓ 3/3         | ◐ 1/3   | ◐ 0/3  | ◐ 2/3         | ◐ 2/3        | ✓ 3/3   |
| `t4-agent`                    | `outcome`            | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                    | `reply.must_not[0]`  | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                    | `reply.must_not[1]`  | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                    | `reply.must_not[2]`  | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                    | `must_not_use:K1`    | ◐ 2/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                    | `must_not_use:K2`    | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `t4-agent`                    | `reply.rubric`       | ◐ 1/3         | ◐ 2/3   | ◐ 2/3  | ◐ 1/3         | ◐ 2/3        | ✓ 3/3   |
| `recall-kofe-tochka`          | `recalls:K1`         | ◐ 2/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ◐ 1/3        | ✓ 3/3   |
| `recall-kofe-tochka`          | `recalls:K2`         | ✓ 3/3         | ✓ 3/3   | ✗ 0/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `isolation-lavanda`           | `must_not_recall:K1` | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `isolation-lavanda`           | `must_not_recall:K2` | ✓ 3/3         | ✓ 3/3   | ✓ 3/3  | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `no-documentation-candidates` | `must_not[0]`        | –             | –       | –      | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `no-documentation-candidates` | `must_not[1]`        | –             | –       | –      | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |
| `no-documentation-candidates` | `must_not[2]`        | –             | –       | –      | ✓ 3/3         | ✓ 3/3        | ✓ 3/3   |

### Knowledge

| K   | kind     | about       | scope    | learned via         | `naive-agent` | `naive` | `none` | `notes-agent` | `notes-both` | `notes` |
| --- | -------- | ----------- | -------- | ------------------- | ------------- | ------- | ------ | ------------- | ------------ | ------- |
| K1  | personal | kofe_tochka | customer | agent + consolidate | ◐ 3/6         | ◐ 3/6   | ◐ 0/6  | ◐ 3/6         | ◐ 1/6        | ◐ 3/6   |
| K2  | personal | kofe_tochka | customer | agent + consolidate | ✓ 6/6         | ◐ 5/6   | ◐ 0/6  | ✓ 6/6         | ✓ 6/6        | ✓ 6/6   |

## Findings

Checks the configs do not agree on.

- `csv-import-dropped-rows` · `t2-agent` · `outcome` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ◐ `none`
- `csv-import-dropped-rows` · `t2-agent` · `reply.must[0]` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `csv-import-dropped-rows` · `t2-agent` · `uses:K3` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `csv-import-dropped-rows` · `t2-agent` · `reply.rubric` — ✓ `naive-agent`, `naive` · ◐ `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `outcome` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes` · ◐ `none`, `notes-both`
- `csv-import-dropped-rows` · `t3-agent` · `reply.must[1]` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ◐ `none`
- `csv-import-dropped-rows` · `t3-agent` · `uses:K2` — ✓ `notes-agent` · ◐ `naive-agent`, `naive`, `notes-both`, `notes` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `uses:K5` — ✓ `naive-agent` · ◐ `naive`, `none`, `notes-agent`, `notes-both`, `notes`
- `csv-import-dropped-rows` · `t3-agent` · `reply.rubric` — ✓ `notes-agent` · ◐ `naive-agent`, `naive`, `none`, `notes-both`, `notes`
- `csv-import-dropped-rows` · `t5-agent` · `outcome` — ◐ `naive`, `notes-both` · ✗ `naive-agent`, `none`, `notes-agent`, `notes`
- `csv-import-dropped-rows` · `t5-agent` · `must_not_use:K1` — ✓ `naive`, `notes-agent`, `notes-both` · ◐ `naive-agent`, `none`, `notes`
- `csv-import-dropped-rows` · `recall-dom-i-sad` · `recalls:K1` — ✓ `naive`, `notes` · ◐ `naive-agent`, `notes-agent`, `notes-both` · ✗ `none`
- `csv-import-dropped-rows` · `recall-dom-i-sad` · `recalls:K2` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `csv-import-dropped-rows` · `documentation-candidates` · `proposes:K2` — ✓ `notes-agent`, `notes-both` · ◐ `notes` · – `naive-agent`, `naive`, `none`
- `payment-provider-incident` · `t2-agent` · `outcome` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ◐ `none`
- `payment-provider-incident` · `t2-agent` · `reply.must[0]` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `payment-provider-incident` · `t2-agent` · `reply.must[1]` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `payment-provider-incident` · `t2-agent` · `uses:K1` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ◐ `none`
- `payment-provider-incident` · `t2-agent` · `must_not_use:K2` — ✓ `naive`, `none`, `notes-both`, `notes` · ◐ `naive-agent`, `notes-agent`
- `payment-provider-incident` · `t2-agent` · `reply.rubric` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `payment-provider-incident` · `t3-agent` · `outcome` — ✓ `naive` · ◐ `naive-agent`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `payment-provider-incident` · `t3-agent` · `must_not_use:K1` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ◐ `none`
- `payment-provider-incident` · `t3-agent` · `reply.rubric` — ◐ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `payment-provider-incident` · `t4-agent` · `reply.must[0]` — ✓ `naive`, `notes-agent`, `notes-both`, `notes` · ◐ `naive-agent` · ✗ `none`
- `payment-provider-incident` · `t4-agent` · `reply.rubric` — ✓ `notes-agent`, `notes-both` · ◐ `naive-agent`, `naive`, `none`, `notes`
- `payment-provider-incident` · `recall-lavanda` · `recalls:K1` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `payment-provider-incident` · `recall-kofe-tochka` · `recalls:K1` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `payment-provider-incident` · `recall-kofe-tochka` · `recalls:K2` — ✓ `naive-agent`, `naive`, `notes-agent` · ◐ `notes-both`, `notes` · ✗ `none`
- `setup-from-the-question` · `t1-agent` · `reply.rubric` — ✓ `naive-agent`, `notes-agent`, `notes` · ◐ `naive`, `none`, `notes-both`
- `setup-from-the-question` · `t2-agent` · `outcome` — ✓ `none`, `notes-both` · ◐ `naive-agent`, `naive`, `notes-agent`, `notes`
- `setup-from-the-question` · `t2-agent` · `reply.must[0]` — ✓ `naive-agent`, `notes-agent`, `notes-both`, `notes` · ◐ `naive`, `none`
- `setup-from-the-question` · `t2-agent` · `reply.must[1]` — ✓ `naive-agent`, `notes-agent`, `notes-both`, `notes` · ◐ `naive`, `none`
- `setup-from-the-question` · `t3-agent` · `reply.must[0]` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
- `setup-from-the-question` · `t3-agent` · `uses:K2` — ✓ `naive-agent`, `notes-agent`, `notes-both`, `notes` · ◐ `naive`, `none`
- `setup-from-the-question` · `t3-agent` · `reply.rubric` — ✓ `naive-agent`, `notes` · ◐ `naive`, `none`, `notes-agent`, `notes-both`
- `setup-from-the-question` · `t4-agent` · `must_not_use:K1` — ✓ `naive`, `none`, `notes-agent`, `notes-both`, `notes` · ◐ `naive-agent`
- `setup-from-the-question` · `t4-agent` · `reply.rubric` — ✓ `notes` · ◐ `naive-agent`, `naive`, `none`, `notes-agent`, `notes-both`
- `setup-from-the-question` · `recall-kofe-tochka` · `recalls:K1` — ✓ `naive`, `notes-agent`, `notes` · ◐ `naive-agent`, `notes-both` · ✗ `none`
- `setup-from-the-question` · `recall-kofe-tochka` · `recalls:K2` — ✓ `naive-agent`, `naive`, `notes-agent`, `notes-both`, `notes` · ✗ `none`
