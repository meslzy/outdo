<!-- Mirrors the HELP text in src/cli.ts — update both together. -->

# CLI Reference

## Commands

| command | what it does |
| --- | --- |
| `outdo` | list tasks (`do.ts` tasks + `package.json` scripts), grouped |
| `outdo <task> [flags] [-- args]` | run a task and its dependency DAG |
| `outdo <task1> <task2>` | run several tasks (shared deps run once) |
| `outdo <ns> <task>` | run a [namespaced](/guide/tasks-and-deps#namespaces) task — same as `outdo <ns>:<task>`; `outdo <ns>` lists the namespace |
| `outdo run <task...>` | run a task whose name is also a command (`outdo run ci`) |
| `outdo -i` | pick a task interactively: type to filter, ↑/↓, Enter runs (then asks for required flags), Esc quits |
| `outdo ls [--json]` | list tasks — machine-readable with `--json` |
| `outdo explain <task> [--json]` | why each planned task will run or skip (cache diagnosis, inputs, steps, backend); never runs |
| `outdo graph [--dot] [--json]` | dependency graph as mermaid, graphviz dot, or JSON |
| `outdo doctor [--json]` | run every task's [`requires`](/guide/safety#requires-and-doctor) checks; exit `1` if any fail |
| `outdo usage [task] [--since <span>] [--all] [--no-history] [--json]` | [what runs most, what never runs](/guide/usage): unused tasks, flags never passed, choices never picked, modes, hooks, duplicates; never runs anything |
| `outdo --print-env <task> [--json]` | resolved env with per-key provenance + schema verdict; never runs |

### Background runs

| command | what it does |
| --- | --- |
| `outdo bg start <task> [flags] [-- args]` | start detached; returns once its service is ready ([details](/guide/watch-and-services#background-runs-outdo-bg)) |
| `outdo bg ps [--json]` | what is running (also plain `outdo bg`) |
| `outdo bg logs <task> [-f, --follow]` | print (or follow) a background run's log |
| `outdo bg stop [task...]` | stop one or more runs; no name stops everything |

### CI / CD

| command | what it does |
| --- | --- |
| `outdo ci <task...> [--all] [--base <rev>]` | [CI run](/guide/ci-cd#outdo-ci): affected only, folded logs, failure recap, GitHub annotations + step summary |
| `outdo ci init [--force]` | write `.github/workflows/ci.yml` |
| `outdo affected <task...> [--base <rev>] [--github-output] [--json]` | [did these tasks' inputs change?](/guide/ci-cd#skipping-jobs-outdo-affected) `name=true\|false` per task |
| `outdo hooks [install \| uninstall \| list \| run <hook>]` | [git hooks](/guide/ci-cd#git-hooks) declared in `do.ts` (`list` is the default) |
| `outdo prune --docker [--out <dir>]` | [`out/json/`](/guide/ci-cd#docker-layers-outdo-prune-docker): every `package.json` + the lockfile, for a Docker layer |

### More

| command | what it does |
| --- | --- |
| `outdo init` | scaffold a starter `do.ts` (+ gitignore `.outdo/`) |
| `outdo mcp` | [MCP server](/reference/ai-agents#mcp-server) over stdio: tasks as tools |
| `outdo skill install [--global]` / `outdo skill path` | install the [outdo agent skill](/reference/ai-agents#the-outdo-skill) into `.claude/skills/outdo` (repo, or home with `--global`) / print where the bundled copy lives |
| `outdo completion <shell>` | completion script for `bash` \| `zsh` \| `fish` \| `powershell` |

Command words win over task names. A task named like a command still runs with `outdo run <name>` — the task list points this out.

## Global flags

Global flags go **before** the task name; everything after the task name belongs to the task — except the runner flags `--mode`/`-m`, `--yes`/`-y`, `--from`, `--until`, which may also follow it (unless the task declares a flag or alias of that name).

| flag | values | default | meaning |
| --- | --- | --- | --- |
| `-m, --mode <name>` | a declared mode | first declared | [mode](/guide/env#modes): picks `.env.<mode>` files, sets `ctx.mode` / `OUTDO_MODE` |
| `-y, --yes` | | off | answer yes to [protect/confirm](/guide/safety#protect-and-confirm) questions |
| `--from <step>` / `--until <step>` | a step name | | run only part of a task's [steps](/guide/tasks-and-deps#steps) |
| `-w, --watch` | | off | re-run affected tasks when watched files change |
| `-j, --concurrency <n>` | integer ≥ 1 | CPU count | max parallel tasks |
| `--continue` | | off | keep running independent tasks after a failure |
| `--log-order <mode>` | `stream` \| `grouped` \| `auto` | `auto` | live prefixed lines vs per-task blocks (`auto`: stream in a TTY, grouped otherwise) |
| `--output-logs <mode>` | `full` \| `errors-only` \| `none` | `full` | how much child output to show |
| `--dry[=json]` | | off | print the plan (incl. cache status and step order) without running |
| `--affected[=<rev>]` | rev via `=` form | off | only run tasks [affected by git changes](/guide/workspaces#git-aware-runs-affected) vs `<rev>` (default: the PR base / previous push in GitHub Actions, else the merge-base with origin's default branch) |
| `--profile[=<file>]` | path via `=` form | off | write a [Chrome trace](/guide/execution#timing-and-the-critical-path) of the run (default `.outdo/trace.json`) |
| `-f, --force` | | off | ignore the fingerprint cache (still records fresh fingerprints) |
| `-F, --filter <pattern>` | repeatable | | select workspace packages — see [Workspaces](/guide/workspaces#filtering-f-filter) |
| `--isolate` | | off | force the child-process backend even for pure chains (multiplexed output, tree-kill semantics) |
| `--json` | | off | machine-readable output — runs emit a [JSON report](/reference/exit-codes-and-json#run-report-json) on stdout, logs move to stderr |
| `--color <mode>` | `auto` \| `always` \| `never` | `auto` | also `--no-color`; honors `NO_COLOR` / `FORCE_COLOR` |
| `-h, --help` | | | global help; `outdo <task> --help` shows the task's usage, flags and steps |
| `-V, --version` | | | print the version |

`--affected` and `--profile` take their value with `=` only (`--affected=main`, not `--affected main`) so a following task name is never swallowed. `--watch` is exclusive with `--json`, `--profile`, and `--affected` (usage error, exit `2`).

## Environment variables outdo reads

| variable | effect |
| --- | --- |
| `NODE_ENV` | selects the [env cascade](/guide/env#the-cascade) layer when no modes are declared (default `development`) |
| `OUTDO_READONLY=1` | refuse any task not marked [`readonly`](/guide/safety#readonly-and-destructive) |
| `OUTDO_NO_LOCAL=1` | a global outdo does not hand over to the repo's installed copy |
| `NO_COLOR` / `FORCE_COLOR` | color output off/on (flag `--color` wins) |
| `OUTDO_WATCH_POLL=1` | force the polling watch backend |
| `OUTDO_LOG=debug` | internal debug logging on stderr |
| `OUTDO_NO_USAGE=1` | don't record runs in [`.outdo/usage.jsonl`](/guide/usage#what-gets-recorded) (also off whenever `CI` is set) |
| `AI_AGENT`, `CLAUDECODE`, `CODEX_SANDBOX`, `CURSOR_AGENT`, `GEMINI_CLI` | mark a run as an agent's in the usage log |
| `HISTFILE` | an extra shell history file for `outdo usage` (besides `~/.zsh_history`, `~/.bash_history`, fish and PowerShell history) |
| `GITHUB_ACTIONS`, `GITHUB_BASE_REF`, `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_STEP_SUMMARY`, `GITHUB_OUTPUT` | read by `outdo ci`, `--affected` and `outdo affected` ([details](/guide/ci-cd)) |

outdo sets `OUTDO_MODE` (the active mode) and `OUTDO_NESTED=1` (so an outdo run started by a task is recorded as nested) for everything it runs. `OUTDO_SSH` and `OUTDO_DOCKER` (a JSON argv) replace the `ssh` / `docker` binaries — meant for tests.

## The global binary

A global `outdo` (installed with `bun add -g`) looks for `node_modules/@meslzy/outdo` from the current directory up and, when it finds a different copy, runs that one instead — so a repo always runs the outdo in its lockfile, and you can type `outdo` instead of `bunx outdo`. `OUTDO_NO_LOCAL=1` turns this off.

## Shell completions

```sh
# bash (~/.bashrc)
eval "$(outdo completion bash)"

# zsh (~/.zshrc, after oh-my-zsh / compinit)
eval "$(outdo completion zsh)"

# fish
outdo completion fish > ~/.config/fish/completions/outdo.fish

# PowerShell ($PROFILE)
outdo completion powershell | Out-String | Invoke-Expression
```

Completions are **dynamic** and also work after `bunx outdo`. When no global `outdo` is installed, the scripts call `bunx outdo` themselves. Tab completes:

- task names, namespaces and commands; `outdo db <Tab>` → the namespace's tasks
- per-task flags, and flag **values**: `--source <Tab>` → the flag's choices, `--mode <Tab>` → your modes, `--filter <Tab>` → workspace packages, `--from <Tab>` → the task's steps, `--log-order <Tab>` → `stream grouped auto`
- positional values: `outdo logs <Tab>` → `api web`
- `bg` / `hooks` sub-commands, background run names and hook names

The task list is cached in `.outdo/complete.json`, keyed by the modification times of every `do.ts`, `package.json` and lockfile it was built from — a Tab is a JSON read, not a `do.ts` import. Every `outdo` command that loads the project (a run, `outdo ls`) refreshes it, and so does any Tab that finds it stale.
