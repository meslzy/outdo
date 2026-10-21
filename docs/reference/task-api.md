# Task API

Everything `do.ts` can export, in one place. All of it comes from `"@meslzy/outdo"` (and the compose preset from `"@meslzy/outdo/compose"`).

## `defineTasks(tasks, options?)`

The single default export. Keys are task names; values are entries (below). Dep, step, finally and hook names are validated across entries **at compile time**, and `env` / `args` on an entry type its `run` context.

### Entries

| entry | meaning |
| --- | --- |
| `"cmd args"` | one Bun Shell command; args after `--` are appended |
| `["cmd1", "cmd2"]` | commands in order; passthrough args go on the last |
| `{ ...fields }` | a [task object](#task-definition-fields) |
| `task({ ... })` | a task object built ahead of time |
| `ns({ a, b })` | a [namespace](/guide/tasks-and-deps#namespaces): tasks `ns:a`, `ns:b` |

### Options

| option | type | meaning |
| --- | --- | --- |
| `modes` | `readonly string[]` | allowed [`--mode`](/guide/env#modes) values; the first is the default. Types `ctx.mode` and `protect` |
| `members` | `Record<string, MemberDefaults>` | [defaults](/guide/workspaces#member-defaults-replacing-turbo) merged into every workspace member's task of that name — `deps`, `inputs`, `outputs`, `watch`, `desc`, `group`, `requires`, `protect`, `confirm`, `readonly`, `destructive`, … |
| `hooks` | `{ [hook]: Command \| HookDef }` | [git hooks](/guide/ci-cd#git-hooks). `HookDef`: `{ desc?, deps?, steps?, run?, restage? }` |

```ts
export default defineTasks(
	{ fix: "bunx biome check --write", tsc: "bunx tsc --noEmit" },
	{
		modes: ["dev", "prod"],
		members: { tsc: { deps: ["^tsc"] } },
		hooks: { "pre-commit": { steps: ["fix", "tsc"], restage: true } },
	},
);
```

## `ns(tasks)`

Groups entries under a namespace: `db: ns({ reset, backup })` defines `db:reset` and `db:backup`. Inside, deps/steps name siblings first, then top-level tasks. Typed like `defineTasks` (except `ctx.mode`, which is `string` there). Namespaces don't nest.

## `task(def)`

Optional since `defineTasks` types `env` / `args` itself. Use it for a task defined outside the map — typically a producer for `from()`. Its `run` must be a function; use a plain entry for commands.

## `optional(name)`

A dep entry for a task that may not exist — silently dropped when absent, a normal hard edge when present. See [conditional and optional deps](/guide/tasks-and-deps#conditional-and-optional-dependencies).

## `from(name, taskValue)`

A typed dep entry: carries the producer's `run()` return type into the consumer's `ctx.deps[name]`. See [task outputs as data](/guide/tasks-and-deps#task-outputs-as-data).

## Task definition fields

| field | type | notes |
| --- | --- | --- |
| `desc` | `string` | task list one-liner |
| `group` | `string` | task list heading |
| `run` | `(ctx) => R` \| `string` \| `string[]` | the body; omit for aggregation tasks. A function's awaited return value is the task's JSON [data output](/guide/tasks-and-deps#task-outputs-as-data). With no `run`/`steps`, a same-named `package.json` script runs |
| `deps` | `readonly DepEntry[]` | names, `^name`, `pkg#name`, `{ task, if?, optional? }` objects, `optional()`, `from()` — names compile-time checked |
| `steps` | `readonly string[]` | [run one after another](/guide/tasks-and-deps#steps) after `deps`; `--from` / `--until` |
| `finally` | `readonly string[]` | [always run afterwards](/guide/tasks-and-deps#finally), even on failure / Ctrl-C |
| `env` | `StandardSchemaV1` | zod / valibot / arktype schema, validated pre-run; types `ctx.env` |
| `args` | `Record<string, ArgSpec \| StandardSchemaV1>` | [typed CLI flags](/guide/args-and-flags); types `ctx.args` |
| `positional` | `readonly string[]` | flag names fillable by bare words, in order |
| `envFiles` | `readonly string[]` | [extra env files](/guide/env#per-task-env-files) (+ their `.<mode>` variants), relative to `do.ts` |
| `inputs` | `readonly string[]` | cache fingerprint globs (supports `!` negation) |
| `outputs` | `readonly string[]` | must exist for a cache hit; [restored](/guide/caching#deleted-outputs-come-back) from the cache when deleted |
| `watch` | `readonly string[]` | watch-mode triggers (defaults to `inputs`) |
| `persistent` | `boolean` | [service semantics](/guide/watch-and-services#services); incompatible with `outputs`, `retry`, `timeoutMs`, `steps` |
| `ready` | `{ log \| url \| port, host?, timeoutMs? }` | [readiness probe](/guide/watch-and-services#readiness-probes); persistent only, exactly one probe kind |
| `retry` | `number \| { attempts, delayMs?, backoff? }` | [opt-in retries](/guide/execution#retries); `number` = total attempts; `backoff: "fixed" \| "exponential"` |
| `timeoutMs` | `number` | [per-attempt budget](/guide/execution#timeouts); cooperative abort → grace → kill |
| `cwd` | `string` | working dir, relative to `do.ts` |
| `protect` | `true \| Mode \| readonly Mode[]` | [ask before running](/guide/safety#protect-and-confirm) (in those modes) |
| `confirm` | `string` | always ask this question first |
| `requires` | `{ bin?, env?, file?, url?, port?, host?, hint? }` | [pre-checks](/guide/safety#requires-and-doctor) right before the task starts |
| `readonly` | `boolean` | safe unattended; allowed under `OUTDO_READONLY=1` |
| `destructive` | `boolean` | hard to undo; MCP `destructiveHint` |

`ArgSpec`: `{ type: "string" | "boolean", short?, default?, required?, choices?, suggest?, description? }`.

Validation at load (exit `3`): unknown fields; `ready` requires `persistent`; exactly one of `log`/`url`/`port`; `host` only with `port`; `retry.attempts >= 1`; positive `timeoutMs`; persistent tasks reject `outputs`/`retry`/`timeoutMs`/`steps`; `positional` names must be declared, non-boolean flags, and only the last may be an array; unknown dep/step/finally names (with a did-you-mean).

## The context

Hover each field: <ContextCard name="$" type="Bun Shell ($)" info="Pre-bound to the task's cwd and resolved env, with node_modules/.bin on PATH. Interpolations are auto-escaped — injection-safe by default." /> · <ContextCard name="env" type="schema output | Record<string, string | undefined>" info="The validated output of your env schema (coercions applied), or the raw resolved env map when no schema is declared. Includes the task's envFiles for the active mode." /> · <ContextCard name="args" type="inferred from args" info="Parsed per-task CLI flags with defaults applied. Schema flags give the schema output; choices narrow to a union; required/default narrow away undefined." /> · <ContextCard name="deps" type="inferred from dep entries" info="Data outputs of this task's dependencies — their run() return values. from() entries are fully typed; plain string entries are unknown. Replayed from the cache on hits." /> · <ContextCard name="rest" type="string[]" info="Raw arguments after --. Delivered only to tasks named on the command line, never to dependencies." /> · <ContextCard name="signal" type="AbortSignal" info="Fires on Ctrl-C, fail-fast aborts, timeouts, and watch supersession. Respect it in long loops — ignoring it means a tree-kill after 5s." /> · <ContextCard name="log" type="TaskLogger" info="info/warn/error/debug — prefixed with the task name, safe under concurrent multiplexed output." /> · <ContextCard name="cwd" type="string" info="Absolute working directory of this task." /> · <ContextCard name="root" type="string" info="Absolute repo root: the workspace root, or the directory of the root do.ts." /> · <ContextCard name="name" type="string" info="The task's name (pkg#task for workspace members)." /> · <ContextCard name="mode" type="union of your modes" info="The active --mode; the first declared mode by default, empty string when the project declares none." /> · <ContextCard name="ssh" type="(target, options?) => RemoteShell" info="A $-like tagged template that runs on a remote host over ssh: escaped values, label-prefixed streaming output, .cwd(), .nothrow(), .quiet()." />

```ts
run: async ({ $, env, args, deps, rest, signal, log, cwd, root, name, mode, ssh }) => {
	log.info(`starting in ${mode}`);
	const out = await $`git rev-parse --short HEAD`.text();
	if (signal.aborted) {
		return;
	}
	await $`echo building ${out.trim()}`.cwd(`${root}/apps/web`);
},
```

`ssh(target, { label?, args? })` returns a `RemoteShell`: `` await vps`cmd ${value}` `` resolves to `{ exitCode, stdout, stderr }` and throws on a non-zero exit; `.cwd(dir)`, `.nothrow()` and `.quiet()` return a configured copy. See [Deploys over ssh](/guide/ci-cd#deploys-over-ssh-ctx-ssh).

## Type-level behavior worth knowing

```ts
import { defineTasks } from "@meslzy/outdo";
import { z } from "zod";

export default defineTasks(
	{
		build: "bun run build",
		broken: {
			deps: ["biuld"], // [!code error] compile error: Did you mean "build"?
		},
		typed: {
			env: z.object({ PORT: z.coerce.number() }),
			args: { fast: { type: "boolean" }, svc: { type: "string", choices: ["api", "web"], required: true } },
			protect: "prod",
			run: ({ env, args, mode }) => {
				env.PORT; // number  — schema output, not string
				args.fast; // boolean — never undefined
				args.svc; // "api" | "web"
				mode; // "dev" | "prod"
				// @ts-expect-error unknown env keys are compile errors too
				env.MISSING;
			},
		},
		// @ts-expect-error "staging" is not a declared mode
		nope: { protect: "staging" },
	},
	{ modes: ["dev", "prod"] },
);
```

- Exported functions: `defineTasks`, `ns`, `task`, `optional`, `from`. Exported types include `TaskCtx`, `TaskDef`, `TaskEntry`, `Command`, `Shell` (the type of `ctx.$` — no more `Parameters<…>` gymnastics), `ArgSpec`, `ArgDecl`, `DepEntry`, `DepRef`, `QualifiedDep`, `ReadyProbe`, `RetrySpec`, `Requires`, `HookDef`, `GitHook`, `MemberDefaults`, `DefineOptions`, `Namespace`, `Ssh`, `SshOptions`, `RemoteShell`, `RemoteResult`, `RawEnv`, `StandardSchemaV1`.
- Inline typing of `env` / `args` needs **TypeScript 6** (5.9 leaves `required` / `choices` flags as `string | undefined`).
- Task names can be any string — `"db:reset"`, `"deploy"` — quotes required only when not a valid identifier.
- `from()` producers propagate return-type changes to every consumer automatically; conditional/optional entries widen the consumer's view to `T | undefined`.

## `@meslzy/outdo/compose`

`compose(options?, baseDir?)` returns the [Docker Compose task set](/guide/ci-cd#docker-compose-meslzy-outdo-compose) — `up`, `down`, `restart`, `rebuild`, `fresh`, `logs`, `ps`, `shell`, `exec` — to spread into `defineTasks`. Also exported: `runCompose(options, ctx, args)` (run one `docker compose` command from your own task), `servicesInFile(text)`, and the `ComposeOptions` / `ComposeTasks` types.
