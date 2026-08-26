# Execution Model

`outdo <task>` resolves the task's transitive dependency closure into a DAG, rejects cycles at load (with the exact path), and executes dependencies first — **in parallel wherever the graph allows**.

<DagDemo />

Above: outdo's own `check` task. `typecheck`, `lint`, and `test` share no edges, so they start simultaneously; `check` unblocks the moment the slowest finishes.

## Concurrency

```sh
outdo check          # parallel branches, one process per task
outdo -j 2 check     # cap at 2 concurrent tasks
outdo -j 1 check     # fully serialized
```

Default concurrency is your CPU count. Pure dependency *chains* skip child processes entirely and run in-process with fully inherited stdio — colors, progress bars, and interactive prompts just work. A chain still uses child processes when the run needs them: services, `timeoutMs` tasks (the budget must be enforceable), or output-shaping flags (`--json`, `--profile`, explicit `--log-order`/`--output-logs`, `--isolate`).

## Multiplexed output

Concurrent tasks get their output prefixed and colorized per task:

::: code-group

```txt [--log-order=stream (default in a terminal)]
typecheck | $ tsc --noEmit
lint      | $ biome check .
lint      | ✓ clean
typecheck | ✓ no errors
✓ typecheck (1.7s)
✓ lint (0.4s)
```

```txt [--log-order=grouped (default in CI)]
typecheck | $ tsc --noEmit
typecheck | ✓ no errors
lint      | $ biome check .
lint      | ✓ clean
✓ typecheck (1.7s)
✓ lint (0.4s)
```

:::

`stream` interleaves lines live; `grouped` buffers each task and flushes it as one contiguous block on completion. `--output-logs=errors-only` buffers every task and prints output only for the ones that fail (whether a task's output matters isn't known until it settles); `--output-logs=none` suppresses task output entirely.

## Failure semantics

**Fail-fast is the default.** When a task fails:

1. Tasks that depend on it (transitively) are **skipped**
2. Running siblings receive a **cooperative abort** — their `ctx.signal` fires, then after a 5s grace period the whole process tree is killed
3. outdo exits `1` with a summary: `— 2 ok, 1 failed, 2 skipped · 3.1s total`

```sh
outdo --continue check   # run everything independent of the failure anyway
```

## Retries

Retries are **opt-in per task** — outdo never silently re-runs anything:

```ts
deploy: {
	retry: { attempts: 3, delayMs: 500, backoff: "exponential" },
	run: async ({ $ }) => { await $`bun run deploy`; },
},
smoke: {
	retry: 2, // shorthand: up to 2 total attempts
	run: async ({ $ }) => { await $`curl -f https://example.com/health`; },
},
```

- `attempts` counts **total** runs, including the first. `backoff: "exponential"` doubles `delayMs` per retry.
- Each attempt is a fresh execution (fresh process on the child backend). Failed attempts print `↻ deploy failed — retrying (attempt 2/3)`.
- Fail-fast and Ctrl-C cancel a pending retry delay immediately.
- Caching interacts sanely: the result is cached only after a **successful** attempt, and `✓ deploy (2.3s, 2 attempts)` tells you it was bumpy.
- Services can't declare `retry` (watch mode restarts them instead).

## Timeouts

```ts
e2e: {
	timeoutMs: 120_000,
	run: async ({ $, signal }) => { await $`bun run e2e`; },
},
```

When the budget is exceeded, the task gets the standard cooperative abort (`ctx.signal` fires → 5s grace → tree kill) and fails with `timed out after 120000ms`. The budget is **per attempt**, so it composes with `retry`. Plans containing a `timeoutMs` task always use the child-process backend, so the kill is real even for a run body that ignores the signal — a timeout that can't be enforced would just be a hang.

## The run report (`--json`)

`outdo <task> --json` moves all task logs to stderr and prints exactly one JSON document on stdout when the run finishes — status, timing, and cache result per task, plus the [critical path](#timing-and-the-critical-path):

```sh
outdo build --json | jq '.summary'
```

See [Exit Codes & JSON](/reference/exit-codes-and-json#run-report-json) for the full schema. The report is also emitted on failure (the process still exits `1` with the error JSON on stderr), which makes it ideal for CI and [AI agents](/reference/ai-agents).

## Timing and the critical path

Every run ends with a timing summary:

```txt
— 5 ok (2 cached) · 3.2s total · critical path 2.8s (a → b → d)
```

The **critical path** is the dependency chain that determined your wall-clock time — the thing to optimize when a run feels slow. For the full picture:

```sh
outdo build --profile          # writes .outdo/trace.json
outdo build --profile=t.json   # custom path
```

The trace is Chrome trace-event format — open it in `chrome://tracing` or [Perfetto](https://ui.perfetto.dev) to see every task as a timeline slice, lane-packed by actual concurrency.

::: tip Respect the signal
Long-running task bodies should check `ctx.signal.aborted` (or pass it to APIs that accept `AbortSignal`) so fail-fast and Ctrl-C stay graceful. Anything that ignores it gets tree-killed after the grace period.
:::

## Ctrl-C

First Ctrl-C: cooperative shutdown (same abort → grace → kill cascade), exit `130`. Second Ctrl-C: immediate hard kill of every child process tree.

## Passing extra arguments

Everything after `--` goes verbatim to the tasks you named — never to their dependencies:

```sh
outdo test -- --bail     # ctx.rest === ["--bail"] in test; deps get []
```
