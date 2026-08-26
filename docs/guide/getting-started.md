# Getting Started

outdo is a task runner where tasks live in a **typed TypeScript file** — `do.ts` — at your repo root. It requires [Bun](https://bun.com) <Badge type="warning" text="Bun >= 1.4" /> and nothing else: zero runtime dependencies.

## Install

::: code-group

```sh [project (recommended)]
bun add -d @meslzy/outdo
```

```sh [global]
bun add -g @meslzy/outdo
```

```sh [one-off]
bunx @meslzy/outdo <task>
```

:::

::: tip Why Bun-only?
outdo is built directly on Bun Shell (`$`), `Bun.spawn`, and `Bun.Glob` — the cross-platform, injection-safe primitives that make it fast and dependency-free. There is no Node fallback by design.
:::

## Scaffold

```sh
bunx outdo init
```

This creates a starter `do.ts` and adds `.outdo/` (the cache directory) to your `.gitignore`:

```ts
import { defineTasks, task } from "@meslzy/outdo";

export default defineTasks({
	dev: {
		desc: "Start the dev server",
		persistent: true,
		run: async ({ $ }) => {
			await $`bun --watch src/index.ts`;
		},
	},
	build: {
		desc: "Build the project",
		inputs: ["src/**/*.ts"],
		outputs: ["dist/**"],
		run: async ({ $ }) => {
			await $`bun build src/index.ts --outdir dist`;
		},
	},
	test: {
		desc: "Run tests",
		deps: ["build"],
		run: async ({ $ }) => {
			await $`bun test`;
		},
	},
});
```

## Run

```sh
outdo            # lists every task, grouped, with descriptions
outdo test       # runs build first (dependency), then test
outdo --dry test # shows the plan without running anything
```

Typo a task name and outdo suggests the fix:

```txt
$ outdo biuld
error Unknown task "biuld". Did you mean "build"? Run "outdo" to list tasks.
```

Typo a **dependency** name inside `do.ts` and it never even runs — TypeScript flags it in your editor with the same suggestion.

## Where outdo fits

outdo replaces `Makefile` / `justfile` / a pile of `package.json` scripts as your **task layer**. Keep raw one-line commands in `package.json` scripts if you like the convention — outdo tasks can call `bun run <script>` and add the DAG, parallelism, env contracts, and caching on top.

Next: [Why outdo?](/guide/why-outdo) for an honest comparison, or [Tasks & Dependencies](/guide/tasks-and-deps) to learn the API.
