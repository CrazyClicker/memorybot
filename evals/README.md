# Memory evals — multistep scenarios for the support agent (format v2)

Controlled experiments on one question: **how well does the agent retrieve facts learned
from earlier tickets and use them on later ones?** Each eval is a multistep *scenario*: a
small story spanning several tickets in which the agent first has the chance to learn
something and is later tested on it. Scenarios run under a matrix of *configurations*
(model, memory engine, memory read/write path).

Scenarios are YAML, results are JSON, the report is Markdown. Nothing in a scenario depends
on a memory engine's internals: the same file runs against `none`, `naive`, `notes`, `mem0`,
`xmemory` or any engine behind the adapter (see [§6](#6-runner)).

Content (customer messages, replies, notes, knowledge statements, wiki) is **Russian**.
Structure (ids, keys, rubrics, config) is **English**. The judge is told the text may be in
either language.

The reference example is [scenarios/csv-import-dropped-rows.yaml](scenarios/csv-import-dropped-rows.yaml).
Domain, names and wiki page list: [../DOMAIN.md](../DOMAIN.md).

---

## 1. What we are testing

Three memory use cases, named by the `kind` of the knowledge items a scenario declares:

| `kind` | The agent should remember… | Typical test |
|---|---|---|
| `personal` | a fact about *this* customer's setup, history, constraints | the same customer asks something only their history answers |
| `temporal` | something true *for a while*: a scheduled fix, an in-flight change, an ongoing incident | the same question before and after `valid_until` gets different correct answers |
| `undocumented` | a product fact that is true for everyone but absent from the wiki | a *different* customer asks; the answer is a documentation candidate |

Knowledge also has a **scope** that decides who may see it:

| `scope` | Who sees it | How it is created |
|---|---|---|
| `customer` (default) | only threads of the customer it was learned from | anything learned on a customer's ticket, including product facts |
| `shared` | every customer | only from a `coach_note` with `scope: product` (a human decided to broadcast it), typically an incident or a platform-wide temporary condition |

Product facts learned on one customer's ticket reach other customers in two ways only: a human
accepts a documentation proposal into the wiki (`wiki_update` step), or a human broadcasts
it in a coach note. The agent never promotes on its own.

Every scenario also carries an implicit **isolation** test: `scope: customer` knowledge must
never surface on another customer's thread, in any configuration.

## 2. Where knowledge comes from

| Stage | Who writes | Step type | Trust | Feeds memory? |
|---|---|---|---|---|
| Ticket is created | customer | `customer_message` | claim | yes |
| Agent answers or asks (enough in wiki/memory) | agent | `agent_turn` | — | agent reply is part of the transcript |
| Customer adds context / corrects us | customer | `customer_message` | claim | yes |
| Agent escalates → engineer writes the public answer | engineer | `human_reply` | high | yes |
| Engineer leaves a note for the agent | engineer | `coach_note` | high | yes, only path to `scope: shared` |
| Engineer accepts a documentation proposal | engineer | `wiki_update` | high | no: it changes the wiki |
| Ticket is closed | platform | `close_ticket` | — | — |
| Memory consolidation | memory engine | `consolidate` | — | engine extracts from transcripts |

Reference sources the agent consults but never learns *from*: the wiki (`wiki/`, served
through the page index and `read_page`) and the CRM record (`world.customers.<id>.profile`).
`wiki/README.md` lists the facts deliberately absent from the wiki so that scenarios keep
testing memory rather than lookup; every scenario's knowledge items go on that list.

## 3. Scenario anatomy

```yaml
id: <kebab-case, unique>            # file name matches
title: <one line>
tags: [...]                         # free; "memory:<kind>" tags are conventional (quote them: a bare colon breaks YAML 1.1 parsers)

world:        # §3.1  who exists, what the agent can look up, when it starts
knowledge:    # §3.2  what the agent is expected to learn (K1, K2, …)
steps:        # §3.3  the story, in order
probes:       # §3.4  end-of-scenario checks against the memory layer itself
```

### 3.1 `world`

```yaml
world:
  knowledge_base: wiki | none          # wiki = the repository's wiki/*.md
  clock: <ISO timestamp>               # scenario start
  customers:
    <customer_id>:                     # the verified id the platform attaches
      name: <display name>
      profile: <free text shown to the agent as the CRM record>
```

### 3.2 `knowledge`

The point of the scenario, stated as facts with ids, before any step:

```yaml
knowledge:
  K1:
    kind: personal | temporal | undocumented
    about: <customer_id> | product
    scope: customer | shared           # default customer
    statement: <one paragraph, Russian, the fact as a human would state it>
    source: [<step ids where it first becomes available>]
    valid_until: <ISO date or timestamp>   # temporal only
    documentation_candidate: true          # undocumented only
```

Steps and probes reference these by id (`uses: [K1]`), so the *same* fact is judged with the
*same* wording everywhere. A `wiki_update` step appends the statement verbatim to a wiki page,
so statements must read well as documentation.

### 3.3 `steps`

Common fields: `id` (unique within the scenario), `type`, `at` (ISO timestamp; sets the
scenario clock, must not go backwards), optional `note` (commentary for the human reader;
the runner ignores it).

**Nothing happens implicitly.** A `customer_message` records a message and stops; the agent
runs only when an `agent_turn` says so. That is how a scenario expresses "after escalation
the ticket belongs to a human": it schedules no `agent_turn` on that thread.

| type | fields | effect |
|---|---|---|
| `customer_message` | `thread`, `customer`, `content` | appends a customer message to the thread (creates the thread on first use) |
| `agent_turn` | `thread`, `expect` | runs the agent once on the thread's pending message(s); appends the reply |
| `human_reply` | `thread`, `author`, `content` | the public answer an engineer sent |
| `coach_note` | `thread`, `author`, `content`, `scope: customer \| product` | an engineer's note to the agent, never customer-visible; `scope: product` marks it for every customer |
| `wiki_update` | `page`, `knowledge: [K..]` | a human accepted the proposal: the K statements are appended to the page for the rest of the run |
| `close_ticket` | `thread` | the platform closed the ticket |
| `consolidate` | — | the engine's extraction pass over every thread with new events since the last pass, at the current clock |

### 3.4 `probes`

Checks against the memory layer directly, run after the last step:

| type | fields | asks the engine |
|---|---|---|
| `memory_recall` | `customer`, `query`, `expect.recalls` / `must_not_recall` / `must_not` | `recall(customer, query, now)` → the items the agent would be shown |
| `documentation_proposals` | `expect.proposes` / `must_not` | `proposals()` → candidates for the wiki |

An engine that cannot serve a probe reports it as `skipped`, never `fail`.

## 4. Expectations

`expect` on an `agent_turn` mixes **deterministic** checks (free) with **judged** checks (an
LLM judge scoring free text against a stated fact or rubric). Every key is optional.

| key | checked by | meaning |
|---|---|---|
| `outcome: answer \| ask \| escalate` | deterministic | the agent ends every turn with a `finish` tool call carrying `outcome`; this compares it |
| `tolerated: [..]` | — | outcomes scored *partial* instead of *fail* |
| `escalation.reason_must: [..]` | deterministic | regexes against the internal escalation reason |
| `reply.must` / `reply.must_not: [..]` | deterministic | quoted `"/regex/flags"` strings or plain substrings (case-insensitive) against the customer-facing reply; use Russian stems (`/артикул/i`) |
| `reply.rubric` | judge | free-text pass/partial/fail criteria (English) |
| `uses: [K..]` | judge | the reply *conveys* the knowledge statement, any wording, any language |
| `must_not_use: [K..]` | judge | the reply does not convey it: the isolation check, and the "after `valid_until`" check |

Deterministic checks run first. Judge verdicts are three-valued (`pass` / `partial` / `fail`)
with a one-line justification, and every judge call is logged with its prompt so a human can
audit a disputed verdict.

How the judge reads `uses` / `must_not_use` (calibrated on the 2026-09-04 smoke run): `pass`
means the reply asserts the *substance* of the statement about its subject; details left out
do not lower the verdict, because a K statement is written out in full for the record and a
reply is not. `partial` is a hedged or conditional assertion, or a fragment. `fail` is anything
that would read the same without knowing the fact: a rule from the documentation, an answer
covering every case, a mention of the topic. A non-temporal fact told as former behaviour that
a later change replaced (the cause of a bug, next to the shipped fix) still counts as conveyed;
only stating the opposite contradicts it. On an `agent_turn` a `temporal` item is judged as
"asserted as currently in force", so a past-tense mention is not a use — which is what
`must_not_use` after `valid_until` relies on. Probes ask only whether memory holds the
statement, whatever its date.

**Every temporal scenario** has one `agent_turn` after `valid_until` with `must_not_use` on
the temporal item: the agent must stop asserting the expired fact.

## 5. Configurations and results

A run = one scenario × one configuration × one repeat. Configurations are small YAML files
in [configs/](configs/):

```yaml
id: notes
agent:  { provider: openai, model: gpt-5.6-terra }
memory:
  engine: notes                # none | naive | notes | mem0 | xmemory
  read: hydrate                # hydrate: recall() result in the prompt | tool: recall_memory tool | both
  write: consolidate           # consolidate: engine extracts from transcripts | agent: remember tool during turns | both
                               # coach notes are ingested at consolidate steps in every mode
judge:  { provider: anthropic, model: claude-sonnet-5 }
```

`temperature` is optional and is sent only when explicitly configured. The GPT-5.6 reasoning
models used by the agent and the OpenAI judge fallback do not support it, so their configs
omit it; repeat runs measure the remaining model variance.

`memory.engine: none` is the control: it must fail every `uses:` check and pass every
isolation check. `naive` (whole transcripts per customer, stuffed into the prompt) is the
baseline every real engine must beat.

Results go to `evals/results/<run-id>/<scenario>.<config>.<repeat>.json` (git-ignored):

```json
{
  "scenario": "csv-import-dropped-rows", "config": "notes", "repeat": 1, "startedAt": "…",
  "steps": [
    { "id": "t1-agent", "outcome": "escalate", "reply": "…", "escalationReason": "…",
      "trace": [...], "memoryWrites": [ {"statement": "…", "source": {"via": "agent"}} ],
      "checks": [ {"key": "outcome", "verdict": "pass"},
                  {"key": "uses:K3", "verdict": "fail", "why": "…", "judgePrompt": "…"} ],
      "costUsd": 0.0004, "latencyMs": 2100 }
  ],
  "consolidations": [ { "id": "consolidate-1", "wrote": [ ... ] } ],
  "probes": [ { "id": "recall-dom-i-sad", "verdict": "pass", "returned": [ ... ] } ],
  "score": { "pass": 9, "partial": 1, "fail": 2, "skipped": 1 }, "costUsd": 0.006
}
```

`cached: true` marks a result produced with the LLM disk cache on (`LLM_CACHE=1`): identical
calls replay the recorded response, so such repeats are one sample graded again and the report
says so. `pnpm eval run` refuses `--repeat` above 1 with the cache on unless
`--allow-cached-repeats` is passed.

Scores are counts, not a single number: a scenario is a story, and which step failed is the
finding. `pnpm eval report [--run <run-id>] [--out <path>]` aggregates a run directory into
`REPORT.md`: one table per scenario (rows = checks, columns = configs, cells = pass rate over
repeats), totals, cost and median latency per config, a "which path learned it" column per K
item (`agent`, `consolidate`, none), and a findings section listing every check where configs
disagree. It reads the result JSON only — no model call, so a report costs nothing and can be
rebuilt from an old run directory at any time.

Cells read `✓` every repeat passed · `◐` mixed or partial · `✗` every repeat failed · `–`
nothing decided it (skipped, unjudged, or a run that stopped before the step). "Which path
learned it" is lexical: a memory write is credited with a K item when it repeats at least 30%
of that item's content words, stemmed to five characters. It says a path *wrote* something
like the fact; whether the fact reached the merchant is the judged `uses:`/`recalls:` columns.

## 6. Runner

`pnpm eval run --scenario <file> --config <file> [--repeat N]` runs in-process: the scenario
is the only state, the agent is a pure function `runTurn(input) -> TurnResult`, no queue, no
database of tickets. Per step:

- `customer_message`, `human_reply`, `coach_note`: append to the thread transcript.
- `agent_turn`: `memory = engine.recall(customer, latestCustomerMessage, now)` (read `hydrate`/`both`), then `runTurn` with the wiki, the CRM record, the clock and the tools the config enables (`read_page`, `recall_memory`, `remember`, `finish`). `memoryWrites` from `remember` go to `engine.write` with `scope: customer` forced and `learnedFrom` = the thread's customer.
- `consolidate`: for each thread with new events since the last pass. Under `write: consolidate|both` the engine gets the whole transcript; under `write: agent` it gets only the `coach_note` events, so human notes reach memory in every mode and the modes differ in who extracts facts from the conversation. Coach notes with `scope: product` produce `scope: shared` items.
- `wiki_update`: append the K statements to a per-run copy of the wiki page and rebuild the index.
- probes at the end. `engine.reset()` before each run.

Every statement written to memory is prefixed with the scenario date («По состоянию на
2026-08-27: …»), because hosted engines stamp wall-clock time and the date must survive in
the text.

The `mem0` adapter runs `mem0ai/oss` in-process with its in-memory vector store. Its LLM and
embedder use `OPENAI_API_KEY`; its extractor uses the same OpenAI model as the configured
support agent so engine comparisons do not also compare extraction models. It does not use
Mem0 Cloud or require `MEM0_API_KEY`. Mem0's internal timestamps remain wall-clock timestamps,
while items exposed through the engine interface carry the scenario clock. Customer memories
use the customer id as `userId`, and product-scoped coach notes use the reserved `_shared` user.
Mem0's operational telemetry is disabled by default; set `MEM0_TELEMETRY=true` to opt in.

The engine adapter (`src/memory/engine.ts`): `reset()`, `recall(customer, query, now)`,
`write(items, now)`, `consolidate(thread, now)`, optional `proposals()`, optional `usage()` for
an engine whose own LLM calls are visible (the `notes` extractor), charged to the run's cost at
every `consolidate` step. Recall returns items with `scope == shared`, `about == customer` or
`learnedFrom == customer`. An engine that throws while consolidating one thread does not end
the run: the runner records the error on that `consolidate` result, the engine wrote nothing
for the thread, and the report lists it under "Consolidations that failed".

**Wiki leak lint** (`pnpm eval lint-wiki`): every scenario is run with `engine: none`; every
`uses:` check must fail, except checks that follow a `wiki_update` promoting that item. A
passing `uses` means the fact is in the wiki: fix the wiki, not the scenario. Run it after
every wiki edit.

## 7. Authoring conventions

- One scenario tests one story; three to six threads is the sweet spot.
- Customer messages are written the way a merchant would write them; keep them short and slightly messy.
- Coach notes are the cleanest learning signal: state the conclusion, the customer-specific part, the product part, and any date, all explicitly.
- Cross-customer threads always carry `must_not` on the other customer's name and `must_not_use` on their `scope: customer` knowledge.
- `at` timestamps are the scenario's calendar; put a `consolidate` between learning and testing.
- Name threads after the customer (`tkt_dom_i_sad_1`) and customers after `DOMAIN.md`.
- Add every K item to `wiki/README.md` and run the leak lint.
