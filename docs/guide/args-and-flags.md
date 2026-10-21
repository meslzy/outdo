# Args & Flags

**Typed, declared CLI flags per task**, with strict parsing, auto-generated help, shell completion (values included) and MCP input schemas — from one declaration.

```ts
exec: {
	desc: "Run a command inside a service container",
	args: {
		service: { type: "string", short: "s", default: "api", choices: ["api", "worker"], description: "compose service" },
		cmd: { type: "string", default: "sh", description: "command to run" },
		verbose: { type: "boolean", short: "v" },
	},
	run: async ({ $, args }) => {
		args.service; // "api" | "worker"  (default applied)
		args.verbose; // boolean           (false unless passed)
		await $`docker compose exec ${args.service} ${args.cmd}`;
	},
},
```

```sh
outdo exec -s worker --cmd bash
outdo exec --service worker -v
```

A flag is declared either as an **ArgSpec** (below) or as any **[Standard Schema](#schema-flags)** — zod, valibot, arktype. Both type `ctx.args` without a `task()` wrapper.

## The ArgSpec

| field | meaning |
| --- | --- |
| `type` | `"string"` or `"boolean"` |
| `short` | single-character alias (`-s`) |
| `default` | applied when the flag is absent |
| `required` | strings only — a missing flag exits `2` with guidance |
| `choices` | allowed values — anything else exits `2` and lists them; shown in help and offered by Tab |
| `suggest` | values offered by Tab completion only, not enforced |
| `description` | shown in `--help`, completions and MCP tool schemas |

The context type follows the declaration: `choices` narrow to the union; `required: true` or a `default` removes `undefined`. Booleans are always `boolean`.

## Schema flags

Put a schema straight in `args`. The value is validated (and coerced) **before anything runs**, and `ctx.args` gets the schema's output type:

```ts
import { z } from "zod";

feed: {
	args: {
		source: z.enum(["eco", "metal", "all"]).default("all").describe("which feed"),
		runs: z.coerce.number().int().min(1).default(1),
		id: z.string().regex(/^C-\d{4}$/).optional(),
		tags: z.array(z.string()).optional(), // --tags a --tags b
	},
	run: ({ args }) => {
		args.source; // "eco" | "metal" | "all"
		args.runs; // number
		args.id; // string | undefined
	},
},
```

```txt
$ outdo feed --source nope
error Task "feed": invalid value "nope" for --source: Invalid option: expected one of "eco"|"metal"|"all"
```

How outdo reads a schema (through its [Standard JSON Schema](https://standardschema.dev), which zod 4 provides):

- **Shape** — a `boolean` schema is a switch (`--dry`), an `array` repeats (`--tags a --tags b`), a `number`/`integer` gets numeric strings converted before validation (so even `z.number()` works); everything else takes a string.
- **Defaults** — the schema's `.default()` applies when the flag is absent. A boolean without a default is `false` when absent.
- **Required** — a flag is required when it has no default and the schema rejects "absent": `Task "x" requires --id (...)`.
- **Choices, description, short alias** — from the schema's enum, `.describe()`, and `.meta({ short: "s" })`.
- Schemas with transforms work too: outdo describes the input side, `ctx.args` gets the transformed output. A library without Standard JSON Schema support still validates and types; its flags are simply treated as string flags with no listed choices.

The JSON Schema also becomes the flag's input schema in [`outdo mcp`](/reference/ai-agents#mcp-server).

## Positional values

Name the flags that may be given as bare words, in order:

```ts
logs: {
	args: {
		svc: { type: "string", choices: ["api", "web"], required: true },
		follow: { type: "boolean", short: "f" },
	},
	positional: ["svc"],
	run: ({ args }) => ...,
},
candidate: {
	args: { id: { type: "string", required: true }, to: { type: "string" } },
	positional: ["id", "to"],
	run: ...,
},
```

```sh
outdo logs api -f                 # same as: outdo logs --svc api -f
outdo candidate C-0007 accepted   # same as: outdo candidate --id C-0007 --to accepted
```

- The last positional may be an array flag; it takes all remaining bare words.
- Giving a flag both ways (`outdo logs api --svc web`) and extra bare words are usage errors; a task without `positional` rejects bare words (`Unexpected argument`).
- Once outdo sees a task with positional values, every later word belongs to it — so `outdo logs api` never tries to run a task named `api`.
- Tab completes the next positional value from its choices: `outdo logs <Tab>` → `api  web`.

## Auto-generated help

```txt
$ outdo logs --help
logs

Usage: outdo logs <svc> [flags] [-- args]

Flags
      --svc      (string, api | web, required, positional)
  -f, --follow
```

`--help` also lists a task's steps, deps, the command it runs, whether it asks before running, and its `finally` tasks. Typos get the same treatment as everything else in outdo:

```txt
$ outdo exec --servcie api
error Task "exec": Unknown option '--servcie'. Did you mean "--service"?
```

## Rules worth knowing

- **Global flags go before the task name**, task flags after: `outdo --watch exec -s api`
- Four runner flags work **on either side**: `--mode`, `--yes`, `--from`, `--until` — `outdo up --mode prod` is the same as `outdo --mode prod up`. A task that declares a flag with one of those names keeps it.
- Task flags require exactly **one** task on the command line (`outdo a b --flag` is a usage error)
- Dependencies get their flags' defaults (schema defaults included); a dependency's required flag is simply left `undefined`
- Everything after `--` skips flag parsing entirely and lands in `ctx.rest` (or is appended to a command task) — only for tasks you explicitly named, never their deps:

```sh
outdo test -- --bail --coverage
# in test:  ctx.rest === ["--bail", "--coverage"]
# in deps:  ctx.rest === []
```

::: tip Args are part of the cache key
Different `--source eco` vs `--source all` invocations [fingerprint separately](/guide/caching) — a cached run is only reused for the same arguments.
:::
