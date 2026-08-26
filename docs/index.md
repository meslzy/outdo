---
layout: home

hero:
  name: outdo
  text: The typed task runner for Bun
  tagline: Tasks live in a typed do.ts — no YAML, no Makefile, no DSL. Compile-time dependency checking, schema-validated env, parallel DAG scheduling, caching, and watch mode. Zero runtime dependencies.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Why outdo?
      link: /guide/why-outdo
    - theme: alt
      text: GitHub
      link: https://github.com/meslzy/outdo

features:
  - icon: 🧠
    title: Typed do.ts, not YAML
    details: Tasks are TypeScript. Autocomplete, go-to-definition, refactoring — and a dep typo is a compile error with a "did you mean" fix.
    link: /guide/tasks-and-deps
  - icon: 🔐
    title: Env contracts
    details: Declare a zod / valibot / arktype schema per task. Validated before anything runs; outdo --print-env shows which file set every variable.
    link: /guide/env
  - icon: 🎛️
    title: Typed CLI flags per task
    details: Declare flags once — get strict parsing, defaults, required checks, auto-generated --help, and shell completions.
    link: /guide/args-and-flags
  - icon: 🕸️
    title: Parallel DAG scheduler
    details: Independent branches run concurrently with prefixed, multiplexed output. Conditional deps, opt-in retries, timeouts, fail-fast with cooperative aborts.
    link: /guide/execution
  - icon: ⚡
    title: Fingerprint caching
    details: Declare inputs and outputs; unchanged tasks are skipped by content hash. outdo explain tells you exactly why anything re-runs.
    link: /guide/caching
  - icon: 🔌
    title: Services that are actually ready
    details: Readiness probes (log line, TCP port, HTTP health) gate dependents. outdo dev brings your stack up in order — db, api, web.
    link: /guide/watch-and-services
  - icon: 🌿
    title: Git-aware monorepo runs
    details: outdo test --affected runs only what changed vs your base branch — through both the package graph and the task graph.
    link: /guide/workspaces
  - icon: 📊
    title: Run reports & traces
    details: outdo build --json emits a full execution report — per-task timing, cache result, critical path. --profile writes a Chrome trace.
    link: /guide/execution
  - icon: 🤖
    title: Built for AI agents too
    details: ls --json, --dry=json, explain --json, run reports, machine-parseable errors, stable exit codes. Your agent reads the plan before running it.
    link: /reference/ai-agents
---

## Sixty seconds of outdo

::: code-group

```sh [install]
bun add -d @meslzy/outdo
bunx outdo init      # scaffolds a starter do.ts
```

```ts [do.ts]
import { defineTasks, task } from "@meslzy/outdo";
import { z } from "zod";

export default defineTasks({
	build: {
		desc: "Build the project",
		inputs: ["src/**/*.ts"], // fingerprint cache
		outputs: ["dist/**"],
		run: async ({ $ }) => {
			await $`bun build src/index.ts --outdir dist`;
		},
	},
	test: {
		deps: ["biuld"], // [!code error] ← compile error: Did you mean "build"?
		run: async ({ $ }) => {
			await $`bun test`;
		},
	},
	deploy: task({
		env: z.object({ DEPLOY_URL: z.url() }), // validated before anything runs
		args: { dry: { type: "boolean", short: "d" } },
		run: async ({ $, env, args }) => {
			if (!args.dry) {
				await $`./push.sh ${env.DEPLOY_URL}`;
			}
		},
	}),
});
```

```sh [run]
outdo                     # grouped task list
outdo build               # run a task + its deps
outdo deploy -d           # typed flags
outdo --watch build       # re-run on change
outdo explain build       # why will it run? what's cached?
outdo --affected test     # only what changed vs the base branch
outdo --json build        # full run report for CI / agents
```

:::
