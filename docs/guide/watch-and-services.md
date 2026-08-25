# Watch & Services

## Watch mode

```sh
bundo --watch build
```

Runs the plan once, then watches each task's `watch` globs (falling back to its `inputs`). On change:

1. Changed paths are matched to tasks; their **dependents join automatically**
2. The affected subgraph re-runs in topological order (cache still applies — a `touch` re-triggers but cache-skips)
3. Changes arriving **mid-run supersede it**: the in-flight run is aborted and the new batch runs with everything coalesced

```ts
"typecheck:watch": {
	desc: "Continuous typecheck",
	watch: ["src/**/*.ts", "tsconfig.json"], // [!code highlight]
	run: async ({ $ }) => {
		await $`tsc --noEmit`;
	},
},
```

::: tip Docker volumes, NFS, network drives
File events don't propagate on some filesystems. `BUNDO_WATCH_POLL=1 bundo --watch …` switches to a polling backend (500ms mtime scan); bundo also falls back to it automatically if the OS watcher fails.
:::

::: warning Self-triggering loops
A task whose `run` writes into its own watched globs re-triggers itself forever. Keep `outputs` out of `watch`/`inputs` patterns (e.g. watch `src/**`, write to `dist/`).
:::

## Services

Mark long-running processes — dev servers, tunnels, compose stacks — as `persistent`:

```ts
dev: {
	desc: "API dev server",
	persistent: true, // [!code highlight]
	deps: ["docker:up"],
	watch: ["src/**/*.ts"],
	run: async ({ $, signal }) => {
		await $`bun --watch src/server.ts`;
	},
},
```

Service semantics:

- **Dependents unblock as soon as the service has spawned** (no readiness probe in v1 — gate manually if you need one)
- Services don't consume a concurrency slot — ten services won't starve your build tasks
- The run **stays alive while services live**; Ctrl-C shuts everything down gracefully
- A service that exits **on its own** fails the run: `Service "dev" exited unexpectedly`
- Under `--watch`, a service whose globs match a change is **stopped and restarted** (cooperative signal → 5s grace → tree kill)

```sh
bundo --watch dev     # edit a file → server restarts with a fresh process
```

Services can't declare `outputs` (they never "complete", so there is nothing to fingerprint) — bundo rejects that combination at load.
