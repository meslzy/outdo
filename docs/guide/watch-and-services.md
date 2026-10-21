# Watch & Services

## Watch mode

```sh
outdo --watch build
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
File events don't propagate on some filesystems. `OUTDO_WATCH_POLL=1 outdo --watch …` switches to a polling backend (500ms mtime scan); outdo also falls back to it automatically if the OS watcher fails.
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
- **You asked for the service** (`outdo dev`): the run stays alive while it lives; Ctrl-C (or SIGTERM) shuts everything down gracefully, and a service that exits **on its own** fails the run: `Service "dev" exited unexpectedly`
- **The service is only a dependency** (`outdo e2e`, where `e2e` needs `dev`): once the tasks you asked for finish, outdo stops it and the run ends — server up, tests, server down, in one command
- Under `--watch`, a service whose globs match a change is **stopped and restarted** (cooperative signal → 5s grace → tree kill), and its readiness probe runs again before dependents re-run

```ts
dev: { persistent: true, ready: { port: 3000 }, run: "bun --watch src/server.ts" },
playwright: "bunx playwright test",
e2e: { steps: ["dev", "playwright"] }, // server up → tests → server stopped
```

```txt
$ outdo e2e
...
✓ playwright (8.2s)
✓ e2e (0ms)
— 2 ok, 1 running · 9.1s total · critical path 9.0s (dev → playwright → e2e)
stopping dev
```

```sh
outdo --watch dev     # edit a file → server restarts with a fresh process
```

Services can't declare `outputs` (they never "complete", so there is nothing to fingerprint) — outdo rejects that combination at load.

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

`outdo web` now brings the stack up **in dependency order, each layer waiting for real readiness**: postgres accepts connections → the API's health check passes → the web dev server prints its ready line.

Exactly one probe per service:

| probe | passes when |
| --- | --- |
| `log: "text"` | any output line (stdout or stderr) contains the substring |
| `url: "http://…"` | a GET returns 2xx (polled every 250ms) |
| `port: 5432` | a TCP connection succeeds (polled every 250ms; `host` defaults to `127.0.0.1`) |

`timeoutMs` (default **30s**) bounds the wait — a service that never becomes ready is stopped, its dependents are skipped, and the run fails with `service "db" was not ready after 30000ms`. A service that *exits* before becoming ready fails the same way, instead of silently unblocking dependents.

## Background runs: `outdo bg`

Start a service (or any task) in the background and get your terminal back once it is ready:

```sh
outdo bg start server          # returns once the server's ready probe passes
outdo bg ps                    # what's running, since when, which port
outdo bg logs server -f        # its output (without -f / --follow: print and exit)
outdo bg stop server           # stop it (no name: stop everything)
```

```txt
$ outdo bg start server
✓ server ready in 606ms (pid 34744 · port 65231, log .outdo/bg/server.log)

$ outdo bg ps
  server  running  pid 34744 · up 12.4s  port 65231
```

- `bg start` plans the run **in the foreground first**: unknown tasks, bad flags, env schemas and [confirmation questions](/guide/safety#protect-and-confirm) happen in your terminal, not in a log file. It then starts a detached `outdo <task>` (passing on `--mode`, `--force`, `-j` and `-F`), logging to `.outdo/bg/<task>.log`.
- For a service it waits for the [readiness probe](#readiness-probes) — up to the probe's `timeoutMs` plus 10s. A service that exits first is reported with the end of its log; one that never gets ready is stopped and reported. A plain task just starts: `▸ build running in the background`.
- Starting something that is already running is a usage error.
- `bg ps` (also plain `outdo bg`, or `--json`) shows `starting`, `running` or `exited`; exited runs are shown once and then forgotten.
- `bg stop` sends SIGTERM to the run's process group, so outdo stops its tasks the normal way (abort signal → 5s grace → tree kill), then kills whatever is left. On Windows it kills the process tree.

State lives in `.outdo/bg/` next to your `do.ts`.
