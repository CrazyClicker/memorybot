# Eval report — `offline-format-preview`

> **SYNTHETIC FORMAT PREVIEW — NOT EVAL RESULTS.** Replies are scripted; no agent or judge model was called. LLM judgments are skipped; empty-memory checks can still be decided deterministically. Zero costs/timings are fixture values and do not measure performance. JSON filenames below illustrate the layout; these preview runs were not saved as result files.

Generated 2026-09-05T12:00:00Z from 2 result files: 1 scenario × 2 configs × 1 repeat.

## How to read this

Cells are pass rates over repeats: `✓` every repeat passed · `◐` mixed, partial or incomplete ·
`✗` every repeat failed · `–` nothing decided it (the engine does not serve the check, no
judge ran, or the run stopped first). The fraction counts outright passes, so two partials
read `◐ 0/2`. Scores are counts, never one number: which check failed is the finding.

`Write evidence by config` credits a path when a recorded memory write repeats at
least 30% of that item's content words. The match is lexical and says only that the
path *wrote* something like the fact at any time in the run; whether it reached the merchant is in the graded
`uses:`/`recalls:` columns beside it.

## Configs

| config  | engine | read    | write       | agent                | judge                                 | runs | pass | partial | fail | skipped | observed USD | median agent loop |
| ------- | ------ | ------- | ----------- | -------------------- | ------------------------------------- | ---- | ---- | ------- | ---- | ------- | ------------ | ----------------- |
| `none`  | none   | hydrate | consolidate | openai:gpt-5.6-terra | anthropic:claude-sonnet-5 (never ran) | 1    | 6    | 0       | 3    | 4       | 0            | 0 ms              |
| `naive` | naive  | hydrate | consolidate | openai:gpt-5.6-terra | anthropic:claude-sonnet-5 (never ran) | 1    | 8    | 0       | 0    | 5       | 0            | 0 ms              |

## Experimental limits

- Only present result files are represented. Verify the displayed scenario/config coverage against the run plan, including configs that never started.
- Saved definitions freeze scenario and config, not the source code or wiki. Archive the code revision, wiki and lockfile alongside the run before comparing environments.
- Scope isolation includes adapter boundaries and runner filtering; it is not an independent test of provider access control.
- A few repeats on fixed stories show observed variability, not generalization or a statistically established winner.
- Hypothesis conclusions require manual review of controls, paired checks and costs. Lexical write matches are clues, not causal attribution.

## Common checks and capabilities

7 agent check rows have at least one decided observation in every displayed config.
This is a matched subset; excluded or missing checks remain visible in the scenario tables.
Probe checks include optional capabilities such as proposals and are shown separately, not added to the common score.

| config  | common agent checks                                 | all probe checks (capabilities vary)                |
| ------- | --------------------------------------------------- | --------------------------------------------------- |
| `none`  | 5 pass / 0 partial / 2 fail / 0 skipped / 0 missing | 1 pass / 0 partial / 1 fail / 0 skipped / 0 missing |
| `naive` | 7 pass / 0 partial / 0 fail / 0 skipped / 0 missing | 1 pass / 0 partial / 0 fail / 1 skipped / 0 missing |

## Cost and response measurements

Recorded completed work only. Judge USD is evaluation overhead, not serving cost.
Response latency includes initial hydration and the agent loop (including tool recall), excludes judging and subsequent persistence.
Recall tokens sum the returned memory across reads per turn, estimated as UTF-8 bytes / 4; this is not total model input usage.
Unknown internal memory spend must not be read as zero. Errors can leave even observable spend unrecorded.

| config  | agent USD | judge USD | memory internal USD | median response  | recall tokens median / max (estimated) |
| ------- | --------- | --------- | ------------------- | ---------------- | -------------------------------------- |
| `none`  | 0.0000    | 0.0000    | 0.0000              | 0 ms (3/3 turns) | 0 / 0 (3/3 turns)                      |
| `naive` | 0.0000    | 0.0000    | 0.0000              | 0 ms (3/3 turns) | 0 / 288 (3/3 turns)                    |

## `human-reply-only` — Learn a completed manual repair only from the operator's public reply

