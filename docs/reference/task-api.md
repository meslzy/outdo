# Task API

Everything `do.ts` can export, in one place.

## `defineTasks(map)`

The single default export. Keys are task names; values are plain task objects or `task()` results. Dep names are validated across entries **at compile time**.

## `task(def)`

The builder that unlocks typed `env` and `args` — the context type is inferred from what you declare. Plain objects and `task()` entries are otherwise identical.

## `optional(name)`

A dep entry for a task that may not exist in this `do.ts` — silently dropped when absent, a normal hard edge when present. See [conditional and optional deps](/guide/tasks-and-deps#conditional-and-optional-dependencies).

## `from(name, taskValue)`

A typed dep entry: carries the producer's `run()` return type into the consumer's `ctx.deps[name]`. See [task outputs as data](/guide/tasks-and-deps#task-outputs-as-data).

## Task definition fields

| field | type | notes |
| --- | --- | --- |
| `desc` | `string` | task list one-liner |
| `group` | `string` | task list heading |
| `deps` | `readonly DepEntry[]` | names, `{ task, if?, optional? }` objects, `optional()`, `from()` — names compile-time checked |
| `env` <Badge type="tip" text="task() only" /> | `StandardSchemaV1` | zod / valibot / arktype schema, validated pre-run |
| `args` <Badge type="tip" text="task() only" /> | `Record<string, ArgSpec>` | [typed CLI flags](/guide/args-and-flags) |
| `inputs` | `readonly string[]` | cache fingerprint globs (supports `!` negation) |
| `outputs` | `readonly string[]` | must exist for a cache hit |
| `watch` | `readonly string[]` | watch-mode triggers (defaults to `inputs`) |
| `persistent` | `boolean` | [service semantics](/guide/watch-and-services#services); incompatible with `outputs`, `retry`, `timeoutMs` |
| `ready` | `{ log \| url \| port, host?, timeoutMs? }` | [readiness probe](/guide/watch-and-services#readiness-probes); persistent only, exactly one probe kind |
| `retry` | `number \| { attempts, delayMs?, backoff? }` | [opt-in retries](/guide/execution#retries); `number` = total attempts; `backoff: "fixed" \| "exponential"` |
| `timeoutMs` | `number` | [per-attempt budget](/guide/execution#timeouts); cooperative abort → grace → kill |
| `cwd` | `string` | working dir, relative to `do.ts` |
| `run` | `(ctx) => R` | the body; omit for aggregation tasks. The awaited return value is the task's JSON [data output](/guide/tasks-and-deps#task-outputs-as-data) |

Validation at load (exit `3`): `ready` requires `persistent`; exactly one of `log`/`url`/`port`; `host` only with `port`; `retry.attempts >= 1`; positive `timeoutMs`; persistent tasks reject `outputs`/`retry`/`timeoutMs`.

## The context

Hover each field: <ContextCard name="$" type="Bun Shell ($)" info="Pre-bound to the task's cwd and resolved env. Interpolations are auto-escaped — injection-safe by default." /> · <ContextCard name="env" type="schema output | Record<string, string | undefined>" info="The validated output of your env schema (coercions applied), or the raw resolved env map when no schema is declared." /> · <ContextCard name="args" type="inferred from ArgSpec record" info="Parsed per-task CLI flags with defaults applied. required/default narrow away undefined." /> · <ContextCard name="deps" type="inferred from dep entries" info="Data outputs of this task's dependencies — their run() return values. from() entries are fully typed; plain string entries are unknown. Replayed from the cache on hits." /> · <ContextCard name="rest" type="string[]" info="Raw arguments after --. Delivered only to tasks named on the command line, never to dependencies." /> · <ContextCard name="signal" type="AbortSignal" info="Fires on Ctrl-C, fail-fast aborts, timeouts, and watch supersession. Respect it in long loops — ignoring it means a tree-kill after 5s." /> · <ContextCard name="log" type="TaskLogger" info="info/warn/error/debug — prefixed with the task name, safe under concurrent multiplexed output." /> · <ContextCard name="cwd" type="string" info="Absolute working directory of this task." /> · <ContextCard name="name" type="string" info="The task's name as defined in do.ts." />

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

- Everything in bundo's public surface is exported from `"bundo"`: `defineTasks`, `task`, `optional`, `from`, and the types (`TaskCtx`, `ArgSpec`, `DepEntry`, `ReadyProbe`, `RetrySpec`, `StandardSchemaV1`, …).
- Task names can be any string — `"db:reset"`, `"deploy"` — quotes required only when not a valid identifier.
- `from()` producers propagate return-type changes to every consumer automatically; conditional/optional entries widen the consumer's view to `T | undefined`.
