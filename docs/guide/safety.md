# Safety

Three small guards for the tasks you don't want to run by accident, the tasks that need something running first, and the unattended runs (CI, agents) that should only read.

## protect and confirm

```ts
export default defineTasks(
	{
		"db:reset": {
			protect: "prod", // asks only in prod mode  // [!code highlight]
			run: "bun db/reset.ts",
		},
		"servers-destroy": {
			confirm: "Delete every game server on the dev stack?", // always asks  // [!code highlight]
			destructive: true,
			run: "bun scripts/destroy.ts",
		},
	},
	{ modes: ["dev", "prod"] },
);
```

| field | asks |
| --- | --- |
| `protect: true` | before every run: `Run "x"?` |
| `protect: "prod"` / `["prod", "staging"]` | only in those [modes](/guide/env#modes): `Run "x" in prod mode?` |
| `confirm: "question"` | before every run, with your question |

```txt
$ outdo db:reset --mode prod
? Run "db:reset" in prod mode? [y/N] y
...
```

- **Every question in the plan is asked before anything starts** — a protected dependency asks before its dependents' deps begin.
- `--yes` (or `-y`) answers yes for scripts — before or after the task name: `--yes: confirmed db:reset`.
- **No terminal, no `--yes`: refused.** CI jobs and agents never hang on a prompt and never run it silently:

```txt
$ outdo db:reset --mode prod < /dev/null
error "db:reset" asks for confirmation and there is no terminal to ask in. Re-run with --yes to confirm.
```

- Any answer other than `y` stops the run: `error Not confirmed — nothing was run.` (exit `2`).
- `--dry` never asks. [`outdo bg start`](/guide/watch-and-services#background-runs-outdo-bg) asks in your terminal, then starts the background run already confirmed. Over [MCP](/reference/ai-agents#mcp-server), these tasks get a `yes` input the agent may only set after you agreed.

This replaces flags like `--i-know-this-is-production` and hand-written `assertNotProduction()` checks.

## requires and doctor

Check that a tool is installed or the stack is up **right before the task starts**, and fail in one line with a hint:

```ts
"test-stack": {
	requires: {
		bin: ["docker"],                              // on PATH (node_modules/.bin counts)
		env: ["STRIPE_KEY"],                          // set and non-empty
		file: ["certs/dev.pem"],                      // exists, relative to the task's cwd
		url: "https://api.serverk.localhost/health",  // GET returns 2xx (2s timeout)
		hint: "the dev stack is down — run outdo dev",
	},
	run: "bun test test/stack",
},
```

```txt
$ outdo test-stack
✗ test-stack (0ms) Task "test-stack" requires url https://api.serverk.localhost/health — the dev stack is down — run outdo dev
```

`port` (with an optional `host`, default `127.0.0.1`) checks a TCP connection instead of a URL. The checks run after the task's deps finished — so a dep can be what brings the service up — and are skipped on a cache hit. A failed check fails the task (exit `1`) like any other failure.

`outdo doctor` runs every task's checks at once, in the active `--mode`, and tells you about declared [git hooks](/guide/ci-cd#git-hooks) that aren't installed:

```txt
$ outdo doctor
✗ test-stack
    ✓ bin docker
    ✗ url https://api.serverk.localhost/health
    → the dev stack is down — run outdo dev
! git hooks not installed: pre-commit — run "outdo hooks install"
```

It exits `1` when anything fails; `--json` gives `{ ok, mode, tasks: [{ task, hint, checks }], hooks }`.

## readonly and destructive

Tag tasks instead of writing "Read-only:" in their descriptions:

```ts
"github-audit": { readonly: true, desc: "Compare every repository with repositories.ts", run: ... },
"servers-destroy": { destructive: true, run: ... },
```

- The task list shows `read-only` / `destructive`; `outdo ls --json` has `readonly`, `destructive`, `protect` and `confirm` for every task — enough for a hook that lets an agent run read-only tasks and blocks the rest.
- **`OUTDO_READONLY=1`** makes outdo itself refuse any planned task that isn't `readonly: true` (exit `2`, before anything runs). Set it for agent loops and worktrees:

```txt
$ OUTDO_READONLY=1 outdo servers-destroy
error OUTDO_READONLY is set: refusing "servers-destroy" (not marked readonly: true).
```

The check covers dependencies too; aggregation tasks without a body are fine as long as everything they pull in is read-only. Any value except `""`, `0`, `false` and `no` turns it on. [`outdo mcp`](/reference/ai-agents#mcp-server) only offers read-only tasks under it, and maps the tags to `readOnlyHint` / `destructiveHint`.
