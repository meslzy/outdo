# outdo CLI

## Commands

| command | does |
| --- | --- |
| `outdo` / `outdo ls [--json]` | list tasks (`--json`: names, deps, steps, flags, tags) |
| `outdo <task...> [flags] [-- args]` | run tasks and their deps |
| `outdo <ns>` / `outdo <ns> <task>` | list / run a namespace's tasks |
| `outdo run <task>` | run a task named like a command (e.g. `ci`) |
| `outdo -i` | interactive picker (asks for required flags) |
| `outdo explain <task> [--json]` | plan, cache verdicts and why; never runs |
| `outdo graph [--dot\|--json]` | dependency graph |
| `outdo --print-env <task> [--json]` | env with provenance + schema check |
| `outdo doctor [--json]` | every task's `requires` checks |
| `outdo bg start <task> [flags]` | run detached; returns once its service is ready |
| `outdo bg ps \| logs <task> [--follow] \| stop [task...]` | manage background runs (`.outdo/bg/`) |
| `outdo ci <task...> [--all] [--base rev]` | CI run: affected only, grouped logs, failure recap, GitHub annotations and step summary |
| `outdo ci init [--force]` | write `.github/workflows/ci.yml` |
| `outdo affected <task...> [--base rev] [--github-output] [--json]` | `name=true\|false` per task |
| `outdo hooks install \| uninstall \| list \| run <hook>` | git hooks from do.ts |
| `outdo prune --docker [--out dir]` | `out/json/` with every package.json + lockfile |
| `outdo mcp` | MCP server: tasks as tools |
| `outdo skill install [--global]` | install this skill into `.claude/skills` (and `.agents/skills`) |
| `outdo init` | starter do.ts |
| `outdo completion <bash\|zsh\|fish\|powershell>` | shell completion (also completes `bunx outdo`) |

## Flags

Global flags go before the task name; `--mode`, `--yes`, `--from`, `--until` may also follow it.

| flag | meaning |
| --- | --- |
| `-m, --mode <name>` | a declared mode |
| `-y, --yes` | answer protect/confirm questions (only with the user's consent) |
| `--from <step>` / `--until <step>` | range of a task's steps |
| `--dry[=json]` | plan only |
| `--affected[=rev]` | only tasks affected by git changes (CI: PR base or previous push) |
| `-f, --force` | ignore the cache |
| `-w, --watch` | re-run on changes |
| `-j, --concurrency <n>` | parallelism |
| `--continue` | keep going after a failure |
| `--log-order stream\|grouped\|auto`, `--output-logs full\|errors-only\|none` | output shape |
| `-F, --filter <pattern>` | workspace packages |
| `--isolate` | always child processes |
| `--json` | JSON report on stdout |
| `--profile[=file]` | Chrome trace |

## Environment variables

| variable | effect |
| --- | --- |
| `OUTDO_READONLY=1` | refuse any task not marked `readonly` |
| `OUTDO_NO_LOCAL=1` | a global outdo does not hand over to the repo's copy |
| `OUTDO_MODE` | set by outdo for tasks: the active mode |
| `NODE_ENV` | env cascade name when no modes are declared |
| `NO_COLOR` / `FORCE_COLOR` | color |
| `OUTDO_LOG=debug` | debug logging |
