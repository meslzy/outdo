# Execution Model

`bundo <task>` resolves the task's transitive dependency closure into a DAG, rejects cycles at load (with the exact path), and executes dependencies first — **in parallel wherever the graph allows**.

<DagDemo />

Above: bundo's own `check` task. `typecheck`, `lint`, and `test` share no edges, so they start simultaneously; `check` unblocks the moment the slowest finishes.

## Concurrency

```sh
bundo check          # parallel branches, one process per task
bundo -j 2 check     # cap at 2 concurrent tasks
bundo -j 1 check     # fully serialized
```

Default concurrency is your CPU count. Pure dependency *chains* skip child processes entirely and run in-process with fully inherited stdio — colors, progress bars, and interactive prompts just work.

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

`stream` interleaves lines live; `grouped` buffers each task and flushes it as one contiguous block on completion. `--output-logs=errors-only|none` trims further.

## Failure semantics

**Fail-fast is the default.** When a task fails:

1. Tasks that depend on it (transitively) are **skipped**
2. Running siblings receive a **cooperative abort** — their `ctx.signal` fires, then after a 5s grace period the whole process tree is killed
3. bundo exits `1` with a summary: `— 2 ok, 1 failed, 2 skipped`

```sh
bundo --continue check   # run everything independent of the failure anyway
```

::: tip Respect the signal
Long-running task bodies should check `ctx.signal.aborted` (or pass it to APIs that accept `AbortSignal`) so fail-fast and Ctrl-C stay graceful. Anything that ignores it gets tree-killed after the grace period.
:::

## Ctrl-C

First Ctrl-C: cooperative shutdown (same abort → grace → kill cascade), exit `130`. Second Ctrl-C: immediate hard kill of every child process tree.

## Passing extra arguments

Everything after `--` goes verbatim to the tasks you named — never to their dependencies:

```sh
bundo test -- --bail     # ctx.rest === ["--bail"] in test; deps get []
```
