---
layout: home

hero:
  name: outdo
  text: The typed task runner for Bun
  tagline: Tasks live in a typed do.ts — no YAML, no Makefile, no DSL. One-line tasks, compile-time checked deps and steps, schema-validated env and flags, parallel DAG scheduling, caching, CI and git hooks. Zero runtime dependencies.
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
    details: A task can be one command string — or a typed object. Autocomplete everywhere, and a dep or step typo is a compile error with a "did you mean" fix. Your package.json scripts are tasks too.
    link: /guide/tasks-and-deps
  - icon: 🔐
    title: Env contracts
    details: Declare a zod / valibot / arktype schema per task. Validated before anything runs; outdo --print-env shows which file set every variable.
    link: /guide/env
  - icon: 🎛️
    title: Typed CLI flags per task
    details: Declare flags once — as zod schemas or plain specs, with choices and positional values — and get strict parsing, auto-generated --help, and Tab completion of the values.
    link: /guide/args-and-flags
  - icon: 🕸️
    title: Parallel DAG scheduler
    details: Independent branches run concurrently with prefixed, multiplexed output. Conditional deps, opt-in retries, timeouts, fail-fast with cooperative aborts.
    link: /guide/execution
  - icon: ⚡
    title: Fingerprint caching
    details: Declare inputs and outputs; unchanged tasks are skipped by content hash, deleted outputs come back from the cache, and outdo explain tells you exactly why anything re-runs.
    link: /guide/caching
  - icon: 🔌
    title: Services that are actually ready
    details: Readiness probes (log line, TCP port, HTTP health) gate dependents. outdo dev brings your stack up in order — db, api, web.
    link: /guide/watch-and-services
  - icon: 🌿
    title: Monorepos without turbo
    details: Member package.json scripts become pkg#task, ^build orders packages by their dependencies, and --affected runs only what changed — through both the package graph and the task graph.
    link: /guide/workspaces
  - icon: 🚦
    title: CI, hooks and deploys
    details: outdo ci folds logs, annotates failures and runs only what changed. Git hooks, ssh deploys, Docker layers and a compose preset live in do.ts too.
    link: /guide/ci-cd
  - icon: 🛡️
    title: Safe by default
    details: protect and confirm ask before dangerous tasks (and refuse without a terminal), requires checks the stack is up, OUTDO_READONLY keeps unattended runs read-only.
    link: /guide/safety
  - icon: 📊
    title: Run reports & traces
    details: outdo build --json emits a full execution report — per-task timing, cache result, critical path. --profile writes a Chrome trace.
    link: /guide/execution
  - icon: 🤖
    title: Built for AI agents too
    details: outdo mcp turns every task into a typed tool, an installable skill teaches the agent outdo, and ls --json, --dry=json, explain --json and run reports answer everything else.
    link: /reference/ai-agents
---

## Sixty seconds of outdo

::: code-group

```sh [install]
bun add -d @meslzy/outdo
bunx outdo init      # scaffolds a starter do.ts
```

```ts [do.ts]
import { defineTasks } from "@meslzy/outdo";
import { z } from "zod";

export default defineTasks({
	fix: "bunx biome check --write", // a task can be one command
	build: {
		desc: "Build the project",
		inputs: ["src/**/*.ts"], // fingerprint cache
		outputs: ["dist/**"],
		run: "bun build src/index.ts --outdir dist",
	},
	test: {
		deps: ["biuld"], // [!code error] ← compile error: Did you mean "build"?
		run: "bun test",
	},
	gate: { steps: ["fix", "build", "test"] }, // one after another
	deploy: {
		env: z.object({ DEPLOY_URL: z.url() }), // validated before anything runs
		args: { dry: { type: "boolean", short: "d" } },
		protect: true, // asks first; --yes answers
		run: async ({ $, env, args }) => {
			if (!args.dry) {
				await $`./push.sh ${env.DEPLOY_URL}`;
			}
		},
	},
});
```

```sh [run]
outdo                     # grouped task list (package.json scripts included)
outdo build               # run a task + its deps
outdo gate --from build   # part of a task's steps
outdo deploy -d           # typed flags
outdo --watch build       # re-run on change
outdo explain build       # why will it run? what's cached?
outdo --affected test     # only what changed vs the base branch
outdo --json build        # full run report for CI / agents
bunx outdo ci gate        # in GitHub Actions: changed tasks, folded logs, annotations
```

:::
