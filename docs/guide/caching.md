# Caching

Declare what a task reads and writes, and outdo skips it when nothing changed:

```ts
build: {
	desc: "Build the project",
	inputs: ["src/**/*.ts", "tsconfig.json"], // [!code ++]
	outputs: ["dist/**"], // [!code ++]
	run: async ({ $ }) => {
		await $`bun build src/index.ts --outdir dist`;
	},
},
```

<CacheRace />

## What's in the fingerprint

A task is skipped only when **all** of these are unchanged:

1. **Input file contents** — real content hashes with an mtime+size fast path: `touch` won't bust the cache, actual edits will
2. **The task definition itself** — including the text of the `run` body (or the command); edit the code, invalidate the cache
3. **Validated env output** — change `DEPLOY_URL` and the task re-runs (only for tasks with an `env` schema)
4. **CLI args and `--` passthrough**
5. **Dependency fingerprints** — upstream changes cascade downstream automatically
6. **Dependency [data outputs](/guide/tasks-and-deps#task-outputs-as-data)** — a dep whose `run()` returned a different value invalidates its consumers, even when the dep itself isn't cacheable

Plus: every declared `outputs` glob must still match at least one file — or be [restorable](#deleted-outputs-come-back).

Each component is hashed **separately** and stored in the manifest, which is what lets [`outdo explain`](#why-will-this-re-run) tell you exactly which one changed.

## What a hit gives you

On a hit the task doesn't run (`✓ build (cached)` in ~0ms), and three things come back from the last successful run:

- its [data output](/guide/tasks-and-deps#task-outputs-as-data), replayed from the manifest, so dependents keep working across cache skips
- its **declared outputs**, when you deleted them (below)
- its **log**, printed again — for runs that used child processes (parallel plans, `--isolate`, `outdo ci`), outdo keeps the last 2,000 output lines of each cacheable task

### Deleted outputs come back

After a successful run, outdo copies the files matched by `outputs` into `.outdo/cache/` (the latest run only). When the fingerprint still matches but the outputs are gone, it copies them back instead of re-running:

```txt
$ rm -rf dist && outdo build
✓ build (cached, outputs restored)
```

- Only a complete copy is restored; otherwise the task re-runs.
- Outputs larger than 256 MB in total are not stored — those tasks re-run when their outputs go missing.
- `--dry` and `explain` never write files; they report a restorable task as "would skip".
- `--force` always re-runs (and stores fresh copies).

This is a **local** cache: nothing is shared between machines. That's still Turborepo/Nx territory — see [Why outdo?](/guide/why-outdo).

Cache state lives in `.outdo/cache/` next to your `do.ts`.

::: warning
Add `.outdo/` to `.gitignore` — `outdo init` does this for you. The cache is per-machine state, not shared artifacts.
:::

## Why will this re-run?

Stop guessing — ask:

```sh
outdo explain build
```

```txt
build — Build the project
backend: sequential (in-process)

plan (dependencies first):
  ✓ codegen   would skip (cached)
  ↻ build     would run — inputs changed (modified: src/app.ts)

details for build:
  deps:     codegen
  inputs:   src/**/*.ts (14 files), tsconfig.json (1 file)
  outputs:  dist/** (present)
  env:      no schema
  cache:    miss — inputs changed (modified: src/app.ts)
```

`explain` walks the plan read-only (nothing runs, nothing is written) and diagnoses each task's cache verdict by fingerprint component: `no previous run`, `inputs changed` (with the exact files), `env changed`, `args changed`, `task definition changed`, `dependency outputs changed`, `declared outputs missing`, or `--force`. Add `--json` for the machine-readable version.

## Controlling it

```sh
outdo --force build     # ignore stored fingerprints (still records new ones)
outdo --dry build       # shows which planned tasks would be cache-skipped
outdo explain build     # explains *why* each task will run or skip
```

Tasks without `inputs` never cache — they run every time. Services (`persistent: true`) and aggregation tasks (no `run`) never cache either. Command tasks and package.json scripts cache like any other task once you give them `inputs` (for a script, through a `do.ts` entry or [member defaults](/guide/workspaces#member-defaults-replacing-turbo)).

::: details Known blind spot: closures
The fingerprint hashes the `run` function's **source text**. A value captured from outside the function body (a top-level constant, an import) can change without the text changing. Keep task-relevant values inside the body, model them as `env`/`args`, or use `--force` when in doubt.
:::
