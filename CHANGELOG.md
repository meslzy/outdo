# Changelog

All notable changes to outdo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com); versions follow
[SemVer](https://semver.org) (0.x — the API may still move).

Each published version gets a git tag (`v<version>`) and a GitHub Release
created automatically by the release workflow.

## 0.1.0 - 2026-10-28

The big release: outdo becomes the whole task layer — package.json scripts,
turbo, makefiles, .githooks, paths filters and compose wrappers included.

### Task authoring

- One-line tasks: an entry can be a command string or a list of commands;
  `run` accepts the same. Args after `--` are appended.
- `task()` is optional: `env`, `args` and `deps` on an inline object type
  `run`'s context (needs TypeScript 6 for full narrowing).
- Flags can be any Standard Schema (`z.enum(...)`, `z.coerce.number()`,
  arrays) — validated before anything runs, with choices, defaults and
  descriptions read from the schema's JSON Schema. ArgSpec gains `choices`
  (enforced) and `suggest` (completion only).
- `positional`: flags given as bare words (`outdo logs api`).
- `steps` (one after another, `--from` / `--until`) and `finally` (always runs
  afterwards).
- `ns()` namespaces: `outdo db reset` / `outdo db:reset`, `outdo db` lists.
- package.json scripts are tasks (`bun run <script>`); a repo needs no
  do.ts. A do.ts entry without `run`/`steps` decorates the same-named script.
- `defineTasks(tasks, { modes, members, hooks })`: `--mode` with
  `.env.<mode>` files and `ctx.mode`; workspace member defaults; git hooks.
- New fields: `envFiles`, `protect`, `confirm`, `requires`, `readonly`,
  `destructive`. New context: `ctx.root`, `ctx.mode`, `ctx.ssh`. `Shell` type
  exported.
- Workspaces: member package.json scripts become `pkg#task`; `^name` and
  `pkg#name` deps cross packages (replaces turbo's `dependsOn`).
- `@meslzy/outdo/compose`: up, down, restart, rebuild, fresh, logs, ps,
  shell, exec.

### Commands

- `outdo run <task>`, `outdo -i` (picker), `outdo doctor`.
- `outdo bg start | ps | logs | stop` — background runs that return once ready.
- `outdo ci <task>` (affected only, folded logs, failure recap, GitHub
  annotations and step summary) and `outdo ci init`.
- `outdo affected <task> --github-output`.
- `outdo hooks install | uninstall | list | run` with `restage`.
- `outdo prune --docker`.
- `outdo mcp` — tasks as MCP tools.
- `outdo skill install [--global]` — the bundled agent skill (also
  `bunx skills add meslzy/outdo`).
- Runner flags `--mode`, `--yes`, `--from`, `--until` may follow the task name.

### Usage report

- Every run is recorded in `.outdo/usage.jsonl`: tasks asked for, everything
  planned, flags given (values only for flags with choices), mode, where it
  came from (cli, picker, watch, bg, ci, hook, mcp, nested) and whether an
  agent ran it (`AI_AGENT`, `CLAUDECODE`, ...). Off in CI and with
  `OUTDO_NO_USAGE=1`; never under `--dry`.
- `outdo usage [task] [--since 30d] [--all] [--no-history] [--json]`: most
  used tasks (you / agent / as a dependency / shell history), tasks nothing
  uses, tasks only external files use (CI workflows, package.json scripts,
  Dockerfiles, hooks), flags never passed, choices never picked, modes,
  hooks, and duplicates — package.json scripts a do.ts task hides, entries
  whose run is `bun run <own name>`, aliases, the same command or steps
  twice, scripts that only call outdo. Shell history (zsh, bash, fish,
  PowerShell) backfills the time before recording started.

### Caching

- Declared outputs are stored after a successful run and restored when
  deleted (`✓ build (cached, outputs restored)`); logs are replayed on hits.

### CLI & completion

- Completion of flag values, positional values, namespaces, modes, steps and
  packages; `bunx outdo` completes in every shell; the task list is cached in
  `.outdo/complete.json` so Tab doesn't import do.ts.
- zsh completion fixed (it errored on every Tab).
- A global `outdo` hands over to the repo's installed copy
  (`OUTDO_NO_LOCAL=1` to opt out).
- `--affected` reads the base from GitHub Actions (PR base / previous push).

### Changed (may affect existing setups)

- A persistent task pulled in only as a dependency is now stopped when the
  requested tasks finish; the run no longer waits on it. A requested service
  still keeps the run alive.
- Deleting declared outputs restores them from the cache instead of
  re-running (`--force` re-runs).
- `protect` / `confirm` tasks refuse to run without a terminal unless
  `--yes` is given.
- In workspaces, a bare name no longer reaches member package.json scripts
  when the root has a task of that name (member do.ts tasks still fan out).
- Unknown fields on a task object are a config error (exit 3).
- `run`, `bg`, `ci`, `affected`, `hooks`, `prune`, `mcp`, `doctor`, `usage`
  and `skill` are commands; a task with one of those names runs with
  `outdo run <name>`.
- `-m`, `-y`, `-i` are new global short flags.
- New error code `refused` (exit 2) for declined confirmations and
  `OUTDO_READONLY`.

## 0.0.1 - 2026-08-26

First release.

### Task authoring

- Typed `do.ts` via `defineTasks()` / `task()` — compile-time dependency
  checking with did-you-mean, typed `env` (Standard Schema: zod / valibot /
  arktype) validated before anything runs, typed per-task CLI `args` with
  auto-generated `--help` and shell completions.
- Conditional deps (`{ task, if: "CI" | (env) => boolean }`) and optional deps
  (`optional("name")`).
- Task data outputs: `run()`'s return value flows to dependents via
  `ctx.deps`, typed end-to-end with `from()`, replayed from cache on hits.

### Execution

- Parallel DAG scheduler with fail-fast, `--continue`, multiplexed output,
  and an in-process fast path for pure dependency chains.
- Services (`persistent: true`) with readiness probes
  (`ready: { log | url | port }`) gating dependents.
- Opt-in `retry` policies and per-attempt `timeoutMs`.
- Watch mode with affected-subgraph re-runs and service restarts.

### Caching

- Fingerprint cache (content-hashed inputs with an mtime+size fast path,
  task definition, env output, args, dep fingerprints, dep data outputs).
- `outdo explain <task>` — per-component cache diagnosis without running.

### Monorepos

- Bun workspace awareness (`pkg#task`, bare-name fan-out, `--filter`
  microsyntax) and git-aware `--affected[=rev]` selection.

### Hardening (pre-release review)

- A full-code review pass fixed 25+ confirmed defects before first publish,
  including: an IPC race that could report a green task as failed; unenforceable
  in-process timeouts (timeout plans now always use the child backend); cache
  I/O failures crashing the scheduler (now degrade to uncached success); empty
  `ctx.args` in multi-task runs; `--affected` silently doing nothing on failing
  git commands, non-ASCII paths, and subdirectory repos; garbled zsh
  completions; a constructible cache-fingerprint collision; watch-mode error
  handling (watcher errors now fall back to polling, Ctrl-C aborts in-flight
  re-runs); UTF-8-safe multiplexed output with per-fd grouped flushing; and
  `--output-logs=errors-only` now working in stream order.

### Observability & automation

- `--json` run report (per-task status, timing, cache result, critical path),
  `--profile` Chrome trace export, `ls --json`, `graph --json`, `--dry=json`,
  `--print-env --json`, stable exit codes, machine-readable errors,
  `llms.txt` on the docs site.
