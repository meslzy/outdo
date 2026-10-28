# For AI Agents

outdo is deliberately easy for coding agents (and any automation) to drive: every question an agent needs to ask has a JSON answer, every failure has a stable code, and mistakes are caught before side effects.

## The agent loop

::: info AGENT RECIPE
1. **Discover** — `outdo ls --json`: every task, its flags (types, choices, positional), deps, steps, `readonly`/`destructive` tags, whether it asks before running, and whether it needs env
2. **Preview** — `outdo --dry=json <task>`: exact execution order + what's already cached
3. **Diagnose** — `outdo --json explain <task>`: *why* each task will run or skip, down to the changed files and fingerprint component — without running anything
4. **Preflight env** — `outdo --print-env <task> --json`: exits `3` with structured issues if the environment won't validate — before anything runs
5. **Run** — `outdo --json <task>`: a complete [run report](/reference/exit-codes-and-json#run-report-json) on stdout (per-task status, timing, cache result, critical path), logs on stderr, error object on stderr, exit code `0/1/2/3/130`
:::

## Why agents make fewer mistakes here

- **Dep typos are compile errors.** An agent editing `do.ts` sees `Did you mean "build"?` from `tsc` in the editor diagnostics — before ever executing anything.
- **Unknown tasks/flags exit `2` with a `Did you mean` hint** — trivially recoverable programmatically.
- **Env schemas fail closed.** A missing secret is one structured error with a path, not a half-completed deployment.
- **`--dry=json` is a real plan**, not a guess — the same resolver that executes produces it.
- **The run report closes the loop.** After `outdo --json build`, the agent doesn't parse log soup — it reads `tasks[].status`, `error`, `cache`, and `timing.criticalPath` from one JSON document.
- **`explain` answers "why did that re-run?"** with a named reason (`inputs-changed: src/app.ts`), which is exactly the question agents get asked.
- **Passthrough is explicit.** Anything after `--` reaches only the named task (`ctx.rest`), so an agent can forward arguments without auditing the whole graph.

## Handy one-liners

```sh
# does this repo define a "deploy" task, and what flags does it take?
outdo ls --json | jq '.tasks[] | select(.name == "deploy") | {deps, args}'

# would running "release" rebuild anything, or is it all cached?
outdo --dry=json release | jq '[.plan[] | select(.cached | not) | .name]'

# why exactly will "build" re-run?
outdo --json explain build | jq '.tasks[] | select(.verdict == "would-run") | {name, reasons}'

# is the environment ready for "deploy"? (exit 3 + issues if not)
outdo --print-env deploy --json

# run and report: which tasks failed, and what bounded the wall-clock time?
outdo --json build | jq '{failed: [.tasks[] | select(.status == "failed").name], critical: .timing.criticalPath}'

# in CI: run only what this branch actually touched
outdo --affected=origin/main --json test

# machine-readable dependency graph
outdo graph --json

# which tasks does nothing use, and which are duplicates?
outdo usage --json | jq '{unused: [.tasks[] | select(.status == "unused").name], duplicates}'
```

## MCP server

`outdo mcp` serves every task as a [Model Context Protocol](https://modelcontextprotocol.io) tool over stdio, so Claude (or any MCP client) calls tasks with typed inputs instead of guessing flags from `--help`:

```jsonc
// .mcp.json
{ "mcpServers": { "outdo": { "command": "bunx", "args": ["outdo", "mcp"] } } }
```

- **One tool per task.** Names are made tool-safe (`db:reset` → `db_reset`); the description is the task's `desc`, plus the command it runs and whether it asks first. Services (they never finish), hooks and empty tasks are left out.
- **Typed inputs.** The input schema is built from the task's flags — a [schema flag](/guide/args-and-flags#schema-flags) brings its own JSON Schema (enums, patterns, ranges), an ArgSpec maps to `string`/`boolean` with `enum` from `choices`. Every tool also takes `rest` (args after `--`), and `mode` when the project declares modes.
- **Hints.** `readonly: true` → `readOnlyHint`; `destructive: true`, `protect` or `confirm` → `destructiveHint`, so the client asks you before calling it.
- **Confirmation stays with you.** A task that asks before running gets a `yes` input described as "set true only after the user explicitly agreed". Without it the call fails with outdo's "asks for confirmation" error — nothing runs.
- **Results.** A call runs `outdo run <task>` in a child process and returns its output (the last 30,000 characters) plus the exit code; a non-zero exit is an `isError` result. A cancelled request kills the run.
- Under `OUTDO_READONLY=1` only read-only tasks are listed.

## Unattended loops

Agents running on their own (loops, worktrees, CI bots) should only touch tasks that can't hurt:

- Tag tasks [`readonly: true` / `destructive: true`](/guide/safety#readonly-and-destructive); `outdo ls --json` exposes the tags, so a tool-use hook can allow `readonly` tasks and block the rest.
- Set `OUTDO_READONLY=1` in the loop's environment and outdo itself refuses everything else (exit `2`, before anything runs).
- [protect/confirm](/guide/safety#protect-and-confirm) tasks refuse without a terminal; an agent must never add `--yes` on its own.

## Cleaning up a do.ts

[`outdo usage --json`](/guide/usage) is the evidence for a cleanup: every task with its runs (`you`, `agent`, `deps`, `hooks`, `typed`), `status` (`used` / `referenced` / `unused`), what references it (`usedBy`), when outdo first saw it (`firstSeen`), each flag's `given` / `runs` / `unusedValues`, and the static `duplicates`. Runs an agent makes are recorded as the agent's (`AI_AGENT`, `CLAUDECODE`, MCP), so you can see what only your agents use.

- Act on `duplicates` first — they are static facts.
- Treat `unused` as a proposal: check `trackedSince` (a young log proves little), and member scripts (`pkg#name`) that a container or turbo may run. Ask before deleting.

## The outdo skill

outdo ships an agent skill — how to read the task list, run tasks safely, write `do.ts` entries, and move a repo off scripts/turbo/makefiles — in the [Vercel skills](https://github.com/vercel-labs/skills) layout (`skills/outdo/SKILL.md`):

::: code-group

```sh [skills CLI]
bunx skills add meslzy/outdo            # Claude Code, Cursor, Codex, ...
```

```sh [outdo]
outdo skill install                     # this repo: .claude/skills/outdo
outdo skill install --global            # every repo: ~/.claude/skills/outdo
```

```sh [npm package]
bunx skills experimental_sync           # links skills bundled in installed packages
```

:::

`outdo skill install` needs nothing but outdo itself (no Node); it copies the skill bundled with the installed version, so the instructions always match the CLI you run. `outdo skill path` prints where that copy lives.

## Writing agent-friendly tasks

- Give every task a `desc` — it's the documentation `ls --json` and MCP expose
- Prefer [typed `args`](/guide/args-and-flags) over parsing `ctx.rest` — they're discoverable, validated, and become MCP input schemas
- Declare [`env` schemas](/guide/env) for anything touching credentials — agents get preflight instead of mid-run explosions
- Declare [`inputs`](/guide/caching) so repeated agent runs are near-free
- Mark tasks `readonly` / `destructive`, and `protect` the dangerous ones
