# bundo

A TypeScript-native task runner for [Bun](https://bun.com). Tasks live in a typed `do.ts` at your repo root — no YAML, no Makefile, no DSL. Full editor support (autocomplete, go-to-definition, refactoring), compile-time dependency checking, schema-validated environments, a parallel DAG scheduler, fingerprint caching, watch mode, and workspace awareness. Zero runtime dependencies.

```ts
// do.ts
import { defineTasks, task } from "bundo";
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
   // args.dry: boolean — from `bundo deploy -d`
   if (!args.dry) {
    await $`./scripts/push.sh ${env.DEPLOY_URL}`;
   }
  },
 }),

 dev: {
  desc: "Dev server",
  persistent: true, // service: stays alive, dependents start once spawned
  deps: ["docker:up"],
  run: async ({ $ }) => {
   await $`bun --watch src/server.ts`;
  },
 },
});
```

```
bundo                      # gorgeous grouped task list
bundo build                # run a task + its dependency DAG
bundo deploy -d            # typed per-task flags
bundo deploy --help        # auto-generated per-task help
bundo test -- --bail       # raw passthrough after --
bundo --watch build        # re-run the affected subgraph on file changes
bundo --print-env deploy   # which .env file set what + schema verdict
bundo --dry=json build     # machine-readable plan (great for AI agents)
```

## Install

Requires **Bun >= 1.4**. bundo is Bun-only by design — it is built on Bun Shell, `Bun.spawn`, and `Bun.Glob`.

```sh
bun add -d bundo        # per-project (recommended)
bunx bundo init         # scaffold a starter do.ts
# or globally:
bun add -g bundo
```

## Why bundo

| | make / just / Taskfile | turbo / nx | **bundo** |
| --- | --- | --- | --- |
| Task definitions | DSL / YAML strings | JSON config | **typed TypeScript** |
| Dep name typos | runtime error | runtime error | **compile error + editor autocomplete** |
| Env contracts | none | var allowlists | **Standard Schema validation before anything runs** |
| Per-task CLI flags | none | none | **typed, with auto `--help` + completions** |
| Shell | your `/bin/sh` | your shell | **Bun Shell — cross-platform, injection-safe** |

## The authoring API

### `defineTasks({...})` — the single default export of `do.ts`

Every task supports:

| field | meaning |
| --- | --- |
| `desc` | one-liner shown in the task list |
| `group` | heading in the task list |
| `deps` | tasks that must finish first — **typo-checked at compile time** |
| `inputs` | globs fingerprinted for the cache (skip when unchanged) |
| `outputs` | globs that must exist for a cache hit; deleted outputs force a re-run |
| `watch` | globs that trigger re-runs in `--watch` (defaults to `inputs`) |
| `persistent` | long-running service; dependents unblock on spawn |
| `cwd` | working directory, relative to `do.ts` |
| `run` | the task body — receives the typed context |

### `task({...})` — builder for typed `env` and `args`

Plain object entries keep the default context. Wrap an entry in `task()` to add:

- **`env`** — any [Standard Schema](https://standardschema.dev) validator (zod v4, valibot, arktype…). bundo depends on none of them. The schema is validated against the resolved environment **before any task in the plan runs** — a missing secret fails in one clean line, not 4 minutes into a build. `ctx.env` is the schema *output*, so `z.coerce.number()` really gives you a `number`.
- **`args`** — declarative typed CLI flags: `{ mode: { type: "string", short: "m", default: "dev", required: false, description: "…" } }`. Parsed strictly, with did-you-mean on typos, auto-generated `bundo <task> --help`, and shell completion.

### The task context

```ts
run: async ({ $, env, args, rest, signal, log, cwd, name }) => { ... }
```

- `$` — Bun Shell, pre-bound to the task's `cwd` and resolved env. Interpolations are auto-escaped (injection-safe).
- `rest` — raw args after `--`, delivered **only** to tasks you named on the command line, never to deps.
- `signal` — `AbortSignal`; fires on Ctrl-C, fail-fast aborts, and watch supersession. Respect it in loops.
- `log` — prefixed logger safe under concurrent output.

## Environment model

Cascade (lowest → highest), resolved from the `do.ts` directory, matching Bun's own loader byte-for-byte:

```
.env → .env.{NODE_ENV} → .env.local (skipped when NODE_ENV=test) → .env.{NODE_ENV}.local → process env
```

`$VAR` / `${VAR}` expand (verified against Bun 1.4: even inside single quotes; `\$` escapes). `bundo --print-env <task>` shows every key, **which file supplied it, and what it overrode**, plus the schema verdict — without running anything.

## Execution model

- Dependencies form a DAG; cycles are rejected at load with the exact path.
- Independent branches run **in parallel** (`-j/--concurrency` caps it), each task in its own process with output multiplexed as `name | line` prefixes (`--log-order=stream`) or buffered per task (`grouped`; the default in CI).
- Failures **fail fast**: running siblings get a cooperative abort (signal → 5s grace → tree kill), pending dependents are skipped. `--continue` runs everything independent instead.
- Pure dependency chains skip the child processes entirely and run in-process with fully inherited stdio — colors, progress bars, and interactive prompts just work.
- Services (`persistent: true`) don't hold a concurrency slot; the run stays alive while they live and fails if one dies.

## Caching

Declare `inputs` (and ideally `outputs`) and bundo skips tasks whose world hasn't changed. The fingerprint covers: input file **contents** (mtime+size fast path — `touch` won't bust it, edits will), the task definition including the `run` body text, the validated env output, CLI args and passthrough, and dependency fingerprints (upstream changes cascade). State lives in `.bundo/` (gitignore it — `bundo init` does). `--force` bypasses.

## Watch mode

`bundo --watch <task>` runs the plan, then watches each task's `watch` (or `inputs`) globs. On change: affected tasks + their dependents re-run in topo order; services whose globs match are restarted; changes arriving mid-run supersede it. `BUNDO_WATCH_POLL=1` forces the polling backend (Docker volumes, NFS).

## Workspaces

At a Bun workspace root, bundo merges the root `do.ts` with every member's `do.ts`. Member tasks are namespaced `pkg#task`:

```sh
bundo build                  # fans out: root build + api#build + web#build + ...
bundo api#build              # exactly one member
bundo -F api build           # filter: exact name
bundo -F '@acme/*' build     #         name glob
bundo -F ./packages/api build#         path
bundo -F ...api build        #         api + its workspace dependencies
bundo -F lib... build        #         lib + everything depending on it
```

Member deps stay file-local; each member task runs in its own directory. Inside a member directory, bundo stays member-local.

## CLI reference

```
bundo                        List tasks, grouped
bundo <task> [flags] [-- args]
bundo <t1> <t2>              Multiple tasks
bundo ls --json              Machine-readable task model
bundo graph [--dot] [--json] Dependency graph (mermaid / graphviz / JSON)
bundo --print-env <task>     Env provenance + schema validation (never runs)
bundo init                   Scaffold do.ts
bundo completion <shell>     bash | zsh | fish | powershell

-w, --watch                  -j, --concurrency <n>       --continue
    --dry[=json]             -f, --force                 -F, --filter <pat>
    --log-order <mode>       --output-logs <mode>        --json
    --color <mode> / --no-color                          -h, --help
```

Exit codes: `0` ok · `1` task failure · `2` usage · `3` config/env invalid · `130` interrupted. With `--json`, errors print `{"error":{"code","message","detail"}}` on stderr.

## For AI agents

bundo is deliberately agent-friendly: `bundo ls --json` exposes the full task model (flags, deps, env requirements), `--dry=json` previews any plan, `--print-env --json` explains configuration, errors are machine-parseable, and dep typos are compile errors an agent sees in the editor before ever running anything.

## Performance

Zero runtime dependencies; the CLI hot path statically imports three small modules and lazy-loads everything else. Measured on the reference machines: the bundled CLI adds ~25ms over a bare `bun` process spawn (which is ~5ms on Linux, ~40ms on Windows).

## License

MIT
