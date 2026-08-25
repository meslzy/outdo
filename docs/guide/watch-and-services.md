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

- **Dependents unblock when the service is [ready](#readiness-probes)** — or on spawn, if no probe is declared
- Services don't consume a concurrency slot — ten services won't starve your build tasks
- The run **stays alive while services live**; Ctrl-C shuts everything down gracefully
- A service that exits **on its own** fails the run: `Service "dev" exited unexpectedly`
- Under `--watch`, a service whose globs match a change is **stopped and restarted** (cooperative signal → 5s grace → tree kill), and its readiness probe runs again before dependents re-run

```sh
bundo --watch dev     # edit a file → server restarts with a fresh process
```

Services can't declare `outputs` (they never "complete", so there is nothing to fingerprint) — bundo rejects that combination at load.

## Readiness probes

By default a service unblocks its dependents the moment it spawns. Declare `ready` to make dependents wait for the service to actually be **up**:

```ts
db: {
	persistent: true,
	ready: { port: 5432 }, // TCP connect succeeds // [!code highlight]
	run: async ({ $ }) => { await $`docker compose up postgres`; },
},
api: {
	persistent: true,
	deps: ["db"],
	ready: { url: "http://localhost:3000/health" }, // HTTP 2xx // [!code highlight]
	run: async ({ $ }) => { await $`bun src/server.ts`; },
},
web: {
	persistent: true,
	deps: ["api"],
	ready: { log: "ready in" }, // substring on the service's own output // [!code highlight]
	run: async ({ $ }) => { await $`bun run dev`; },
},
```

`bundo web` now brings the stack up **in dependency order, each layer waiting for real readiness**: postgres accepts connections → the API's health check passes → the web dev server prints its ready line.

Exactly one probe per service:

| probe | passes when |
| --- | --- |
| `log: "text"` | any output line (stdout or stderr) contains the substring |
| `url: "http://…"` | a GET returns 2xx (polled every 250ms) |
| `port: 5432` | a TCP connection succeeds (polled every 250ms; `host` defaults to `127.0.0.1`) |

`timeoutMs` (default **30s**) bounds the wait — a service that never becomes ready is stopped, its dependents are skipped, and the run fails with `service "db" was not ready after 30000ms`. A service that *exits* before becoming ready fails the same way, instead of silently unblocking dependents.