### Checks

| step             | check                | `none` | `naive` |
| ---------------- | -------------------- | ------ | ------- |
| `initial-agent`  | `outcome`            | ✓      | ✓       |
| `initial-agent`  | `reply.must_not[0]`  | ✓      | ✓       |
| `followup-agent` | `outcome`            | ✓      | ✓       |
| `followup-agent` | `reply.must[0]`      | ✗      | ✓       |
| `followup-agent` | `reply.must[1]`      | ✗      | ✓       |
| `followup-agent` | `uses:K1`            | –      | –       |
| `followup-agent` | `reply.rubric`       | –      | –       |
| `other-agent`    | `outcome`            | ✓      | ✓       |
| `other-agent`    | `reply.must_not[0]`  | ✓      | ✓       |
| `other-agent`    | `must_not_use:K1`    | –      | –       |
| `other-agent`    | `reply.rubric`       | –      | –       |
| `recall-repair`  | `recalls:K1`         | ✗      | –       |
| `isolation`      | `must_not_recall:K1` | ✓      | ✓       |

### Hypotheses

**operator-reply-learning.** Conversation consolidation preserves a repair described only in a human reply after handoff.

Comparison: Compare consolidate and both against agent within the same engine, plus none as control.

Decision rule: Require the repair details on a new ticket and in recall, with isolation intact. Agent-only has no observation opportunity after handoff; its gap is a workflow limitation, not an extraction failure.

| evidence                       | `none`                                              | `naive`                                             |
| ------------------------------ | --------------------------------------------------- | --------------------------------------------------- |
| `followup-agent/uses:K1`       | 0 pass / 0 partial / 0 fail / 1 skipped / 0 missing | 0 pass / 0 partial / 0 fail / 1 skipped / 0 missing |
| `followup-agent/reply.rubric`  | 0 pass / 0 partial / 0 fail / 1 skipped / 0 missing | 0 pass / 0 partial / 0 fail / 1 skipped / 0 missing |
| `recall-repair/recalls:K1`     | 0 pass / 0 partial / 1 fail / 0 skipped / 0 missing | 0 pass / 0 partial / 0 fail / 1 skipped / 0 missing |
| `isolation/must_not_recall:K1` | 1 pass / 0 partial / 0 fail / 0 skipped / 0 missing | 1 pass / 0 partial / 0 fail / 0 skipped / 0 missing |

Conclusion: **review pending** — record supported / not supported / insufficient evidence with result references.


### Knowledge

| K   | kind     | about   | scope    | `none` | `naive` |
| --- | -------- | ------- | -------- | ------ | ------- |
| K1  | personal | lavanda | customer | ◐      | –       |

### Write evidence by config

| K   | `none`           | `naive`     |
| --- | ---------------- | ----------- |
| K1  | no lexical match | consolidate |

## Review queue

Audit these partial/failed turns before attributing a difference to memory. Use the named JSON under the run directory:
consolidations and memoryWrites → recalls (exact prompt/tool payload) → reply → judgePrompt.
An end-of-scenario probe is a different query at a different time, not proof of what this turn saw.
Classify manually as write/extraction, retrieval, application, judge, integration, or unknown; multiple causes may apply.

| result / turn                                     | checks to review                                                                                               | returned memory ids | reply excerpt                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `human-reply-only.none.1.json` / `followup-agent` | reply.must[0]: fail (the reply does not match /23/); reply.must[1]: fail (the reply does not match /резервн/i) | empty               | В этом примере история ремонта недоступна. Нужны подробности предыдущего обращения. |

## Decision record

Manual review required. For each hypothesis record supported / not supported / insufficient evidence,
the compared configs, exact result and check references, and any remaining confound.
Then record the engine and write path selected for the next milestone, its cost tradeoff,
and the observation that would change that decision. Do not infer a winner from total passes.

## Findings

Checks the configs do not agree on.

- `human-reply-only` · `followup-agent` · `reply.must[0]` — ✓ `naive` · ✗ `none`
- `human-reply-only` · `followup-agent` · `reply.must[1]` — ✓ `naive` · ✗ `none`
