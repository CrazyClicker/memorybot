# Eval report — `baseline-2`

Generated 2026-09-04T08:38:46.407Z from 2 result files: 1 scenario × 2 configs × 1 repeat.

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
| `naive` | naive  | hydrate | consolidate | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 1    | 27   | 6       | 1    | 3       | 0.1228 | 2 ms        |
| `none`  | none   | hydrate | consolidate | openai:gpt-5.6-terra | openai:gpt-5.6-sol (configured: anthropic:claude-sonnet-5) | 1    | 21   | 2       | 11   | 3       | 0.0852 | 3 ms        |

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
| `t2-agent`                 | `uses:K3`                   | ◐       | ✗      |
| `t2-agent`                 | `reply.rubric`              | ✓       | ✗      |
| `t3-agent`                 | `outcome`                   | ✓       | ✗      |
| `t3-agent`                 | `reply.must[0]`             | ✓       | ✓      |
| `t3-agent`                 | `reply.must[1]`             | ✓       | ✗      |
| `t3-agent`                 | `uses:K1`                   | ◐       | ✗      |
| `t3-agent`                 | `uses:K2`                   | ✗       | ✗      |
| `t3-agent`                 | `uses:K5`                   | ◐       | ✗      |
| `t3-agent`                 | `must_not_use:K3`           | ◐       | ✓      |
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
| K3  | temporal     | dom_i_sad | customer | consolidate | ◐       | ✗      |
| K4  | personal     | dom_i_sad | customer | consolidate | –       | –      |
| K5  | undocumented | product   | customer | consolidate | ◐       | ✗      |

## Findings

Checks the configs do not agree on.

- `csv-import-dropped-rows` · `t2-agent` · `outcome` — ✓ `naive` · ◐ `none`
- `csv-import-dropped-rows` · `t2-agent` · `reply.must[0]` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t2-agent` · `uses:K3` — ◐ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t2-agent` · `reply.rubric` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `outcome` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `reply.must[1]` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `uses:K1` — ◐ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `uses:K5` — ◐ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `t3-agent` · `must_not_use:K3` — ✓ `none` · ◐ `naive`
- `csv-import-dropped-rows` · `t3-agent` · `reply.rubric` — ◐ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `recall-dom-i-sad` · `recalls:K1` — ✓ `naive` · ✗ `none`
- `csv-import-dropped-rows` · `recall-dom-i-sad` · `recalls:K2` — ✓ `naive` · ✗ `none`
