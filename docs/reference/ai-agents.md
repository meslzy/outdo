# For AI Agents

bundo is deliberately easy for coding agents (and any automation) to drive: every question an agent needs to ask has a JSON answer, every failure has a stable code, and mistakes are caught before side effects.

## The agent loop

::: info AGENT RECIPE
1. **Discover** — `bundo ls --json`: every task, its flags, deps, and whether it needs env
2. **Preview** — `bundo --dry=json <task>`: exact execution order + what's already cached
3. **Preflight env** — `bundo --print-env <task> --json`: exits `3` with structured issues if the environment won't validate — before anything runs
4. **Run** — `bundo <task>`; parse the exit code (`0/1/2/3/130`) and, with `--json`, the error object on stderr
:::

## Why agents make fewer mistakes here

- **Dep typos are compile errors.** An agent editing `do.ts` sees `Did you mean "build"?` from `tsc` in the editor diagnostics — before ever executing anything.
- **Unknown tasks/flags exit `2` with a `Did you mean` hint** — trivially recoverable programmatically.
- **Env schemas fail closed.** A missing secret is one structured error with a path, not a half-completed deployment.
- **`--dry=json` is a real plan**, not a guess — the same resolver that executes produces it.
- **Passthrough is explicit.** Anything after `--` reaches only the named task (`ctx.rest`), so an agent can forward arguments without auditing the whole graph.

## Handy one-liners

```sh
# does this repo define a "deploy" task, and what flags does it take?
bundo ls --json | jq '.tasks[] | select(.name == "deploy") | {deps, args}'

# would running "release" rebuild anything, or is it all cached?
bundo --dry=json release | jq '[.plan[] | select(.cached | not) | .name]'

# is the environment ready for "deploy"? (exit 3 + issues if not)
bundo --print-env deploy --json

# machine-readable dependency graph
bundo graph --json
```

## Writing agent-friendly tasks

- Give every task a `desc` — it's the documentation `ls --json` exposes
- Prefer [typed `args`](/guide/args-and-flags) over parsing `ctx.rest` — they're discoverable and validated
- Declare [`env` schemas](/guide/env) for anything touching credentials — agents get preflight instead of mid-run explosions
- Declare [`inputs`](/guide/caching) so repeated agent runs are near-free
