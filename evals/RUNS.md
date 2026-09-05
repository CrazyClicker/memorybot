# Run catalogue

Prepared 2026-09-05; these are planned comparisons, not completed evaluations.
The [experiment protocol](EXPERIMENTS.md) defines hypotheses and interpretation.
This catalogue defines what to run to obtain that evidence.

**`--all` is not the full research programme.** It selects only `evals/scenarios/*.yaml`
against every `evals/configs/*.yaml`. It includes write-path variants, but excludes both
`evals/controls/` and `evals/stress/`. Use `--suite research` for the main experiment,
and `--suite write-paths` for the additional writing-mode comparison. Suite definitions live
in [src/evals/suites.ts](../src/evals/suites.ts).

## Named runs and expected outputs

All comparisons hold the support model, actual judge, code and wiki revision fixed.
All current configs use `read: hydrate`.

| Run set | Scenarios and configs | Purpose / expected conclusion | Required evidence |
| --- | --- | --- | --- |
| `controls` | `controls/csv-rule-source.yaml` × `none` | Can the support model apply the original conditional rule? Establish whether H2 can diagnose loss in memory. | Three branch rubric verdicts with explanations; prerequisite for interpreting the paired CSV branches, not an engine score. |
| `core` | All five core stories × `none`, `naive`, `notes`, `mem0`, `xmemory`; `write: consolidate` | Does memory help, preserve meaning and current facts, ingest operator replies and respect sharing boundaries? Decide whether an engine improves on the baselines. | Per-hypothesis evidence, actual recalls, write evidence, errors, known costs and unknown hosted spend. H2 also needs `controls`. |
| `write-paths` | Same five stories; compare `naive` ↔ `naive-agent`, and `notes` ↔ `notes-agent` ↔ `notes-both` | Does who writes memory change quality, coverage and cost within the same engine? | Reuse `naive` and `notes` from `core`; run only the three additional configs. In particular, inspect the operator-reply gap. No claim about untested mem0/xmemory write modes. |
| `stress` | `stress/recall-under-noise.yaml` × `none`, `naive`, `notes`, `mem0`, `xmemory`; `write: consolidate` | Is the older constraint retained after unrelated history exceeds the naive transcript budget? Decide whether more selective memory warrants its complexity. | Later region-specific answer, recall contents, isolation and recall volume. This is a separate load condition; do not pool it into the core score. |
| `research` | `controls` → `core` → `stress` | Answer the main memory hypotheses with one consolidate config per engine. | One command executes all three groups; the report keeps their evidence separate. Writing-mode superiority requires the additional `write-paths` experiment. |

The five core stories are `csv-import-dropped-rows`, `setup-from-the-question`,
`customer-setup-change`, `human-reply-only` and `payment-provider-incident`.
The control and stress case are separate inputs with separate purposes; excluding them from
`--all` must not make their research questions disappear from the final decision record.

`write-paths` remains available because selecting who writes memory is a useful architectural
question. It is additional to the engine comparison: run it when choosing between agent,
consolidate and both. Define the expected benefit (for example better capture of incidental
setup or a gain from combining writers) and inspect quality against additional cost. The
operator-reply gap in agent-only mode follows from missing observation opportunity; that gap
alone does not justify paying for all writing variants. Leaving this set out does not show
that consolidate is the best writing mode.

## Size before spending

Counts below assume every listed config is available and **one fresh repeat**.
Judge calls are upper bounds; unsupported or empty-memory probes may not call the judge.
An agent turn may contain multiple model calls. Extraction, embeddings and hosted internal
calls are additional, so these counts are not a dollar estimate.

| Selection | New scenario/config runs | Agent turns | Judge calls, up to |
| --- | ---: | ---: | ---: |
| `controls` | 1 | 3 | 3 |
| `core` | 25 | 130 | 350 |
| `write-paths`, reusing core baselines | 15 | 78 | 210 |
| `stress` | 5 | 10 | 20 |
| Main `research` | **31** | **143** | **373** |
| `research` + additional `write-paths`, no duplicate baselines | 46 | 221 | 583 |
| Existing `--all` = core + additional write paths | 40 | 208 | 560 |

Multiply by the number of fresh repeats for a uniform matrix: full `research` at three
repeats is 93 runs / 429 agent turns / up to 1,119 judge calls. This is an upper scope,
not a recommendation to purchase all repeats immediately. Start with a pilot, inspect the
source control and `none`, then expand only comparisons that affect the decision. Start
xmemory with one scenario after checking its available quota.

## Commands

Run from the repository root. Offline preparation:

```bash
pnpm eval validate
pnpm eval validate --scenario evals/controls/csv-rule-source.yaml --scenario evals/stress/recall-under-noise.yaml
pnpm test
pnpm typecheck
```

Preview the main experiment. `--dry-run` validates every selected file and prints groups,
scenario/config ids and call estimates; it creates no runtimes, results or plan files:

```bash
LLM_CACHE=0 pnpm eval run --suite research --repeat 1 --dry-run
```

Execute that **paid** selection with a fresh run id, then generate its report without model calls:

```bash
LLM_CACHE=0 pnpm eval run --suite research --repeat 1 --run-id research-r1 --yes
pnpm eval report --run research-r1
```

