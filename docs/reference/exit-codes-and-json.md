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

Codes: `usage`, `config-not-found`, `config-invalid`, `unknown-task`, `cycle`, `env-invalid`, `task-failed`, `interrupted`.

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
		{ "name": "deploy", "requested": true, "deps": ["build"], "persistent": false, "hasRun": true, "cached": false }
	]
}
```

Dependencies first (topological order); `cached: true` means the task would be skipped as-is.

## `graph --json`

```json
{
	"nodes": ["build", "test", "deploy"],
	"edges": [["build", "test"], ["build", "deploy"]]
}
```

Edges point dependency → dependent. `bundo graph` (no flag) prints mermaid; `--dot` prints graphviz.

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
