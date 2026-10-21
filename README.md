# outdo

**Docs:** [meslzy.github.io/outdo](https://meslzy.github.io/outdo/)

A TypeScript-native task runner for [Bun](https://bun.com). Tasks live in a typed `do.ts` at your repo root — no YAML, no Makefile, no DSL. A task can be one command string or a typed object; `package.json` scripts are tasks too. Full editor support, compile-time checking of deps and steps, schema-validated environments and flags, a parallel DAG scheduler with ordered steps, cleanup tasks and typed data flow, fingerprint caching that restores deleted outputs and can explain itself, services with readiness probes (in the foreground or in the background), modes with per-mode env files, confirmation for dangerous tasks, workspace `^deps` that replace turbo, a CI mode with GitHub annotations, git hooks, ssh deploys, an MCP server and an agent skill. Zero runtime dependencies.

```ts
// do.ts
import { defineTasks, ns } from "@meslzy/outdo";
import { z } from "zod";

export default defineTasks(
 {
  fix: "bunx biome check --write", // a task can be one command...
  tsc: "bunx tsc --noEmit",
  test: { deps: ["tsc"], run: "bun test" }, // typo in deps = compile error, with a "did you mean" fix

  gate: { steps: ["fix", "tsc", "test"] }, // ...steps run one after another (outdo gate --from tsc)

  build: {
   desc: "Build all packages",
   inputs: ["src/**/*.ts"], // fingerprint cache: skipped when unchanged
   outputs: ["dist/**"], // and restored from the cache when deleted
   run: "bun build src/index.ts --outdir dist",
  },

  dev: {
   desc: "Dev server",
   persistent: true, // service: stays alive
   ready: { url: "http://localhost:3000/health" }, // dependents wait until it's actually up
   run: "bun --watch src/server.ts",
  },

  db: ns({ // outdo db reset
   backup: "bun db/backup.ts",
   reset: { deps: ["backup"], protect: "prod", run: "bun db/reset.ts" }, // asks in prod
  }),

  deploy: {
   desc: "Deploy",
   env: z.object({ VPS_HOST: z.string() }), // validated BEFORE anything runs
   args: {
    target: z.enum(["web", "api", "all"]).default("all"), // a schema is a flag: validated + typed
    dry: { type: "boolean", short: "d", description: "Skip the actual push" },
   },
   positional: ["target"], // outdo deploy api -d
   protect: "prod",
   run: async ({ ssh, env, args, mode }) => {
    // env.VPS_HOST: string · args.target: "web" | "api" | "all" · mode: "dev" | "prod"
    if (!args.dry) {
     await ssh(`deploy@${env.VPS_HOST}`).cwd("~/app")`bunx outdo up ${args.target} --mode ${mode}`;
    }
   },
  },
 },
 {
  modes: ["dev", "prod"], // --mode prod picks .env.prod
  hooks: { "pre-commit": { steps: ["fix", "tsc"], restage: true } }, // outdo hooks install
 },
);
```

```txt
outdo                      # grouped task list (package.json scripts included)
outdo build                # run a task + its dependency DAG
outdo gate --from tsc      # part of a task's steps
outdo db reset --mode prod # namespaced task, in a mode (asks first; --yes answers)
outdo deploy api -d        # typed flags + positional values
outdo deploy --help        # auto-generated per-task help
outdo test -- --bail       # raw passthrough after --
outdo -i                   # pick a task interactively
outdo --watch build        # re-run the affected subgraph on file changes
outdo bg start dev         # run in the background; bg ps / logs / stop
outdo explain build        # why will each task run or skip? (never runs)
outdo --affected test      # only tasks touched by git changes vs the base branch
bunx outdo ci gate         # CI: changed tasks only, folded logs, annotations, summary
outdo --json build         # full run report: status, timing, cache, critical path
outdo --print-env deploy   # which .env file set what + schema verdict
outdo mcp                  # every task as an MCP tool
```

## Install

Requires **Bun >= 1.4**. outdo is Bun-only by design — it is built on Bun Shell, `Bun.spawn`, and `Bun.Glob`.

```sh
bun add -d @meslzy/outdo        # per-project (recommended)
bunx outdo init                 # scaffold a starter do.ts
# or globally — a global outdo runs the repo's installed copy when there is one:
bun add -g @meslzy/outdo
```

Inline typing of `env` / `args` (no `task()` wrapper) needs **TypeScript 6**.

## Why outdo

| | make / just / Taskfile | turbo / nx | **outdo** |
| --- | --- | --- | --- |
| Task definitions | DSL / YAML strings | JSON config | **typed TypeScript — or a plain command string** |
| Dep name typos | caught at invocation | silent no-op / runtime | **compile error in your editor + did-you-mean** |
| Env contracts | presence checks at best | filter/allowlist only | **Standard Schema validation before anything runs** |
| Per-task CLI flags | untyped params (just) / raw args | executor schemas (nx) | **zod schemas or specs, TypeScript-inferred, with `--help` + value completion** |
| Shell | your `/bin/sh` | your shell | **Bun Shell — cross-platform, injection-safe** |

The honest long-form version — including what outdo **can't** do (no remote cache, Bun-only) and when to pick Turborepo/Nx/just instead — lives in the docs: [Why outdo?](https://meslzy.github.io/outdo/guide/why-outdo)

## The authoring API

### `defineTasks({...}, options?)` — the single default export of `do.ts`

An entry is a command (`"bun test"`), a command list (run in order), a task object, a `task()` result, or an `ns({...})` namespace. Task objects support:

| field | meaning |
| --- | --- |
| `desc` / `group` | one-liner and heading in the task list |
| `run` | a command, a list of commands, or a function receiving the typed context; its return value is the task's **data output** |
| `deps` | tasks that must finish first (in parallel) — **typo-checked at compile time**; entries can be conditional (`{ task, if }`), `optional()`, typed `from()` references, `^name` (in each workspace dependency) or `pkg#name` |
| `steps` | tasks that run one after another; `--from` / `--until` pick a range |
| `finally` | tasks that run afterwards even when this one fails or is interrupted |
| `env` | a [Standard Schema](https://standardschema.dev) (zod v4, valibot, arktype…) validated against the resolved env **before any task runs**; `ctx.env` is the schema output |
| `args` | typed CLI flags: a schema (`z.enum([...]).default(...)`) or a spec (`{ type, short, default, required, choices, description }`) |
| `positional` | flags that may be given as bare words: `outdo logs api` |
| `envFiles` | extra env files for this task (`.env.platform` + `.env.platform.<mode>`) |
| `inputs` / `outputs` | fingerprint cache globs; deleted outputs are restored from the cache |
| `watch` | globs that trigger re-runs in `--watch` (defaults to `inputs`) |
| `persistent` / `ready` | long-running service; dependents wait for its probe (`{ log }`, `{ port }`, `{ url }`) |
| `retry` / `timeoutMs` | opt-in re-runs on failure; per-attempt time budget |
| `protect` / `confirm` | ask before running (in some modes / always); `--yes` answers, no terminal means refused |
| `requires` | pre-checks: tools on PATH, env vars, files, a URL or port — `outdo doctor` checks all |
| `readonly` / `destructive` | tags for agents; `OUTDO_READONLY=1` refuses everything not read-only |
| `cwd` | working directory, relative to `do.ts` |

Options: `modes` (`--mode`, first is the default), `members` (defaults for every workspace member's task of a name — e.g. `{ tsc: { deps: ["^tsc"] } }`), `hooks` (git hooks).

### `task({...})` — optional

Inline objects already type `ctx.env` / `ctx.args` from their `env` / `args`. `task()` builds the same thing ahead of time — handy for a producer passed to `from()`.

### Data flows between tasks

A task's `run()` return value is its **data output** — dependents read it from `ctx.deps`, fully typed via `from()`:

```ts
const version = task({
 inputs: ["package.json"],
 run: async () => ({ tag: `v${(await Bun.file("package.json").json()).version}` }),
});

export default defineTasks({
 version,
 release: {
  deps: [from("version", version)],
  run: async ({ deps, $ }) => {
   await $`git tag ${deps.version.tag}`; // typed: { tag: string }
  },
 },
});
```

Outputs are JSON, cross process boundaries transparently, and are **replayed from the cache manifest** when the producer is skipped — a cached producer still feeds its consumers. A changed output invalidates dependents' caches too.

### The task context

```ts
run: async ({ $, env, args, deps, rest, signal, log, cwd, root, name, mode, ssh }) => { ... }
```

- `$` — Bun Shell, pre-bound to the task's `cwd` and resolved env, `node_modules/.bin` on PATH. Interpolations are auto-escaped (injection-safe). The type is exported as `Shell`.
- `deps` — data outputs of this task's dependencies (typed via `from()`).
- `rest` — raw args after `--`, delivered **only** to tasks you named on the command line, never to deps.
- `mode` / `root` — the active `--mode`; the repo root.
- `ssh(target)` — a remote `$`: `` await ssh("me@vps").cwd("~/app")`git pull` `` (escaped values, prefixed streaming output).
- `signal` — `AbortSignal`; fires on Ctrl-C, fail-fast aborts, timeouts, and watch supersession. Respect it in loops.
- `log` — prefixed logger safe under concurrent output.

## Environment model

Cascade (lowest → highest), resolved from the repo root, matching Bun's own loader byte-for-byte:

```txt
.env → .env.{mode or NODE_ENV} → .env.local (skipped when NODE_ENV=test) → .env.{mode or NODE_ENV}.local → task envFiles → process env
```

Declare `modes: ["dev", "prod"]` and `--mode prod` picks `.env.prod`; `ctx.mode` and `OUTDO_MODE` carry the active mode. `$VAR` / `${VAR}` expand (verified against Bun 1.4: even inside single quotes; `\$` escapes). `outdo --print-env <task>` shows every key, **which file supplied it, and what it overrode**, plus the schema verdict — without running anything.

## Execution model

- Dependencies form a DAG; cycles are rejected at load with the exact path (even cycles hiding behind inactive conditional edges).
- `steps` order tasks within one run; a failed step skips the rest; `finally` tasks run afterwards regardless.
- Independent branches run **in parallel** (`-j/--concurrency` caps it), each task in its own process with output multiplexed as `name | line` prefixes (`--log-order=stream`) or buffered per task (`grouped`; the default in CI).
- Failures **fail fast**: running siblings get a cooperative abort (signal → 5s grace → tree kill), pending dependents are skipped. `--continue` runs everything independent instead. Opt-in `retry` re-runs flaky tasks; `timeoutMs` bounds each attempt.
- Pure dependency chains skip the child processes entirely and run in-process with fully inherited stdio — colors, progress bars, and interactive prompts just work.
- Services (`persistent: true`) don't hold a concurrency slot; with a `ready` probe, dependents wait for actual readiness. A requested service keeps the run alive (and fails it if it dies); a service pulled in only as a dependency is stopped once the requested tasks finish — server up, tests, server down in one command. `outdo bg start` runs it detached instead.
- Questions from `protect` / `confirm` are asked before anything starts; `requires` checks run right before each task.
- Every run ends with a timing summary including the **critical path**. `--profile` exports a Chrome trace; `--json` emits a full run report (per-task status, duration, cache result) on stdout.

## Caching

Declare `inputs` (and ideally `outputs`) and outdo skips tasks whose world hasn't changed. The fingerprint covers: input file **contents** (mtime+size fast path — `touch` won't bust it, edits will), the task definition including the `run` body text or command, the validated env output, CLI args and passthrough, dependency fingerprints (upstream changes cascade), and dependency **data outputs**. Deleted outputs are copied back from the local cache instead of re-running, and the last run's log is replayed. State lives in `.outdo/` (gitignore it — `outdo init` does). `--force` bypasses.

Each fingerprint component is hashed separately, so `outdo explain <task>` can tell you **exactly why** something will re-run — `inputs changed (modified: src/app.ts)`, `env changed`, `dependency outputs changed` — without running anything.

## Git-aware runs: `--affected`

`outdo test --affected` diffs against the merge-base with origin's default branch (in GitHub Actions: the PR base, or the previous push), or `--affected=<rev>`, and keeps only the requested tasks that could have changed: input-glob matches, package-level changes, workspace **dependents** of changed packages, and task-graph dependents. Committed, staged, unstaged, and untracked changes all count.

## CI, hooks and deploys

- `bunx outdo ci check` — changed tasks only, one folded `::group::` per task, failures printed again at the end, annotations from tsc / Biome / `bun test`, a summary table on the run page. `outdo ci init` writes the workflow.
- `outdo affected deploy --github-output` — `deploy=true|false` for an `if:`, from the task's own `inputs` (no paths-filter list).
- `hooks: { "pre-commit": { steps: [...], restage: true } }` + `outdo hooks install` — git hooks from `do.ts`; formatter changes to fully staged files are re-staged.
- `ctx.ssh` deploys, `outdo prune --docker` for the dependency layer of an image, and `@meslzy/outdo/compose` for the usual `up` / `down` / `logs <svc>` / `shell <svc>` tasks.

## Watch mode

`outdo --watch <task>` runs the plan, then watches each task's `watch` (or `inputs`) globs. On change: affected tasks + their dependents re-run in topo order; services whose globs match are restarted; changes arriving mid-run supersede it. `OUTDO_WATCH_POLL=1` forces the polling backend (Docker volumes, NFS).

## Workspaces

At a Bun workspace root, outdo merges the root `do.ts` with every member's `do.ts` and `package.json` scripts. Member tasks are namespaced `pkg#task`:

```sh
outdo test                   # fans out: every member's test
outdo tsc                    # root tsc with deps: ["^tsc"] — members first, in dependency order
outdo api#build              # exactly one member
outdo -F api build           # filter: exact name
outdo -F '@acme/*' build     #         name glob
outdo -F ./packages/api build#         path
outdo -F ...api build        #         api + its workspace dependencies
outdo -F lib... build        #         lib + everything depending on it
```

`^name` deps (in each workspace dependency) plus `members` defaults replace turbo pipelines. A root task keeps its name: a bare `build` doesn't also run members' `build` scripts unless the root task depends on `^build`. Inside a member with its own `do.ts`, outdo stays member-local.

## CLI reference

```txt
outdo                        List tasks, grouped
outdo <task> [flags] [-- args]
outdo <t1> <t2>              Multiple tasks
outdo <ns> <task>            Namespaced task (= <ns>:<task>)
outdo run <task>             A task named like a command
outdo -i                     Interactive picker
outdo ls --json              Machine-readable task model
outdo graph [--dot] [--json] Dependency graph (mermaid / graphviz / JSON)
outdo explain <task>         Why each planned task will run or skip (never runs)
outdo doctor                 Every task's "requires" checks
outdo --print-env <task>     Env provenance + schema validation (never runs)
outdo bg start|ps|logs|stop  Background runs
outdo ci <task> / ci init    CI run / write the workflow
outdo affected <task>        Did its inputs change? (--github-output)
outdo hooks install|list     Git hooks from do.ts
outdo prune --docker         package.jsons + lockfile for a Docker layer
outdo mcp                    Tasks as MCP tools
outdo skill install          The outdo agent skill
outdo init                   Scaffold do.ts
outdo completion <shell>     bash | zsh | fish | powershell (also completes bunx outdo)

-m, --mode <name>            -y, --yes                   --from / --until <step>
-w, --watch                  -j, --concurrency <n>       --continue
    --dry[=json]             -f, --force                 -F, --filter <pat>
    --affected[=<rev>]       --profile[=<file>]          --isolate
    --log-order <mode>       --output-logs <mode>        --json
    --color <mode> / --no-color                          -h, --help
```

Exit codes: `0` ok · `1` task failure · `2` usage (or refused) · `3` config/env invalid · `130` interrupted. With `--json`, errors print `{"error":{"code","message","detail"}}` on stderr.

## For AI agents

`outdo mcp` serves every task as an MCP tool with a typed input schema and read-only / destructive hints. `bunx skills add meslzy/outdo` (or `outdo skill install`) installs a skill that teaches agents outdo. `outdo ls --json` exposes the full task model (flags, deps, steps, tags), `--dry=json` previews any plan, `outdo --json explain <task>` diagnoses cache decisions down to the changed file, and `outdo --json <task>` ends with a complete run report. `OUTDO_READONLY=1` keeps an unattended agent to read-only tasks; tasks that ask for confirmation refuse without a terminal.

## Performance

Zero runtime dependencies; the CLI hot path statically imports a few small modules and lazy-loads everything else. Tab completion reads a cached task list instead of importing `do.ts`. Measured on the reference machines: the bundled CLI adds ~25ms over a bare `bun` process spawn (which is ~5ms on Linux, ~40ms on Windows).

## License

MIT
