# Tasks & Dependencies

Your entire task graph is one default export from `do.ts`:

```ts
import { defineTasks, task } from "bundo";

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
		deps: ["docker:up"], // [!code highlight]
		run: async ({ $ }) => {
			await $`bun prisma migrate reset --force`;
		},
	},
});
```

## Task fields

| field | meaning |
| --- | --- |
| `desc` | one-liner shown in the task list |
| `group` | heading in the task list (ungrouped tasks come last) |
| `deps` | tasks that must finish first — **typo-checked at compile time**; entries may be [conditional or optional](#conditional-and-optional-dependencies) |
| `inputs` | globs fingerprinted for [caching](/guide/caching) |
| `outputs` | globs that must exist for a cache hit |
| `watch` | globs that trigger [watch-mode](/guide/watch-and-services) re-runs (defaults to `inputs`) |
| `persistent` | long-running [service](/guide/watch-and-services#services); dependents unblock when it is [ready](/guide/watch-and-services#readiness-probes) |
| `ready` | readiness probe for a persistent task (`log` / `url` / `port`) |
| `retry` | [re-run on failure](/guide/execution#retries) — opt-in, non-persistent tasks only |
| `timeoutMs` | [per-attempt time budget](/guide/execution#timeouts) |
| `cwd` | working directory, relative to `do.ts` |
| `run` | the task body — omit it for pure aggregation tasks (`deps` only). Its return value becomes the task's [data output](#task-outputs-as-data) |

## Compile-time dependency checking

`deps` entries autocomplete against your task names, and a typo fails **in the editor**, before anything runs:

```ts
export default defineTasks({
	build: {},
	test: {
		deps: ["biuld"], // [!code error]
	},
});
```

```txt
Type '"biuld"' is not assignable to type '"build" | "test"'. Did you mean '"build"'?
```

The same check applies at runtime as a safety net (exit code 3, same suggestion), so plain-JS users get it too.

## Two ways to write a task

**Plain objects** cover most tasks — the context is fully typed with the default shape.

**The `task()` builder** unlocks two extra typed fields — [`env`](/guide/env) (a validation schema) and [`args`](/guide/args-and-flags) (CLI flags) — and types the context from them:

```ts
import { defineTasks, task } from "bundo";
import { z } from "zod";

export default defineTasks({
	simple: {
		run: async ({ $ }) => {
			await $`echo plain object`;
		},
	},
	fancy: task({
		env: z.object({ TOKEN: z.string() }),
		args: { dry: { type: "boolean", short: "d" } },
		run: ({ env, args }) => {
			env.TOKEN; // string
			args.dry; // boolean
		},
	}),
});
```

::: tip
Declaring `env` or `args` on a plain object is a type error — the builder is what makes the context inference work. Everything else is identical between the two forms.
:::

## Conditional and optional dependencies

A dep entry can be an object instead of a plain name:

```ts
import { defineTasks, optional } from "bundo";

export default defineTasks({
	build: { run: async ({ $ }) => $`bun run build` },
	test: { run: async ({ $ }) => $`bun test` },
	deploy: {
		deps: [
			"build",
			{ task: "test", if: "CI" }, // only when $CI is truthy
			optional("notify"), // fine if "notify" doesn't exist here
		],
		run: async ({ $ }) => $`bun run deploy`,
	},
});
```

- **`if: "NAME"`** — the edge is active iff the env var is set and not `""`, `"0"`, or `"false"` (case-insensitive). The value comes from the full [env cascade](/guide/env), not just `process.env`.
- **`if: (env) => boolean`** — a predicate over the resolved env, for anything beyond truthiness (`if: (env) => env.CI === undefined` inverts).
- **`optional(name)`** — soft dependency: silently dropped when the task doesn't exist in this `do.ts`. Useful for shared task presets across workspace members. When the task *does* exist, it's a normal hard edge.

Conditions are evaluated once per invocation, at plan time. An inactive dep is left out of the plan entirely (it won't run at all unless something else needs it), and `bundo --dry=json` lists it under `inactiveDeps`. Cycles are checked over the *declared* edges, so a cycle hidden behind an inactive condition is still a config error — deterministically, regardless of env.

## Task outputs as data

A task's `run()` return value is its **data output**. Dependents read it from `ctx.deps`:

```ts
import { defineTasks, from, task } from "bundo";

const version = task({
	inputs: ["package.json"],
	run: async () => {
		const pkg = await Bun.file("package.json").json();
		return { tag: `v${pkg.version}` };
	},
});

export default defineTasks({
	version,
	release: task({
		deps: [from("version", version)], // [!code highlight]
		run: async ({ deps, $ }) => {
			await $`git tag ${deps.version.tag}`; // typed: { tag: string } // [!code highlight]
		},
	}),
});
```

- `from(name, taskValue)` is a typed dependency reference — the producer's return type flows into `ctx.deps[name]`, and the name is still compile-time checked. Plain string deps work too; their value is just typed `unknown`.
- Outputs must be **JSON-serializable** (they cross process boundaries and live in the cache manifest). A circular or `BigInt` return fails the task with a clear error.
- Outputs survive caching: when a producer is skipped as a cache hit, its last output is **replayed** from the cache manifest, so consumers always see a value. A changed output also invalidates dependents' caches — even when the producer itself isn't cacheable.
- Conditional/optional deps type their value as `T | undefined`; absent deps read as `undefined`.

## Aggregation tasks

A task with `deps` and no `run` is a named group:

```ts
check: {
	desc: "Everything that must pass before a commit",
	deps: ["typecheck", "lint", "test"],
},
```

`bundo check` runs all three — [in parallel](/guide/execution), because they don't depend on each other.

## The Bun Shell

`ctx.$` is [Bun Shell](https://bun.com/docs/runtime/shell), pre-bound to the task's `cwd` and resolved environment:

- Cross-platform (works on Windows without WSL) with built-ins like `cd`, `rm`, `mkdir`, `cat`
- Interpolated values are **auto-escaped** — `await $`rm ${userInput}`` is injection-safe
- `await $`cmd`.text()` / `.json()` capture output; a non-zero exit throws with the code
