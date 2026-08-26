<!-- Mirrors the HELP text in src/cli.ts — update both together. -->

# CLI Reference

## Commands

| command | what it does |
| --- | --- |
| `outdo` | list available tasks, grouped |
| `outdo <task> [flags] [-- args]` | run a task and its dependency DAG |
| `outdo <task1> <task2>` | run multiple tasks (shared deps run once) |
| `outdo ls [--json]` | list tasks — machine-readable with `--json` |
| `outdo graph [--dot] [--json]` | dependency graph as mermaid, graphviz dot, or JSON |
| `outdo explain <task> [--json]` | why each planned task will run or skip (cache diagnosis, inputs, backend); never runs |
| `outdo --print-env <task> [--json]` | resolved env with per-key provenance + schema verdict; never runs |
| `outdo init` | scaffold a starter `do.ts` (+ gitignore `.outdo/`) |
| `outdo completion <shell>` | completion script for `bash` \| `zsh` \| `fish` \| `powershell` |

## Global flags

Global flags go **before** the task name; everything after the task name belongs to the task.

| flag | values | default | meaning |
| --- | --- | --- | --- |
| `-w, --watch` | | off | re-run affected tasks when watched files change |
| `-j, --concurrency <n>` | integer ≥ 1 | CPU count | max parallel tasks |
| `--continue` | | off | keep running independent tasks after a failure |
| `--log-order <mode>` | `stream` \| `grouped` \| `auto` | `auto` | live prefixed lines vs per-task blocks (`auto`: stream in a TTY, grouped in CI) |
| `--output-logs <mode>` | `full` \| `errors-only` \| `none` | `full` | how much child output to show |
| `--dry[=json]` | | off | print the plan (incl. cache status) without running |
| `--affected[=<rev>]` | rev via `=` form | off | only run tasks [affected by git changes](/guide/workspaces#git-aware-runs-affected) vs `<rev>` (default: merge-base with origin's default branch) |
| `--profile[=<file>]` | path via `=` form | off | write a [Chrome trace](/guide/execution#timing-and-the-critical-path) of the run (default `.outdo/trace.json`) |
| `-f, --force` | | off | ignore the fingerprint cache (still records fresh fingerprints) |
| `-F, --filter <pattern>` | repeatable | | select workspace packages — see [Workspaces](/guide/workspaces#filtering-f-filter) |
| `--isolate` | | off | force the child-process backend even for pure chains (multiplexed output, tree-kill semantics) |
| `--json` | | off | machine-readable output — runs emit a [JSON report](/reference/exit-codes-and-json#run-report-json) on stdout, logs move to stderr |
| `--color <mode>` | `auto` \| `always` \| `never` | `auto` | also `--no-color`; honors `NO_COLOR` / `FORCE_COLOR` |
| `-h, --help` | | | global help; `outdo <task> --help` shows the task's flags |
| `-V, --version` | | | print the version |

`--affected` and `--profile` take their value with `=` only (`--affected=main`, not `--affected main`) so a following task name is never swallowed. `--watch` is exclusive with `--json`, `--profile`, and `--affected` (usage error, exit `2`).

## Environment variables outdo reads

| variable | effect |
| --- | --- |
| `NODE_ENV` | selects the [env cascade](/guide/env#the-cascade) layer (default `development`) |
| `NO_COLOR` / `FORCE_COLOR` | color output off/on (flag `--color` wins) |
| `OUTDO_WATCH_POLL=1` | force the polling watch backend |
| `OUTDO_LOG=debug` | internal debug logging on stderr |

## Shell completions

```sh
# bash (~/.bashrc)
eval "$(outdo completion bash)"

# zsh (~/.zshrc)
eval "$(outdo completion zsh)"

# fish
outdo completion fish > ~/.config/fish/completions/outdo.fish

# PowerShell ($PROFILE)
outdo completion powershell | Out-String | Invoke-Expression
```

Completions are **dynamic**: task names, per-task flags, and subcommands come from your actual `do.ts` at TAB-time.
