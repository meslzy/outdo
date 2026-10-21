# Tasks & Dependencies

Your entire task graph is one default export from `do.ts`:

```ts
import { defineTasks } from "@meslzy/outdo";

export default defineTasks({
	"docker:up": {
		group: "Infra",
		desc: "Start Postgres + Redis",
		run: "docker compose up -d postgres redis",
	},
	"db:reset": {
		group: "Infra",
		desc: "Reset the local database",
		deps: ["docker:up"], // [!code highlight]
		run: "bun prisma migrate reset --force",
	},
});
```

## Entry forms

Each entry in `defineTasks` is one of:

| form | example | runs |
| --- | --- | --- |
| a command | `fix: "bunx biome check --write"` | one [Bun Shell](#the-bun-shell) command |
| a command list | `sync: ["bun run syncpack:fix", "bun install"]` | the commands in order; the first failure stops it |
| a task object | `test: { deps: ["build"], run: "bun test" }` | `run`: a command, a command list, or a function |
| a `task()` result | `version: task({ run: () => ({ tag: "1.2.3" }) })` | same as an object, built ahead of time |
| a namespace | `db: ns({ reset, backup })` | tasks named `db:reset`, `db:backup` — see [Namespaces](#namespaces) |

Arguments after `--` are appended to the (last) command: `outdo test -- --bail` runs `bun test --bail`.

## Task fields

| field | meaning |
| --- | --- |
| `desc` | one-liner shown in the task list (command entries default to the command) |
| `group` | heading in the task list (ungrouped tasks come last) |
| `run` | the task body: a command, a list of commands, or a function receiving the [typed context](/reference/task-api#the-context). Omit it for pure aggregation. A function's return value becomes the task's [data output](#task-outputs-as-data) |
| `deps` | tasks that must finish first, in parallel, once each — **typo-checked at compile time**; entries may be [conditional or optional](#conditional-and-optional-dependencies), or [cross-package](/guide/workspaces#dependencies-across-packages) (`^build`, `pkg#build`) |
| `steps` | tasks that run [one after another](#steps), after `deps` |
| `finally` | tasks that run [after this one, even when it fails](#finally) |
| `env` | a [schema](/guide/env#schemas-fail-before-anything-runs) for required env vars — types `ctx.env` |
| `args` | [typed CLI flags](/guide/args-and-flags) — types `ctx.args` |
| `positional` | flags that may be given as [bare words](/guide/args-and-flags#positional-values) (`outdo logs api`) |
| `envFiles` | extra [env files](/guide/env#per-task-env-files) for this task |
| `inputs` | globs fingerprinted for [caching](/guide/caching) |
| `outputs` | globs that must exist for a cache hit (restored from the cache when deleted) |
| `watch` | globs that trigger [watch-mode](/guide/watch-and-services) re-runs (defaults to `inputs`) |
| `persistent` | long-running [service](/guide/watch-and-services#services); dependents unblock when it is [ready](/guide/watch-and-services#readiness-probes) |
| `ready` | readiness probe for a persistent task (`log` / `url` / `port`) |
| `retry` | [re-run on failure](/guide/execution#retries) — opt-in, non-persistent tasks only |
| `timeoutMs` | [per-attempt time budget](/guide/execution#timeouts) |
| `cwd` | working directory, relative to `do.ts` |
| `protect` | [ask before running](/guide/safety#protect-and-confirm) — `true`, a mode, or a list of modes |
| `confirm` | a question to [always ask](/guide/safety#protect-and-confirm) first |
| `requires` | [pre-checks](/guide/safety#requires-and-doctor): tools, env vars, files, a URL or port |
| `readonly` | safe to run unattended; the only tasks allowed under [`OUTDO_READONLY=1`](/guide/safety#readonly-and-destructive) |
| `destructive` | changes things that are hard to get back (shown in `ls --json`, MCP `destructiveHint`) |

Unknown fields are rejected — at compile time, and at load (exit `3`) for plain JS.

## Compile-time dependency checking

`deps`, `steps`, `finally` and hook steps autocomplete against your task names, and a typo fails **in the editor**, before anything runs:

```ts
export default defineTasks({
	build: {},
	test: {
		deps: ["biuld"], // [!code error]
	},
});
```

```txt
error TS2322: Type '["biuld"]' is not assignable to type ...
  ...
  Type '"biuld"' is not assignable to type 'OptionalDep | DepEntry<...>'. Did you mean '"build"'?
```

The same check applies at runtime as a safety net (exit code 3, with a did-you-mean suggestion), so plain-JS users get it too.

## Typed context without a wrapper

`env` and `args` declared on a task object type its `run` context directly — no builder needed:

```ts
import { defineTasks } from "@meslzy/outdo";
import { z } from "zod";

export default defineTasks({
	deploy: {
		env: z.object({ TOKEN: z.string() }),
		args: { dry: { type: "boolean", short: "d" } },
		run: ({ env, args }) => {
			env.TOKEN; // string
			args.dry; // boolean
		},
	},
});
```

`task()` still exists and is equivalent. It is handy for a task you define outside the map — for example a producer passed to [`from()`](#task-outputs-as-data). (Inline typing needs TypeScript 6; see [Getting Started](/guide/getting-started#scaffold).)

## Steps

`deps` run in parallel and only promise "before me". `steps` run **one after another**, in the order you write them:

```ts
export default defineTasks({
	fix: "bunx biome check --write",
	typegen: "bun scripts/typegen.ts",
	tsc: { deps: ["typegen"], run: "bunx tsc --noEmit" },
	test: "bun test",
	gate: { desc: "All checks in order", steps: ["fix", "tsc", "test"] }, // [!code highlight]
});
```

```txt
$ outdo --dry gate
plan (dependencies first):
    fix
    typegen (after fix)
    tsc
    test (after tsc)
  * gate
```

Each step runs with its own deps, and every task a step brings into the plan waits for the step before it — `typegen` (a dep of `tsc`) waits for `fix`. A task shared by two steps still runs once, as early as it is needed. The first step waits for the task's own `deps`. If a step fails, the later steps are skipped.

The ordering only exists for that run: `outdo tsc` on its own does not run `fix` first.

Run part of the sequence with `--from` / `--until` (by step name; both inclusive, before or after the task name):

```sh
outdo gate --from tsc     # tsc, test
outdo gate --until fix    # fix only
outdo gate --from tsc --until tsc
```

`outdo gate --help` lists the steps. A persistent task can't declare `steps`.

## Finally

`finally` tasks run after the task — **even when it failed or you pressed Ctrl-C** — as long as anything in its plan started:

```ts
"look-check": {
	steps: ["look-serve", "look-shoot"],
	finally: ["look-stop"], // [!code highlight]
},
```

```txt
$ outdo look-check
✗ look-shoot (2.1s) Task "look-shoot" failed: ...
— 1 ok, 1 failed, 1 skipped · 2.4s total
finally: look-stop
✓ look-stop (30ms)
— 1 ok · 30ms total
error Task "look-shoot" failed: ...
```

The run still fails with the original error. Tasks that already succeeded earlier in the run are not repeated.

## Namespaces

Group related tasks with `ns()` instead of `db-` prefixes and a matching `group`:

```ts
import { defineTasks, ns } from "@meslzy/outdo";

export default defineTasks({
	stop: "docker compose stop",
	db: ns({
		backup: "bun db/backup.ts",
		reset: {
			desc: "Wipe the schema and re-run every migration",
			deps: ["backup", "stop"], // a sibling first, then top-level names
			run: "bun db/reset.ts",
		},
	}),
});
```

```sh
outdo db reset   # same as outdo db:reset
outdo db         # lists only the db tasks
outdo db rest    # error Unknown task "db:rest". Did you mean "db:reset"?
```

- Namespaced tasks are named `ns:task`; elsewhere you reference them by that name (`deps: ["db:reset"]`).
- Inside a namespace, a dep/step name means the sibling when one exists, else the top-level task.
- The namespace becomes the task list heading unless a task sets its own `group`.
- Namespaces don't nest.

## package.json scripts are tasks

Every script in your `package.json` is a task — no `do.ts` entry needed:

```sh
outdo lint            # runs `bun run lint` (pre/post scripts included)
outdo lint -- --fix   # args are appended
```

They are listed under a **package.json** heading. Left out: npm lifecycle scripts (`prepare`, `postinstall`, …), `pre`/`post` hooks of another script, and scripts that just call outdo (`"gate": "outdo gate"`).

A `do.ts` task with the same name wins. A `do.ts` entry with **no** `run` and no `steps` runs the same-named script — so do.ts can add metadata to a script without repeating it:

```ts
export default defineTasks({
	test: { deps: ["build"], readonly: true, inputs: ["src/**", "test/**"] }, // runs `bun run test`
});
```

## Conditional and optional dependencies

A dep entry can be an object instead of a plain name:

```ts
import { defineTasks, optional } from "@meslzy/outdo";

export default defineTasks({
	build: "bun run build",
	test: "bun test",
	deploy: {
		deps: [
			"build",
			{ task: "test", if: "CI" }, // only when $CI is truthy
			optional("notify"), // fine if "notify" doesn't exist here
		],
		run: "bun run deploy",
	},
});
```

- **`if: "NAME"`** — the edge is active iff the env var is set and not `""`, `"0"`, or `"false"` (case-insensitive). The value comes from the full [env cascade](/guide/env), not just `process.env`.
- **`if: (env) => boolean`** — a predicate over the resolved env, for anything beyond truthiness (`if: (env) => env.OUTDO_MODE === "prod"`).
- **`optional(name)`** — soft dependency: silently dropped when the task doesn't exist. Useful for shared task presets across workspace members. When the task *does* exist, it's a normal hard edge.

Conditions are evaluated once per invocation, at plan time. An inactive dep is left out of the plan entirely (it won't run at all unless something else needs it), and `outdo --dry=json` lists it under `inactiveDeps`. Cycles are checked over the *declared* edges, so a cycle hidden behind an inactive condition is still a config error — deterministically, regardless of env.

## Task outputs as data

A task's `run()` return value is its **data output**. Dependents read it from `ctx.deps`:

```ts
import { defineTasks, from, task } from "@meslzy/outdo";

const version = task({
	inputs: ["package.json"],
	run: async () => {
		const pkg = await Bun.file("package.json").json();
		return { tag: `v${pkg.version}` };
	},
});

export default defineTasks({
	version,
	release: {
		deps: [from("version", version)], // [!code highlight]
		run: async ({ deps, $ }) => {
			await $`git tag ${deps.version.tag}`; // typed: { tag: string } // [!code highlight]
		},
	},
});
```

- `from(name, taskValue)` is a typed dependency reference — the producer's return type flows into `ctx.deps[name]`, and the name is still compile-time checked. Plain string deps work too; their value is just typed `unknown`.
- Outputs must be **JSON-serializable** (they cross process boundaries and live in the cache manifest). A circular or `BigInt` return fails the task with a clear error.
- Outputs survive caching: when a producer is skipped as a cache hit, its last output is **replayed** from the cache manifest, so consumers always see a value. A changed output also invalidates dependents' caches — even when the producer itself isn't cacheable.
- Conditional/optional deps type their value as `T | undefined`; absent deps read as `undefined`.
- Command tasks (`run: "..."`) have no data output.

## Aggregation tasks

A task with `deps` and no `run` is a named group:

```ts
check: {
	desc: "Everything that must pass before a commit",
	deps: ["typecheck", "lint", "test"],
},
```

`outdo check` runs all three — [in parallel](/guide/execution), because they don't depend on each other. Use `steps` instead when the order matters.

## Names that collide with commands

A task named like an outdo command (`ci`, `run`, `doctor`, `bg`, …) is still a task — run it with `outdo run <name>`. The task list says so next to it.

## The Bun Shell

Command tasks and `ctx.$` both use [Bun Shell](https://bun.com/docs/runtime/shell), bound to the task's `cwd` and resolved environment, with `node_modules/.bin` on `PATH` (so `tsc` works without `bunx`):

- Cross-platform (works on Windows without WSL) with built-ins like `cd`, `rm`, `mkdir`, `cat`; `&&`, `||`, pipes and redirects work in command strings
- Interpolated values are **auto-escaped** — `` await $`rm ${userInput}` `` is injection-safe
- `` await $`cmd`.text() `` / `.json()` capture output; a non-zero exit throws with the code
