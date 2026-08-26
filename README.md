# outdo

**Docs:** [meslzy.github.io/outdo](https://meslzy.github.io/outdo/)

A TypeScript-native task runner for [Bun](https://bun.com). Tasks live in a typed `do.ts` at your repo root — no YAML, no Makefile, no DSL. Full editor support (autocomplete, go-to-definition, refactoring), compile-time dependency checking, schema-validated environments, a parallel DAG scheduler with conditional deps and typed data flow between tasks, fingerprint caching that can explain itself, service readiness probes, retries and timeouts, git-aware `--affected` selection, watch mode, workspace awareness, and machine-readable run reports. Zero runtime dependencies.

```ts
// do.ts
import { defineTasks, task } from "outdo";
import { z } from "zod";

export default defineTasks({
 "docker:up": {
  group: "Infra",
  desc: "Start Postgres + Redis",
  run: async ({ $ }) => {
   await $`docker compose up -d postgres redis`;
  },
 },

 "db:reset": {
  group: "Infra",
  desc: "Reset the local database",
  deps: ["docker:up"], // typo here = compile error, with a "did you mean" fix
  run: async ({ $ }) => {
   await $`bun prisma migrate reset --force`;
  },
 },

 build: {
  desc: "Build all packages",
  inputs: ["src/**/*.ts"],  // fingerprint cache: skipped when unchanged
  outputs: ["dist/**"],
  run: async ({ $ }) => {
   await $`bun build src/index.ts --outdir dist`;
  },
 },

 deploy: task({ // task() unlocks typed env + typed CLI flags
  desc: "Deploy to production",
  env: z.object({
   DEPLOY_URL: z.url(),
   RETRIES: z.coerce.number().default(3),
  }),
  args: {
   dry: { type: "boolean", short: "d", description: "Skip the actual push" },
  },
  run: async ({ $, env, args }) => {
   // env.DEPLOY_URL: string — validated BEFORE anything ran
   // env.RETRIES: number — coerced by the schema
   // args.dry: boolean — from `outdo deploy -d`
   if (!args.dry) {
    await $`./scripts/push.sh ${env.DEPLOY_URL}`;
   }
  },
 }),

 dev: {
  desc: "Dev server",
  persistent: true, // service: stays alive
  ready: { url: "http://localhost:3000/health" }, // dependents wait until it's actually up
  deps: ["docker:up"],
  run: async ({ $ }) => {
   await $`bun --watch src/server.ts`;
  },
 },
});
```

```txt
outdo                      # gorgeous grouped task list
outdo build                # run a task + its dependency DAG
outdo deploy -d            # typed per-task flags
outdo deploy --help        # auto-generated per-task help
outdo test -- --bail       # raw passthrough after --
outdo --watch build        # re-run the affected subgraph on file changes
outdo explain build        # why will each task run or skip? (never runs)
outdo --affected test      # only tasks touched by git changes vs the base branch
outdo --json build         # full run report: status, timing, cache, critical path
outdo --profile build      # Chrome trace of the run (chrome://tracing / Perfetto)
outdo --print-env deploy   # which .env file set what + schema verdict
outdo --dry=json build     # machine-readable plan (great for AI agents)
```

## Install

Requires **Bun >= 1.4**. outdo is Bun-only by design — it is built on Bun Shell, `Bun.spawn`, and `Bun.Glob`.

```sh
bun add -d outdo        # per-project (recommended)
bunx outdo init         # scaffold a starter do.ts
# or globally:
bun add -g outdo
```

## Why outdo

| | make / just / Taskfile | turbo / nx | **outdo** |
| --- | --- | --- | --- |
| Task definitions | DSL / YAML strings | JSON config | **typed TypeScript** |
| Dep name typos | caught at invocation | silent no-op / runtime | **compile error in your editor + did-you-mean** |
| Env contracts | presence checks at best | filter/allowlist only | **Standard Schema validation before anything runs** |
| Per-task CLI flags | untyped params (just) / raw args | executor schemas (nx) | **TypeScript-inferred, with auto `--help` + completions** |
| Shell | your `/bin/sh` | your shell | **Bun Shell — cross-platform, injection-safe** |

The honest long-form version — including what outdo **can't** do (no remote cache, skip-not-restore caching, Bun-only) and when to pick Turborepo/Nx/just instead — lives in the docs: [Why outdo?](https://meslzy.github.io/outdo/guide/why-outdo)

## The authoring API

### `defineTasks({...})` — the single default export of `do.ts`

Every task supports:

| field | meaning |
| --- | --- |
| `desc` | one-liner shown in the task list |
| `group` | heading in the task list |
| `deps` | tasks that must finish first — **typo-checked at compile time**; entries can be conditional (`{ task, if }`), `optional()`, or typed `from()` references |
| `inputs` | globs fingerprinted for the cache (skip when unchanged) |
| `outputs` | globs that must exist for a cache hit; deleted outputs force a re-run |
| `watch` | globs that trigger re-runs in `--watch` (defaults to `inputs`) |
| `persistent` | long-running service; dependents unblock when it's ready |
| `ready` | readiness probe for a service: `{ log: "…" }`, `{ port: 5432 }`, or `{ url: "http://…" }` (+ `timeoutMs`, default 30s) |
| `retry` | opt-in re-runs on failure: `3` or `{ attempts, delayMs, backoff: "fixed" \| "exponential" }` |
| `timeoutMs` | per-attempt time budget; cooperative abort → 5s grace → tree kill |
| `cwd` | working directory, relative to `do.ts` |
| `run` | the task body — receives the typed context; its return value is the task's **data output** |

### `task({...})` — builder for typed `env` and `args`

Plain object entries keep the default context. Wrap an entry in `task()` to add:

- **`env`** — any [Standard Schema](https://standardschema.dev) validator (zod v4, valibot, arktype…). outdo depends on none of them. The schema is validated against the resolved environment **before any task in the plan runs** — a missing secret fails in one clean line, not 4 minutes into a build. `ctx.env` is the schema *output*, so `z.coerce.number()` really gives you a `number`.
- **`args`** — declarative typed CLI flags: `{ mode: { type: "string", short: "m", default: "dev", required: false, description: "…" } }`. Parsed strictly, with did-you-mean on typos, auto-generated `outdo <task> --help`, and shell completion.

### Data flows between tasks

A task's `run()` return value is its **data output** — dependents read it from `ctx.deps`, fully typed via `from()`:

```ts
const version = task({
 inputs: ["package.json"],
 run: async () => ({ tag: `v${(await Bun.file("package.json").json()).version}` }),
});

export default defineTasks({
 version,
 release: task({
  deps: [from("version", version)],
  run: async ({ deps, $ }) => {
   await $`git tag ${deps.version.tag}`; // typed: { tag: string }
  },
 }),
});
```

Outputs are JSON, cross process boundaries transparently, and are **replayed from the cache manifest** when the producer is skipped — a cached producer still feeds its consumers. A changed output invalidates dependents' caches too.

### The task context

```ts
run: async ({ $, env, args, deps, rest, signal, log, cwd, name }) => { ... }
```

- `$` — Bun Shell, pre-bound to the task's `cwd` and resolved env. Interpolations are auto-escaped (injection-safe).
- `deps` — data outputs of this task's dependencies (typed via `from()`).
- `rest` — raw args after `--`, delivered **only** to tasks you named on the command line, never to deps.
- `signal` — `AbortSignal`; fires on Ctrl-C, fail-fast aborts, timeouts, and watch supersession. Respect it in loops.
- `log` — prefixed logger safe under concurrent output.

## Environment model

Cascade (lowest → highest), resolved from the `do.ts` directory, matching Bun's own loader byte-for-byte:

```txt
.env → .env.{NODE_ENV} → .env.local (skipped when NODE_ENV=test) → .env.{NODE_ENV}.local → process env
```

`$VAR` / `${VAR}` expand (verified against Bun 1.4: even inside single quotes; `\$` escapes). `outdo --print-env <task>` shows every key, **which file supplied it, and what it overrode**, plus the schema verdict — without running anything.

## Execution model

- Dependencies form a DAG; cycles are rejected at load with the exact path (even cycles hiding behind inactive conditional edges).
- Dep entries can be **conditional** (`{ task: "test", if: "CI" }` — env-var truthiness or a predicate over the resolved env) or **optional** (`optional("notify")` — dropped when absent).
- Independent branches run **in parallel** (`-j/--concurrency` caps it), each task in its own process with output multiplexed as `name | line` prefixes (`--log-order=stream`) or buffered per task (`grouped`; the default in CI).
- Failures **fail fast**: running siblings get a cooperative abort (signal → 5s grace → tree kill), pending dependents are skipped. `--continue` runs everything independent instead. Opt-in `retry` re-runs flaky tasks; `timeoutMs` bounds each attempt.
- Pure dependency chains skip the child processes entirely and run in-process with fully inherited stdio — colors, progress bars, and interactive prompts just work.
- Services (`persistent: true`) don't hold a concurrency slot; with a `ready` probe (log line / TCP port / HTTP 2xx), dependents wait for actual readiness — `outdo dev` brings up db → api → web in real order. The run stays alive while services live and fails if one dies.
- Every run ends with a timing summary including the **critical path** — the dep chain that bounded your wall-clock time. `--profile` exports a Chrome trace; `--json` emits a full run report (per-task status, duration, cache result) on stdout.

## Caching

Declare `inputs` (and ideally `outputs`) and outdo skips tasks whose world hasn't changed. The fingerprint covers: input file **contents** (mtime+size fast path — `touch` won't bust it, edits will), the task definition including the `run` body text, the validated env output, CLI args and passthrough, dependency fingerprints (upstream changes cascade), and dependency **data outputs**. State lives in `.outdo/` (gitignore it — `outdo init` does). `--force` bypasses.

Each fingerprint component is hashed separately, so `outdo explain <task>` can tell you **exactly why** something will re-run — `inputs changed (modified: src/app.ts)`, `env changed`, `dependency outputs changed` — without running anything.

## Git-aware runs: `--affected`

`outdo test --affected` diffs against the merge-base with origin's default branch (or `--affected=<rev>`) and keeps only the requested tasks that could have changed: input-glob matches, package-level changes, workspace **dependents** of changed packages, and task-graph dependents. Committed, staged, unstaged, and untracked changes all count. Perfect for monorepo CI.

## Watch mode

`outdo --watch <task>` runs the plan, then watches each task's `watch` (or `inputs`) globs. On change: affected tasks + their dependents re-run in topo order; services whose globs match are restarted; changes arriving mid-run supersede it. `OUTDO_WATCH_POLL=1` forces the polling backend (Docker volumes, NFS).

## Workspaces

At a Bun workspace root, outdo merges the root `do.ts` with every member's `do.ts`. Member tasks are namespaced `pkg#task`:

```sh
outdo build                  # fans out: root build + api#build + web#build + ...
outdo api#build              # exactly one member
outdo -F api build           # filter: exact name
outdo -F '@acme/*' build     #         name glob
outdo -F ./packages/api build#         path
outdo -F ...api build        #         api + its workspace dependencies
outdo -F lib... build        #         lib + everything depending on it
```

Member deps stay file-local; each member task runs in its own directory. Inside a member directory, outdo stays member-local.

## CLI reference

```txt
outdo                        List tasks, grouped
outdo <task> [flags] [-- args]
outdo <t1> <t2>              Multiple tasks
outdo ls --json              Machine-readable task model
outdo graph [--dot] [--json] Dependency graph (mermaid / graphviz / JSON)
outdo explain <task>         Why each planned task will run or skip (never runs)
outdo --print-env <task>     Env provenance + schema validation (never runs)
outdo init                   Scaffold do.ts
outdo completion <shell>     bash | zsh | fish | powershell

-w, --watch                  -j, --concurrency <n>       --continue
    --dry[=json]             -f, --force                 -F, --filter <pat>
    --affected[=<rev>]       --profile[=<file>]          --isolate
    --log-order <mode>       --output-logs <mode>        --json
    --color <mode> / --no-color                          -h, --help
```

Exit codes: `0` ok · `1` task failure · `2` usage · `3` config/env invalid · `130` interrupted. With `--json`, errors print `{"error":{"code","message","detail"}}` on stderr.

## For AI agents

outdo is deliberately agent-friendly: `outdo ls --json` exposes the full task model (flags, deps, env requirements), `--dry=json` previews any plan, `outdo --json explain <task>` diagnoses cache decisions down to the changed file, `--print-env --json` explains configuration, and `outdo --json <task>` ends with a complete run report (per-task status, timing, cache result, critical path) on stdout instead of log soup. Errors are machine-parseable, and dep typos are compile errors an agent sees in the editor before ever running anything.

## Performance

Zero runtime dependencies; the CLI hot path statically imports three small modules and lazy-loads everything else. Measured on the reference machines: the bundled CLI adds ~25ms over a bare `bun` process spawn (which is ~5ms on Linux, ~40ms on Windows).

## License

MIT
