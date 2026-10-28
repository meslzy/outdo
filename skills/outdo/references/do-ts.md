# do.ts reference

`do.ts` default-exports `defineTasks(tasks, options?)` from `@meslzy/outdo`. Each entry is one of:

| entry | meaning |
| --- | --- |
| `"cmd args"` | one Bun Shell command; args after `--` are appended |
| `["cmd1", "cmd2"]` | commands in order (passthrough args go on the last) |
| `{ ...fields }` | a task object (below) |
| `task({ ... })` | same object, built ahead of time (optional; handy with `from()`) |
| `ns({ a, b })` | a namespace: `ns:a`, `ns:b`; run as `outdo ns a` or `outdo ns:a` |

## Task fields

| field | type | meaning |
| --- | --- | --- |
| `desc` | string | one line in the task list |
| `group` | string | list heading (namespaces default to their name) |
| `run` | function \| command \| commands | the body; omit for aggregation (deps/steps only) |
| `deps` | names | run first, in parallel, once each. Entries: `"name"`, `"^name"` (in every workspace dependency), `"pkg#name"`, `{ task, if: "ENV_VAR" \| (env) => boolean }`, `optional("name")`, `from("name", producer)` |
| `steps` | names | run one after another after `deps`; `--from`/`--until` pick a range |
| `finally` | names | run after this task even when it failed or was interrupted |
| `args` | record | flags: an ArgSpec `{ type: "string" \| "boolean", short?, default?, required?, choices?, suggest?, description? }` or any Standard Schema (`z.enum([...])`, `z.coerce.number()`, `z.array(z.string())`) |
| `positional` | arg names | flags that may be given as bare words, in order (`outdo logs api`) |
| `env` | Standard Schema | validated against the resolved env before anything runs; typed `ctx.env` |
| `envFiles` | paths | extra env files for this task; `.env.x` also loads `.env.x.<mode>` |
| `inputs` / `outputs` | globs | fingerprint cache: skip when inputs are unchanged; outputs are restored from the cache when deleted |
| `watch` | globs | `--watch` triggers (default: `inputs`) |
| `persistent` | boolean | a service: dependents start once it is ready; stopped when the requested tasks finish |
| `ready` | `{ log \| url \| port, host?, timeoutMs? }` | readiness probe for a service |
| `retry` | number \| `{ attempts, delayMs?, backoff? }` | re-run on failure |
| `timeoutMs` | number | per-attempt budget |
| `cwd` | path | relative to the do.ts |
| `protect` | `true` \| mode \| modes | ask before running (in those modes); `--yes` answers |
| `confirm` | string | always ask this question first |
| `requires` | `{ bin?, env?, file?, url?, port?, host?, hint? }` | checked right before the task starts; `outdo doctor` checks all |
| `readonly` | boolean | safe unattended; the only tasks allowed under `OUTDO_READONLY=1` |
| `destructive` | boolean | hard to undo (MCP `destructiveHint`) |

## Options (second argument)

```ts
defineTasks(tasks, {
	modes: ["dev", "prod"],                  // --mode; first is the default; selects .env.<mode>
	members: { tsc: { deps: ["^tsc"], inputs: ["src/**"] } }, // merged into every member's task of that name
	hooks: { "pre-commit": { steps: ["fix", "test"], restage: true }, "pre-push": "bun scripts/guard.ts" },
});
```

## Context (`run` parameter)

| field | meaning |
| --- | --- |
| `$` | Bun Shell bound to the task's cwd and env (`node_modules/.bin` on PATH) |
| `args` | parsed flags (schema outputs when flags are schemas) |
| `env` | schema output, or the raw resolved env |
| `deps` | dep outputs: what each dep's `run` returned (JSON) |
| `rest` | args after `--` (only for tasks named on the command line) |
| `mode` | active `--mode` (`""` when none are declared) |
| `root` / `cwd` / `name` | repo root, task cwd, task name |
| `ssh(target, { label?, args? })` | remote `$`: `` await ssh("me@vps").cwd("~/app")`git pull` `` (values escaped; `.nothrow()`, `.quiet()`) |
| `log` | prefixed logger (`info`, `warn`, `error`, `debug`) |
| `signal` | aborted on Ctrl-C / watch restart |

Return a JSON value from `run` to hand data to dependents (`ctx.deps.name`); `from("name", producer)` types it.

## Env cascade

`.env` → `.env.<mode or NODE_ENV>` → `.env.local` → `.env.<mode>.local` → the task's `envFiles` → process env (wins). `outdo --print-env <task>` shows which file set each key.

## Workspaces

A root with `package.json` `workspaces` loads the root do.ts plus every member's do.ts and package.json scripts as `pkg#task`. Bare names fan out to members; a root task of the same name keeps the name to itself (member scripts join through `^name` deps). `-F/--filter` selects packages (`name`, `glob`, `./path`, `...name` with dependencies, `name...` with dependents).

## @meslzy/outdo/compose

```ts
import { compose } from "@meslzy/outdo/compose";
defineTasks({ ...compose({ files: (mode) => ["compose.base.yml", `compose.${mode}.yml`], wait: true }) }, { modes: ["dev", "prod"] });
```

Adds `up [svc]`, `down`, `restart`, `rebuild [svc]`, `fresh` (wipes volumes; asks in prod), `logs [svc] [-f]`, `ps`, `shell <svc>`, `exec <svc> -- cmd`. Options: `files`, `project`, `env`, `envFile`, `services`, `wait`, `protect`, `group`, `cwd`, `shell`.
