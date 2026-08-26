# Exit Codes & JSON Output

## Exit codes

| code | meaning |
| --- | --- |
| `0` | success (including all-cached runs) |
| `1` | a task failed (or a service exited unexpectedly) |
| `2` | usage error — unknown task/flag, bad flag value, filter matched nothing |
| `3` | configuration or environment invalid — missing `do.ts`, dependency cycle, schema validation failure |
| `130` | interrupted (Ctrl-C) |

## Errors with `--json`

Any error prints a stable shape on **stderr**:

```json
{
	"error": {
		"code": "env-invalid",
		"message": "Environment validation failed:\n  deploy: DEPLOY_URL — Invalid URL",
		"detail": { "issues": [{ "task": "deploy", "path": "DEPLOY_URL", "message": "Invalid URL" }] }
	}
}
```

Codes: `usage`, `config-not-found`, `config-invalid`, `unknown-task`, `cycle`, `env-invalid`, `task-failed`, `git`, `interrupted`.

## Run report (`--json`)

`outdo <task> --json` redirects all task logs to stderr and prints exactly one JSON document on stdout — on success *and* on failure (exit code and stderr error JSON are unchanged):

```json
{
	"ok": true,
	"startedAt": "2026-08-25T12:00:00.000Z",
	"tasks": [
		{ "name": "codegen", "status": "ok", "durationMs": 0, "startMs": 1, "endMs": 1, "cache": "hit" },
		{ "name": "build", "status": "ok", "durationMs": 1240, "startMs": 2, "endMs": 1242, "cache": "miss" },
		{ "name": "test", "status": "ok", "durationMs": 2100, "startMs": 2, "endMs": 2102, "cache": "disabled", "attempts": 2 }
	],
	"summary": { "ok": 3, "failed": 0, "skipped": 0, "cached": 1, "running": 0 },
	"timing": {
		"totalMs": 2110,
		"criticalPathMs": 2102,
		"criticalPath": ["codegen", "test"],
		"parallelism": 1.58
	}
}
```

- `status`: `ok` | `failed` (with `error`) | `skipped` (a dep failed) | `aborted` (fail-fast/interrupt) | `running` (a service still alive when the DAG drained)
- `cache`: `hit` (skipped via fingerprint) | `miss` (cacheable, ran) | `disabled` (no `inputs`, service, or never ran)
- `startMs`/`endMs` are run-relative; `attempts` appears when a [retry policy](/guide/execution#retries) kicked in
- `timing.criticalPath` is the dependency chain that bounded wall-clock time; `parallelism` = total task time ÷ wall time

`--profile[=<file>]` writes the same timeline as Chrome trace-event JSON for `chrome://tracing` / Perfetto.

## `explain <task> --json`

Read-only cache/plan diagnosis (assumes default args, empty `--` passthrough):

```json
{
	"task": "build",
	"backend": { "kind": "parallel", "concurrency": 8 },
	"plan": ["codegen", "build"],
	"tasks": [
		{
			"name": "build",
			"deps": ["codegen"],
			"persistent": false,
			"cacheable": true,
			"verdict": "would-run",
			"reasons": [{ "kind": "inputs-changed", "added": [], "removed": [], "modified": ["src/app.ts"] }],
			"fingerprint": "9f2c1a77b3d4e5f6",
			"inputs": [{ "glob": "src/**/*.ts", "matches": 14 }],
			"outputs": { "patterns": ["dist/**"], "present": true },
			"envSchema": false
		}
	]
}
```

`verdict`: `would-run` | `would-skip` | `not-cacheable` | `service`. Reason kinds: `no-manifest`, `forced`, `def-changed`, `env-changed`, `args-changed`, `rest-changed`, `deps-changed`, `dep-outputs-changed`, `inputs-changed` (with file lists), `outputs-missing`. Tasks with `ready`/`retry`/`timeoutMs` include those settings verbatim.

## `ls --json` — the task model

```json
{
	"configPath": "C:/repo/do.ts",
	"tasks": [
		{
			"name": "deploy",
			"desc": "Deploy to production",
			"group": "Release",
			"deps": ["build"],
			"args": {
				"dry": { "type": "boolean", "short": "d", "default": null, "required": false, "description": null }
			},
			"hasEnvSchema": true,
			"inputs": [],
			"outputs": [],
			"watch": [],
			"persistent": false
		}
	]
}
```

## `--dry=json` — the plan

```json
{
	"plan": [
		{ "name": "build", "requested": false, "deps": [], "persistent": false, "hasRun": true, "cached": true },
		{ "name": "deploy", "requested": true, "deps": ["build"], "inactiveDeps": ["smoke"], "persistent": false, "hasRun": true, "cached": false }
	],
	"affected": { "base": "origin/main (merge-base 4f2a91c)", "kept": ["deploy"], "dropped": [] }
}
```

Dependencies first (topological order); `cached: true` means the task would be skipped as-is. `inactiveDeps` lists [conditional edges](/guide/tasks-and-deps#conditional-and-optional-dependencies) whose condition didn't hold; the `affected` block appears only with [`--affected`](/guide/workspaces#git-aware-runs-affected).

## `graph --json`

```json
{
	"nodes": ["build", "test", "deploy"],
	"edges": [
		{ "from": "build", "to": "test" },
		{ "from": "test", "to": "deploy", "if": "CI" },
		{ "from": "notify", "to": "deploy", "optional": true }
	]
}
```

Edges point dependency → dependent, with condition/optional metadata (`"if": "<fn>"` for predicates). `outdo graph` (no flag) prints mermaid — conditional edges render dashed; `--dot` prints graphviz.

## `--print-env <task> --json`

::: details Full shape
```json
{
	"task": "deploy",
	"loadedFiles": [".env", ".env.local"],
	"env": {
		"DEPLOY_URL": {
			"value": "https://prod.example.com",
			"source": ".env.local",
			"overrides": [".env"]
		}
	},
	"validation": {
		"ok": false,
		"issues": [{ "path": "RETRIES", "message": "Invalid input: expected number" }]
	}
}
```
Exit code is `0` when validation passes, `3` when it doesn't — so it works as a CI preflight check.
:::
