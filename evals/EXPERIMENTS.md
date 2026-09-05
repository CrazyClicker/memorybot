# Pre-matrix experiment protocol

Prepared 2026-09-05. No paid results are claimed for this revision.
The [report preview](REPORT-PREVIEW.md) uses scripted offline fixtures, not model evaluations.
The [run catalogue](RUNS.md) records runnable suites, purposes, exact selections, call estimates
and a campaign record. `--suite research` runs `controls` + `core` + `stress` (31 pairs per
repeat); `--suite write-paths` is the additional writing-mode comparison (15 pairs).
`--all` covers core stories across all configs, not the main research selection.

## Questions and evidence

Scenario `hypotheses` preregister a claim, comparison, decision rule and exact check references.
They are evaluation metadata only: neither agent nor extractor receives them.

| Question | Scenario / primary evidence | Decision enabled |
| --- | --- | --- |
| Does memory improve later answers? | `setup-from-the-question`: payment and delivery rubrics, specific `uses`, isolation | Whether memory helps beyond `none`; whether `naive` already suffices |
| Does memory preserve the meaning of a conditional technical fact? | `csv-import-dropped-rows`: three branch decisions after consolidation, paired with `controls/csv-rule-source.yaml` | Whether conditions or exceptions are lost in the memory pipeline, provided the agent understands the original explanation |
| Do expiry and confirmation stay distinct? | `payment-provider-incident`: unknown status at `t3-agent`, confirmed restoration at `t5-agent` | Whether temporal handling preserves uncertainty and then uses new evidence |
| Do updates survive old-ticket replay? | `customer-setup-change`: old mode before the change, new mode before and after old-source consolidation | Whether recency reflects fact time rather than ingestion time |
| Is a public operator reply sufficient? | `human-reply-only`: repair details on a later ticket and in recall | Whether conversation extraction covers the handoff gap |
| Are sharing boundaries respected? | Cross-customer turns and probes; CSV before/after human wiki publication | Whether the configured integration isolates private facts and permits approved sharing |
| Does selective recall help beyond the transcript budget? | Opt-in `stress/recall-under-noise.yaml`: old delivery constraint after unrelated catalogue tickets | Whether additional retrieval/compaction complexity buys retention under pressure |

### Technical meaning: source control and three branch decisions

Hypothesis 2 is a fidelity check on a short history. It does not require structured memory
to outperform a strong agent reading the original conversation, or establish cost savings.
The target is the conditional K2 rule learned from `t1-coach-note`:

| Case in the pre-release importer, with Only new selected | Correct decision | Meaning lost by an unsafe simplification |
| --- | --- | --- |
| sku header recognised; sku already exists | Existing product and price are not updated | “The importer always matches by title” drops the condition for that fallback |
| BOM prevents recognising sku header; title matches | Existing product and price are updated despite the mode | “Only new always protects existing products” drops the exception |
| BOM prevents recognising sku header; title does not match | No product is created; row is silently omitted from the report | “Only new creates all new rows” drops the recognition/matching precondition |

The canonical branch ids are `branch-sku-agent`, `branch-name-agent` and `branch-new-agent`.
Each has its own fresh ticket and a `reply.rubric` covering the decision and its explanation.
A standalone yes/no or generic advice to remove BOM is insufficient. A response need not
recite the entire original paragraph or unasked branches. These are decision checks, not
`uses:K2` checks against a compound statement where a fragment might receive misleading credit.
The original compound K2 recall/use checks remain supplementary evidence for the wider story.

First run `controls/csv-rule-source.yaml` with **none**: every question has an exact copy of
the original engineer note in its current thread. It uses the same question text, expectation,
customer and scenario time as the memory case. There is no consolidation or wiki update;
answers to earlier branches are unavailable to later ones. Tests enforce source/question/rubric
parity. The control is outside `--all`, avoiding repeated control work for every memory engine.
Use the same support-agent model, actual judge, wiki and code revision for the paired runs.

Then examine the same branches in the main CSV scenario with `read: hydrate / write: consolidate`.
The engineer's note is absent from each new ticket; it can arrive through recall. There is
no consolidation between these questions, so their answers do not become new learning input.
Other write modes may write during the questions and are a separate workflow experiment.

