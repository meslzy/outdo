# Changelog

All notable changes to bundo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com); versions follow
[SemVer](https://semver.org) (0.x — the API may still move).

Each published version gets a git tag (`v<version>`) and a GitHub Release
created automatically by the release workflow.

## 0.0.1 - 2026-08-25

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
- `bundo explain <task>` — per-component cache diagnosis without running.

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
