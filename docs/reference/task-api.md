# Task API

Everything `do.ts` can export, in one place.

## `defineTasks(map)`

The single default export. Keys are task names; values are plain task objects or `task()` results. Dep names are validated across entries **at compile time**.

## `task(def)`

The builder that unlocks typed `env` and `args` — the context type is inferred from what you declare. Plain objects and `task()` entries are otherwise identical.

## Task definition fields

| field | type | notes |
| --- | --- | --- |
| `desc` | `string` | task list one-liner |
| `group` | `string` | task list heading |
| `deps` | `readonly string[]` | compile-time checked against task names |
| `env` <Badge type="tip" text="task() only" /> | `StandardSchemaV1` | zod / valibot / arktype schema, validated pre-run |
| `args` <Badge type="tip" text="task() only" /> | `Record<string, ArgSpec>` | [typed CLI flags](/guide/args-and-flags) |
| `inputs` | `readonly string[]` | cache fingerprint globs (supports `!` negation) |
| `outputs` | `readonly string[]` | must exist for a cache hit |
| `watch` | `readonly string[]` | watch-mode triggers (defaults to `inputs`) |
| `persistent` | `boolean` | [service semantics](/guide/watch-and-services#services); incompatible with `outputs` |
| `cwd` | `string` | working dir, relative to `do.ts` |
| `run` | `(ctx) => unknown` | the body; omit for aggregation tasks |

## The context

Hover each field: <ContextCard name="$" type="Bun Shell ($)" info="Pre-bound to the task's cwd and resolved env. Interpolations are auto-escaped — injection-safe by default." /> · <ContextCard name="env" type="schema output | Record<string, string | undefined>" info="The validated output of your env schema (coercions applied), or the raw resolved env map when no schema is declared." /> · <ContextCard name="args" type="inferred from ArgSpec record" info="Parsed per-task CLI flags with defaults applied. required/default narrow away undefined." /> · <ContextCard name="rest" type="string[]" info="Raw arguments after --. Delivered only to tasks named on the command line, never to dependencies." /> · <ContextCard name="signal" type="AbortSignal" info="Fires on Ctrl-C, fail-fast aborts, and watch supersession. Respect it in long loops — ignoring it means a tree-kill after 5s." /> · <ContextCard name="log" type="TaskLogger" info="info/warn/error/debug — prefixed with the task name, safe under concurrent multiplexed output." /> · <ContextCard name="cwd" type="string" info="Absolute working directory of this task." /> · <ContextCard name="name" type="string" info="The task's name as defined in do.ts." />

```ts
run: async ({ $, env, args, rest, signal, log, cwd, name }) => {
	log.info("starting");
	const out = await $`git rev-parse --short HEAD`.text();
	if (signal.aborted) {
		return;
	}
	await $`echo building ${out.trim()}`;
},
```

## Type-level behavior worth knowing

```ts
import { defineTasks, task } from "bundo";
import { z } from "zod";

export default defineTasks({
	build: {},
	broken: {
		deps: ["biuld"], // [!code error] compile error: Did you mean "build"?
	},
	typed: task({
		env: z.object({ PORT: z.coerce.number() }),
		args: { fast: { type: "boolean" } },
		run: ({ env, args }) => {
			env.PORT;   // number  — schema output, not string
			args.fast;  // boolean — never undefined
			// @ts-expect-error unknown env keys are compile errors too
			env.MISSING;
		},
	}),
	// env/args on a PLAIN object is rejected — the builder powers the inference
	// invalid: { env: z.object({}) },  ← type error
});
```

- Everything in bundo's public surface is exported from `"bundo"`: `defineTasks`, `task`, and the types (`TaskCtx`, `ArgSpec`, `StandardSchemaV1`, …).
- Task names can be any string — `"db:reset"`, `"deploy"` — quotes required only when not a valid identifier.