| Source control | Memory case | Interpretation |
| --- | --- | --- |
| Pass | Pass | No decision-relevant loss observed on this branch; no superiority claim |
| Pass | Partial/fail | Investigate the memory pipeline: inspect the actual recall and written items to distinguish loss, retrieval failure or application/format sensitivity |
| Partial/fail | Any | Cannot attribute this branch to memory loss; audit reasoning, source clarity and judging first |
| Skipped/missing | Any | Insufficient evidence; the prerequisite was not measured |

The normal recognised-sku branch may be inferred from the mode name; it is a sanity check,
not proof of memory use. The two exception branches are the discriminators. If the main
scenario's none control also answers them correctly, audit clues, guessing and judging;
correct endpoint answers alone then do not establish retention. Scores must not be pooled
with the direct-source control to rank engines. Compare branch evidence by id across the
control and core sections (or separate reports) and complete `semantic-fidelity` manually. A pipeline failure does not by
itself identify an inferior writer model; notes/mem0 and hosted extraction are different
configurations, and context placement can also affect the support agent.

The source control costs **3 agent turns and up to 3 judge calls per repeat**, no extraction.
The main scenario adds **3 agent turns and 3 rubric judgments** per repeat; its later
consolidation also processes the three additional conversations.

Offline validation:

```bash
pnpm eval validate --scenario evals/controls/csv-rule-source.yaml
```

Prepared command for a **paid** source-control pilot (not executed during preparation):

```bash
LLM_CACHE=0 pnpm eval run --scenario evals/controls/csv-rule-source.yaml --config evals/configs/none.yaml --repeat 1 --run-id csv-rule-source-r1
```

Use the specific task result, not whether the answer contains a topic keyword. A correct
answer with the wrong merchant's setup is a failure. A historical mention of a superseded
personal fact is allowed in the update scenario; its rubric checks the **current applied value**.
The generic non-temporal `must_not_use` judge also detects historical mentions, so it would
be the wrong check for supersession.

`human-reply-only` intentionally has no agent turn after the human reply and no coach note.
Under `write: agent`, the engine never receives that reply: a miss identifies a workflow
coverage gap, not inferior extraction. Coach notes still enter consolidation in every mode.

Recovery confirmation is a dated historical product event, marked `undocumented/shared`
but not `documentation_candidate`. Expiry of an estimate is not a confirmation. The existing
payment case K2 now targets order 1153 and its engineer, rather than requiring an unrelated
list of other orders in every reply. Previous judge results are not comparable to this target.

## Staged execution and stopping rules

1. Run offline validation and tests. Review known judge disputes in saved baseline JSON before
   spending on new repeats. T1.6 (`lint-wiki`) is still a stub: manually inspect `none` uses,
   CRM/current-message clues and any judge false positives. Wiki publication is an explicit exception.
2. Run the CSV direct-source control with `none` and inspect all three branch decisions.
   Pilot the five core scenarios with `read: hydrate / write: consolidate`, one repeat:
   `none`, `naive`, `notes`, `mem0`; xmemory separately, last, starting with one scenario.
   Keep agent model, actual judge and source revision fixed. Capture external usage before/after
   hosted runs because the report does not know all internal spend.
3. Review controls, partials, failed consolidations and budget. Stop to fix instrumentation,
   quota/integration errors or invalid expectations before multiplying repeats. Do not tune an
   engine against a disputed answer and silently reuse its old comparison cells.
4. Complete comparisons that affect the decision to three fresh repeats (`LLM_CACHE=0`).
   Select which comparisons to repeat using a recorded rule and retain all pilot outcomes;
   selective follow-up is exploratory evidence, not an unbiased statistical winner selection.
5. When choosing the writing mechanism, add `--suite write-paths` and compare within one
   engine at fixed read, reusing core baselines. This is additional to the main engine
   hypotheses; omitting it leaves writing-mode superiority untested. Existing `notes`, `notes-agent` and
   `notes-both` now all use `read: hydrate`. There are no auto-generated `*-both` configs for
   the other engines; add explicit configs if a write-path question warrants those calls.
