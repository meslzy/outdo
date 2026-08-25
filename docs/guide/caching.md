# Caching

Declare what a task reads and writes, and bundo skips it when nothing changed:

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
2. **The task definition itself** — including the text of the `run` body; edit the code, invalidate the cache
3. **Validated env output** — change `DEPLOY_URL` and the task re-runs (only for tasks with an `env` schema)
4. **CLI args and `--` passthrough**
5. **Dependency fingerprints** — upstream changes cascade downstream automatically
6. **Dependency [data outputs](/guide/tasks-and-deps#task-outputs-as-data)** — a dep whose `run()` returned a different value invalidates its consumers, even when the dep itself isn't cacheable

Plus: every declared `outputs` glob must still match at least one file. Delete `dist/` and the task re-runs even though inputs are unchanged.

Each component is hashed **separately** and stored in the manifest, which is what lets [`bundo explain`](#why-will-this-re-run) tell you exactly which one changed.

## What it is — and isn't

bundo's cache is **skip-if-unchanged**, not artifact restore. On a hit, the task simply doesn't run (`✓ build (cached)` in ~0ms). bundo does **not** store copies of your outputs and cannot re-materialize a deleted `dist/` from a cache archive — that's Turborepo/Nx territory (and why those tools exist). See [Why bundo?](/guide/why-bundo) for the honest comparison.

Fingerprints live in `.bundo/cache/` next to your `do.ts`.

::: warning
Add `.bundo/` to `.gitignore` — `bundo init` does this for you. Fingerprints are per-machine state, not shared artifacts.
:::

On a hit, one thing *is* restored: the task's [data output](/guide/tasks-and-deps#task-outputs-as-data) is replayed from the manifest, so dependents keep working across cache skips.

## Why will this re-run?

Stop guessing — ask:

```sh
bundo explain build
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
bundo --force build     # ignore stored fingerprints (still records new ones)
bundo --dry build       # shows which planned tasks would be cache-skipped
bundo explain build     # explains *why* each task will run or skip
```

Tasks without `inputs` never cache — they run every time. Services (`persistent: true`) never cache either.

::: details Known blind spot: closures
The fingerprint hashes the `run` function's **source text**. A value captured from outside the function body (a top-level constant, an import) can change without the text changing. Keep task-relevant values inside the body, model them as `env`/`args`, or use `--force` when in doubt.
:::