This executes all three groups without pausing for human review between them. A failed source
control does not automatically cancel other runs, but prevents attributing its paired branch
failures to memory. For staged pilots, use `--suite controls`, `--suite core` and `--suite stress`
separately, with distinct run ids and review between commands. Use explicit `--scenario` and
`--config` selections for smaller pilots, such as one xmemory story or a subset of engines.
Do not rerun already measured stages just to package them as `research`; combine their suite
run ids with repeated `--run` arguments when generating the report.

The additional writing experiment reuses the comparable `naive` and `notes` baseline results
from core. Its command runs only `naive-agent`, `notes-agent` and `notes-both`:

```bash
LLM_CACHE=0 pnpm eval run --suite write-paths --repeat 1 --dry-run
LLM_CACHE=0 pnpm eval run --suite write-paths --repeat 1 --run-id write-paths-r1 --yes
pnpm eval report --run write-paths-r1
```

`--suite` cannot be combined with `--all`, `--scenario` or `--config`. Both suite and `--all`
execution require `--yes`; explicit selections still execute without it unless `--dry-run`
is supplied. `--repeat` repeats each selected pair, not the catalogue or prior baseline runs.

Suite results are organized as:

```text
evals/results/research-r1/
  PLAN.yaml          # frozen purposes, group membership and repeat count
  controls/*.json    # original-source control with none only
  core/*.json        # five stories × five consolidate configs
  stress/*.json      # long history × five consolidate configs
  REPORT.md          # generated by eval report; separate comparisons and planned coverage
```

The report uses the saved plan, lists missing planned results (including skipped configs),
and keeps groups separate. Result errors are still errors even if every planned file exists.
`--out` can override the suite report path. Reports of older, flat result directories retain
their previous default output location. A single write-paths report contains only its additional
configs. To include the core baselines, assemble a research report as below.

## One report from multiple runs

After both paid runs have saved results, this command assembles one report **without model calls**:

```bash
pnpm eval report --run research-r1 --run write-paths-r1 --out evals/results/RESEARCH-REPORT.md
```

`--out` is optional here; the default for multiple runs is `evals/results/RESEARCH-REPORT.md`.
Additional suite run ids can supply separate stages or fresh follow-up repeats. Each must
have its saved `PLAN.yaml`; the command does not guess group membership for historical flat
runs such as `baseline-4`. `evals/BASELINE.md` remains a historical report and is not updated
automatically.

The combined report includes:

- Planned/present coverage for every source group, missing files, unreadable inputs and errors.
- Separate source-control, core and stress comparisons.
- Within-engine writing comparisons: `naive` + `naive-agent`, and `notes` + `notes-agent` +
  `notes-both`. The consolidate baselines come from core; they are not rerun.
- Unique observed spend across source results. Reused baselines are charged once in this
  total, although their costs also appear in each comparison table. Hosted internal spend
  and unrecorded failed calls remain unknown.
- An evidence index and review queue with original JSON paths, including repeats whose
  local numbering restarts at 1 in another run. Duplicate run ids and exact copied results
  do not create additional samples or spend.
- A research decision record covering the main hypotheses and the writing-mode choice.
  Conclusions remain manual, with `Review pending` rather than an automatic winner.

Recorded scenario/config versions, support-model settings, actual judges, read modes and
cache status are checked for comparability. A conflicting comparison is blocked in the
report while unaffected sections remain available. Missing baselines are identified explicitly.
Code/wiki/dependency/provider equivalence is not proven by these fields: verify it in the
campaign record. Source-control branch parity and verdict interpretation still require review.

A suite requires a fresh directory and refuses an existing one before constructing runtimes.
There is no resume/append-repeat option. Additional fresh repeats need a new run id; retain
pilot outcomes and link all repeat ids in the campaign record. If a runtime skips a config
(for example missing xmemory credentials), the plan is incomplete, not successful coverage.

## Campaign record and completion

Keep a `CAMPAIGN.md` beside the results, linking the combined report and recording source
snapshots, sampling decisions and conclusions. The report supplies evidence and a decision
template; it does not make those research decisions automatically.

```markdown
# Campaign <id>
- Source: commit + saved local diff, wiki snapshot, lockfile; agent model and actual judge.
- Sampling: LLM_CACHE=0; pilot/repeat selection rule; fresh repeat ids.
- Scope: selected scenarios/configs; planned run/turn counts; budget and hosted quota.

| Set | Status | Result ids / reports | Planned / present runs | Omissions and reason |
| --- | --- | --- | --- | --- |
| controls | not run | | | |
| core | not run | | | |
| write-paths | not run | Core baseline refs: | | |
| stress | not run | | | |

| Question | Verdict: supported / not supported / insufficient evidence | Exact branch/check refs | Confounds / next action |
| --- | --- | --- | --- |
| H1–H7: one row per protocol question | | | |

- Judge audit: inspected verdicts and disagreements (at least 10 targeted verdicts).
- Spend: known agent/judge/memory cost; external usage delta; unknowns and failed calls.
- Decision: engine and write path (or retain naive); tradeoff and evidence that would change it.
```

A core report alone does not complete `research`: source understanding needs its control,
and retention under a transcript budget needs the stress run. A deliberate omission is
valid, but its hypothesis remains insufficiently evidenced. Reused baselines must match the
source revision, models, actual judge and sampling conditions; otherwise record the mismatch
and obtain comparable baselines before drawing a write-path conclusion.