6. Run the opt-in stress case on selected **consolidate** configs. Eight fixed human-handled
   draft-catalogue tickets add noise without extra agent or judge turns. Extraction is still
   paid. Each transcript fits below the naive cap; together they exceed it. An offline test
   verifies the old source is evicted. This tests this bounded transcript policy, not every
   possible transcript retrieval strategy. Agent-only would not ingest these distractors,
   so comparing it here would confound write coverage with retrieval.
7. Audit at least 10 targeted judge verdicts (all critical isolation/temporal disputes,
   representative passes and partials, and cross-engine disagreements). Complete the decision
   record. Preserve disagreements and unknowns; a tie with naive is a valid finding.

Five core scenarios contain **26 agent turns and up to 70 judge calls per config/repeat**.
The present eight configs under `--all --repeat 3` therefore mean **120 scenario runs,
624 agent turns and up to 1,680 judge calls**, plus tool-loop and memory calls. `--all` selects
files; it does not construct the factorial matrix. The stress and controls directories are excluded.

Review-only call estimate for the main selection (no runtimes or result files are created):

```bash
LLM_CACHE=0 pnpm eval run --suite research --repeat 1 --dry-run
```

Offline validation of the opt-in case:

```bash
pnpm eval validate --scenario evals/stress/recall-under-noise.yaml
```

For a paid pilot use explicit, repeatable `--scenario` and `--config` arguments, a fresh run id,
and `--repeat 1`. Explicit selections start immediately; unlike `--all`, they do not require
`--yes`. No command in this change executes a paid pilot automatically.

## Reading the report

Use repeated `--run` arguments to combine suite runs, including core baselines in writing-mode
comparisons: see [the report command](RUNS.md#one-report-from-multiple-runs). The combined
report records unique observed spend, source paths, planned coverage and a research decision
template; controls/core/stress and the two within-engine writing comparisons remain separate.

- **Common checks and capabilities:** matched agent checks only; all probe counts separately.
  Proposals are optional and must not inflate a pooled ranking. Missing coverage remains visible.
- **Hypotheses:** original claim, comparison, decision rule and evidence counts by config.
  Conclusions remain `review pending`; aggregation cannot establish a causal effect.
- **Write evidence by config:** lexical overlap in that config's recorded writes at any time
  in the run. It is neither semantic proof nor proof that a write preceded a particular answer.
- **Cost and response measurements:** agent spend, judge overhead and known memory spend
  separately. mem0 extraction/embeddings and xmemory internal cost remain `unknown`.
  Response timing includes hydration and agent/tool time, excludes judging and subsequent
  persistence. Recall volume shows median and maximum estimated tokens across reads per turn, not actual model input.
- **Review queue:** partial/failed turns with the JSON filename, check explanations, recalled
  item ids and reply excerpt. Trace the relevant source through consolidation/agent writes,
  exact recall payload and reply, then audit `judgePrompt`. Classify the cause manually as
  extraction/write, retrieval, application, judge, integration or unknown.
- **Decision record:** for each hypothesis record supported / not supported / insufficient
  evidence, exact result references and confounds. Then choose an engine and write path for
  the next milestone, or retain naive, with the cost tradeoff and evidence that would change
  the choice. Do not infer that three passes prove production reliability.

## Reproducibility and remaining limits

New result JSON freezes scenario/config definitions and records the actual judge. Reports
prefer saved definitions; they reject mixed definitions under one id and mixed legacy/new
result files. Legacy reports still render, but do not acquire new hypotheses retroactively.
Code, wiki, dependency lockfile and environment are not archived by these fields: retain
the source revision and relevant inputs beside each run. Never merge pre-revision baseline
results into this comparison. Budget/cost accounting is still incomplete after runtime errors.

mem0's `topK` limit differs from the token caps of the other engines. Isolation includes
adapter scoping and runner filtering. Results describe these integrations, not all possible
native engine configurations. Conflicting trust sources, malicious memory inputs, retrieval
ablations beyond the CSV direct-source control, large-scale lifecycle/deletion and real ticket distributions remain
outside this round. After these stories are used to improve the system, further generalization
claims need new held-out stories.
