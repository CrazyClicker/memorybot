# Support agent with learning memory

A first-line support agent for **«Прилавок»**, a fictional e-commerce platform for small
merchants. The agent reads a wiki, checks its memory, and either answers the merchant or
escalates to a human. Humans reply to the merchant and may leave a **coach note** for the
agent. The question the project exists to answer: **how much does memory actually help, and
which memory engine helps most?**

Evals come first. The live demo on GitHub Issues (M2) and the deferred dev UI (M3) reuse the
eval machinery instead of a separate runtime.

- [ROADMAP.md](ROADMAP.md) — milestones, decisions, task list. **The plan of record.**
- [DOMAIN.md](DOMAIN.md) — names, integrations, merchants, wiki page list.
- [evals/README.md](evals/README.md) — scenario format v2, expectations, configs, runner.
- [wiki/README.md](wiki/README.md) — facts deliberately kept out of the wiki, so scenarios
  test memory rather than lookup.

Content (wiki, merchant messages, coach notes, knowledge statements) is **Russian**; ids,
keys, rubrics, code and docs are **English**.

## Setup

Requires Node 22.5+ (`node:sqlite`, used by the `notes` engine in T3.1) and pnpm 10.
The version is pinned in [.nvmrc](.nvmrc); pnpm comes from corepack via the `packageManager`
field.

```bash
nvm use            # Node 22 from .nvmrc
corepack enable pnpm
pnpm install
cp .env.example .env    # OPENAI_API_KEY is enough to start; see the file for the rest
```

Before running a paid matrix, choose a set from [the run catalogue](evals/RUNS.md), then read
[the experiment protocol](evals/EXPERIMENTS.md) and
[the offline report preview](evals/REPORT-PREVIEW.md). Preview the main 31-pair experiment with
`pnpm eval run --suite research --dry-run`: source control, five core stories and long-history
stress, with one consolidate config per engine. `--suite write-paths` selects 15 additional
pairs for comparing writing modes. `--all` retains its core-directory × all-configs meaning.

## Commands

| Command | What it does |
|---|---|
| `pnpm eval validate` | Check scenarios and configs against the schema |
| `pnpm eval run` | Run scenarios against configs, write result JSON |
| `pnpm eval report` | Report one run; repeat `--run` to combine suites and reuse core baselines for writing comparisons |
| `pnpm eval lint-wiki` | Planned wiki leak lint; currently exits 2 (T1.6 still open) |
| `pnpm live <command>` | GitHub Issues live loop (M2); see [Live loop](#live-loop-m2) below |
| `pnpm test` | Unit tests (vitest) |
| `pnpm typecheck` | `tsc --noEmit` |

`pnpm eval <command> --help` prints a command's options. Commands whose ROADMAP task has not
landed yet exit with code 2 and name the task — a missing feature never looks like a passing
run.

## Live loop (M2)

`pnpm live` runs the same agent, engine and wiki over GitHub Issues in the repository named in
[live/config.yaml](live/config.yaml) (ROADMAP §6). The bot identity comes from `.env`
(`GITHUB_TOKEN`, or the `GITHUB_APP_*` variables). Without one, or with `--fake`, every command
replays the recording in [live/fixture.yaml](live/fixture.yaml) onto an in-memory GitHub, keeps
its state in `live/fake-*.db` and prints what the bot would have posted. Only GitHub is faked:
the model calls are real, so one `pnpm live once --fake` over the shipped recording (act 1 of
the demo: two «Кофе-точка» issues and a `/consolidate`) costs a few cents and about half a minute.

| Command | What it does |
|---|---|
| `pnpm live run` | Poll every `poll_seconds` until Ctrl-C; the poller log stays on screen during the demo |
| `pnpm live once [--json]` | One poll, then exit (tests, rehearsals) |
| `pnpm live status [--json]` | Threads, proposals, the scenario clock and the cursor, from the local state alone |
| `pnpm live memory [--customer <id>]` | The notes the agent holds; with `--customer`, only what that merchant's threads can see |
| `pnpm live coach <issue> [--product] <text…>` | File a coach note privately and consolidate the thread; a `/coach` comment is the on-camera path |
| `pnpm live clock [<ISO>]` | Show the scenario clock, or move it forward (the memory issue is repainted) |
| `pnpm live reset [--issues [--yes]]` | Clear the local databases; `--issues` also deletes the demo issues, closes the proposal PRs and empties the memory issue as the owner (`gh auth token`), after printing the plan |

`pnpm live <command> --help` lists the options. `--config <path>` points at another live config,
`--fixture <path>` at another recording.

## Layout

```
src/
  llm/      provider registry, model catalogue, usage -> USD, disk cache
  wiki/     loader, read_page / search_wiki tools, update()         (T2.2)
  agent/    runTurn(), system prompt, finish / remember tools       (T2.4)
  memory/   engine interface + none, naive, notes, mem0, xmemory    (T2.3, T3)
  evals/    schema, runner, checks, judge, report, cli
  live/     GitHub Issues loop: client, session, state, render, cli  (M2)
  ui/       dev UI: Hono server + Vite/React client                 (M3, deferred)
evals/
  scenarios/  *.yaml — the stories
  configs/    *.yaml — model × memory engine × read/write path
  results/    git-ignored run output
wiki/         the Russian wiki the agent reads
```
