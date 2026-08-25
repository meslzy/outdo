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
| `deps` | tasks that must finish first — **typo-checked at compile time** |
| `inputs` | globs fingerprinted for [caching](/guide/caching) |
| `outputs` | globs that must exist for a cache hit |
| `watch` | globs that trigger [watch-mode](/guide/watch-and-services) re-runs (defaults to `inputs`) |
| `persistent` | long-running [service](/guide/watch-and-services#services); dependents unblock on spawn |
| `cwd` | working directory, relative to `do.ts` |
| `run` | the task body — omit it for pure aggregation tasks (`deps` only) |

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
