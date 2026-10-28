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

A global `outdo` hands over to the repo's own installed copy when there is one (like turbo), so every repo runs the version in its lockfile and you can type `outdo` instead of `bunx outdo`. Set `OUTDO_NO_LOCAL=1` to turn that off.

::: tip Why Bun-only?
outdo is built directly on Bun Shell (`$`), `Bun.spawn`, and `Bun.Glob` — the cross-platform, injection-safe primitives that make it fast and dependency-free. There is no Node fallback by design.
:::

## No do.ts yet?

outdo already works: in a repo without a `do.ts`, your `package.json` scripts are the tasks.

```sh
outdo          # lists the scripts
outdo test     # runs `bun run test`
```

Add a `do.ts` when you want dependencies, typed flags, caching or descriptions. Scripts keep working next to it — a `do.ts` task with the same name wins.

## Scaffold

```sh
bunx outdo init
```

This creates a starter `do.ts` and adds `.outdo/` (the cache directory) to your `.gitignore`:

```ts
import { defineTasks } from "@meslzy/outdo";

export default defineTasks({
	// A task can be one command...
	fix: "bunx biome check --write",
	tsc: "bunx tsc --noEmit",
	test: { desc: "Run tests", run: "bun test" }, // outdo test -- --watch appends args

	// ...a service...
	dev: {
		desc: "Start the dev server",
		persistent: true,
		run: "bun --watch src/index.ts",
	},

	// ...a cached build (skipped when src/ is unchanged)...
	build: {
		desc: "Build the project",
		inputs: ["src/**/*.ts"],
		outputs: ["dist/**"],
		run: "bun build src/index.ts --outdir dist",
	},

	// ...steps that run in order (outdo check --from tsc)...
	check: { desc: "Everything that must pass before a commit", steps: ["fix", "tsc", "test"] },
});
```

When a command is not enough, `run` is a function with a typed context — and `env` / `args` on the same object type it:

```ts
import { defineTasks } from "@meslzy/outdo";
import { z } from "zod";

export default defineTasks({
	deploy: {
		desc: "Deploy",
		env: z.object({ DEPLOY_URL: z.url() }), // validated before anything runs
		args: { dry: { type: "boolean", short: "d" } }, // outdo deploy -d
		protect: true, // asks before running; --yes answers
		run: async ({ $, env, args }) => {
			env.DEPLOY_URL; // string
			args.dry; // boolean
			if (!args.dry) {
				await $`./push.sh ${env.DEPLOY_URL}`;
			}
		},
	},
});
```

::: tip TypeScript 6
Use TypeScript 6 for the inline typing of `env` and `args` (no `task()` wrapper). TypeScript 5.9 does not narrow `required` / `choices` flags there — they type as `string | undefined`.
:::

## Run

```sh
outdo            # lists every task, grouped, with descriptions
outdo test       # runs a task and its dependencies
outdo check      # fix, then tsc, then test
outdo --dry test # shows the plan without running anything
outdo -i         # pick a task interactively
```

Typo a task name and outdo suggests the fix:

```txt
$ outdo biuld
error Unknown task "biuld". Did you mean "build"? Run "outdo" to list tasks.
```

Typo a **dependency** or **step** name inside `do.ts` and it never even runs — TypeScript flags it in your editor.

## Shell completion

```sh
eval "$(outdo completion zsh)"   # or bash; fish/PowerShell: see the CLI reference
```

Tab completes task names, flags, flag values (choices), positional values, namespaces and modes — for `outdo ...` and `bunx outdo ...` alike.

## Where outdo fits

outdo replaces `Makefile` / `justfile` / turbo pipelines / a pile of `package.json` scripts as your **task layer**, plus the glue around it: git hooks, CI steps, deploy scripts. It does not replace your bundler, test runner or package manager — tasks call those.

Next: [Why outdo?](/guide/why-outdo) for an honest comparison, or [Tasks & Dependencies](/guide/tasks-and-deps) to learn the API.
