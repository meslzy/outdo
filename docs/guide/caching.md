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

Plus: every declared `outputs` glob must still match at least one file. Delete `dist/` and the task re-runs even though inputs are unchanged.

## What it is — and isn't

bundo's cache is **skip-if-unchanged**, not artifact restore. On a hit, the task simply doesn't run (`✓ build (cached)` in ~0ms). bundo does **not** store copies of your outputs and cannot re-materialize a deleted `dist/` from a cache archive — that's Turborepo/Nx territory (and why those tools exist). See [Why bundo?](/guide/why-bundo) for the honest comparison.

Fingerprints live in `.bundo/cache/` next to your `do.ts`.

::: warning
Add `.bundo/` to `.gitignore` — `bundo init` does this for you. Fingerprints are per-machine state, not shared artifacts.
:::

## Controlling it

```sh
bundo --force build     # ignore stored fingerprints (still records new ones)
bundo --dry build       # shows which planned tasks would be cache-skipped
```

Tasks without `inputs` never cache — they run every time. Services (`persistent: true`) never cache either.

::: details Known blind spot: closures
The fingerprint hashes the `run` function's **source text**. A value captured from outside the function body (a top-level constant, an import) can change without the text changing. Keep task-relevant values inside the body, model them as `env`/`args`, or use `--force` when in doubt.
:::
