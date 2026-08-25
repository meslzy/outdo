# Args & Flags

No other task runner does this well: **typed, declared CLI flags per task**, with strict parsing, auto-generated help, and shell completion — from one declaration.

```ts
exec: task({
	desc: "Run a command inside a service container",
	args: {
		service: { type: "string", short: "s", default: "api", description: "compose service" },
		cmd: { type: "string", default: "sh", description: "command to run" },
		verbose: { type: "boolean", short: "v" },
	},
	run: async ({ $, args }) => {
		args.service; // string        (default applied)
		args.verbose; // boolean       (false unless passed)
		await $`docker compose exec ${args.service} ${args.cmd}`;
	},
}),
```

```sh
bundo exec -s worker bash
bundo exec --service worker --cmd bash -v
```

## The ArgSpec

| field | meaning |
| --- | --- |
| `type` | `"string"` or `"boolean"` |
| `short` | single-character alias (`-s`) |
| `default` | applied when the flag is absent |
| `required` | strings only — missing flag exits `2` with guidance |
| `description` | shown in `--help` and completions |

The context type follows the declaration: `required: true` or a `default` → `string`; otherwise `string | undefined`. Booleans are always `boolean`.

## Auto-generated help

```txt
$ bundo exec --help
exec — Run a command inside a service container

Usage: bundo exec [flags] [-- args]

Flags
  -s, --service  compose service (string, default: "api")
      --cmd      command to run (string, default: "sh")
  -v, --verbose
```

Typos get the same treatment as everything else in bundo:

```txt
$ bundo exec --servcie api
error Task "exec": Unknown option '--servcie'. Did you mean "--service"?
```

## Rules worth knowing

- **Global flags go before the task name**, task flags after: `bundo --watch exec -s api`
- Task flags require exactly **one** task on the command line (`bundo a b --flag` is a usage error)
- Everything after `--` skips flag parsing entirely and lands in `ctx.rest` — only for tasks you explicitly named, never their deps:

```sh
bundo test -- --bail --coverage
# in test:  ctx.rest === ["--bail", "--coverage"]
# in deps:  ctx.rest === []
```

::: tip Args are part of the cache key
Different `--mode prod` vs `--mode dev` invocations [fingerprint separately](/guide/caching) — a cached run is only reused for the same arguments.
:::
