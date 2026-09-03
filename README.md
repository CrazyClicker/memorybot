# Support agent with learning memory

A first-line support agent for **«Прилавок»**, a fictional e-commerce platform for small
merchants. The agent reads a wiki, checks its memory, and either answers the merchant or
escalates to a human. Humans reply to the merchant and may leave a **coach note** for the
agent. The question the project exists to answer: **how much does memory actually help, and
which memory engine helps most?**

Evals come first — the dev UI (M2) reuses the eval machinery instead of a separate runtime.

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

## Commands

| Command | What it does |
|---|---|
| `pnpm eval validate` | Check scenarios and configs against the schema |
| `pnpm eval run` | Run scenarios against configs, write result JSON |
| `pnpm eval report` | Aggregate a run directory into `evals/results/REPORT.md` |
| `pnpm eval lint-wiki` | Wiki leak lint: every `uses:` check must fail with engine `none` |
| `pnpm test` | Unit tests (vitest) |
| `pnpm typecheck` | `tsc --noEmit` |

`pnpm eval <command> --help` prints a command's options. Commands whose ROADMAP task has not
landed yet exit with code 2 and name the task — a missing feature never looks like a passing
run.

## Layout

```
src/
  llm/      provider registry, model catalogue, usage -> USD, disk cache
  wiki/     loader, read_page / search_wiki tools, update()         (T2.2)
  agent/    runTurn(), system prompt, finish / remember tools       (T2.4)
  memory/   engine interface + none, naive, notes, mem0, xmemory    (T2.3, T3)
  evals/    schema, runner, checks, judge, report, cli
  ui/       dev UI: Hono server + Vite/React client                 (M2)
evals/
  scenarios/  *.yaml — the stories
  configs/    *.yaml — model × memory engine × read/write path
  results/    git-ignored run output
wiki/         the Russian wiki the agent reads
```
