# Environment

outdo treats the environment as a first-class, **verifiable** input — not something you debug four minutes into a failed deploy.

## The cascade

Resolved from the repo root (the `do.ts` directory, or the workspace root) — not your shell's cwd — matching Bun's own loader byte-for-byte:

```txt
.env  →  .env.{NODE_ENV}  →  .env.local  →  .env.{NODE_ENV}.local  →  process env
(lowest precedence)                                                    (always wins)
```

- `.env.local` is skipped when `NODE_ENV=test` (so tests stay reproducible)
- `NODE_ENV` defaults to `development`
- `$VAR` / `${VAR}` expand — including inside single quotes, exactly like Bun; escape with `\$`
- When the project declares [modes](#modes), the mode takes `NODE_ENV`'s place in the file names

## Modes

Declare the modes your project runs in, and pick one with `--mode` (or `-m`):

```ts
export default defineTasks(
	{
		up: {
			envFiles: [".env.platform"],
			run: async ({ $, mode }) => {
				await $`docker compose -f docker-compose.${mode}.yml up -d`;
			},
		},
	},
	{ modes: ["dev", "prod"] }, // the first one is the default // [!code highlight]
);
```

```sh
outdo up                # mode dev:  .env, .env.dev, .env.local, .env.dev.local, then .env.platform, .env.platform.dev
outdo up --mode prod    # mode prod: .env, .env.prod, .env.local, .env.prod.local, then .env.platform, .env.platform.prod
```

- `--mode` may come before or after the task name (`outdo --mode prod up` = `outdo up --mode prod`)
- An undeclared mode is a usage error that lists the valid ones; `--mode` in a project without modes is one too
- `ctx.mode` is the active mode, typed as the union of your modes (`"dev" | "prod"`; `string` inside `ns()`); it's `""` when none are declared
- outdo sets `OUTDO_MODE` for the run, so conditions (`if: (env) => env.OUTDO_MODE === "prod"`), schemas and spawned commands can see it
- [`protect: "prod"`](/guide/safety#protect-and-confirm) makes a task ask before running in that mode

## Per-task env files

`envFiles` adds files for one task, on top of the cascade. Each file also loads its `.<mode>` variant after it, so per-mode values override the shared ones:

```ts
whereami: {
	envFiles: [".env.platform"], // paths are relative to the do.ts
	env: z.object({ PLATFORM: z.string() }),
	run: ({ env, mode }) => console.log(mode, env.PLATFORM),
},
```

Missing files are skipped. The process environment still wins over every file.

## Schemas: fail before anything runs

Declare required env per task with **any [Standard Schema](https://standardschema.dev) validator** — zod v4, valibot, arktype… outdo depends on none of them:

::: code-group

```ts [zod]
deploy: {
	env: z.object({
		DEPLOY_URL: z.url(),
		RETRIES: z.coerce.number().default(3),
	}),
	run: ({ env }) => {
		env.DEPLOY_URL; // string
		env.RETRIES;    // number — the schema OUTPUT, coercion included
	},
},
```

```ts [valibot]
deploy: {
	env: v.object({
		DEPLOY_URL: v.pipe(v.string(), v.url()),
		RETRIES: v.optional(v.pipe(v.string(), v.transform(Number)), "3"),
	}),
	run: ({ env }) => {
		env.DEPLOY_URL; // string
		env.RETRIES;    // number
	},
},
```

```ts [arktype]
deploy: {
	env: type({
		DEPLOY_URL: "string.url",
		"RETRIES?": "string.numeric.parse",
	}),
	run: ({ env }) => {
		env.DEPLOY_URL; // string
	},
},
```

:::

Every schema in the resolved plan is validated **before the first task starts**, each against its own task's env (cascade + its `envFiles`, for the active mode). One missing secret = one clean line and exit code `3` — zero side effects:

```txt
error Environment validation failed:
  deploy: DEPLOY_URL — Invalid URL
```

::: warning Env values are strings
Process environments only carry strings. Use your validator's coercion (`z.coerce.number()`, transforms) to get real types — `ctx.env` is the schema *output*, so it works.
:::

## Explain mode: `--print-env`

Which file set what? What got overridden? Is the schema satisfied? Without running anything:

```txt
$ outdo --print-env deploy
env for task "deploy"
loaded: .env -> .env.local (process env wins)

  DEPLOY_URL  https://prod.example.com  <- .env.local (overrides .env)
  RETRIES     5                         <- process (overrides .env)

✓ schema valid
```

With modes and task env files, the header names the mode and the list includes the task's own files:

```txt
$ outdo --mode prod --print-env whereami
env for task "whereami" (mode prod)
loaded: .env.platform -> .env.platform.prod (process env wins)

  PLATFORM  production  <- .env.platform.prod (overrides .env.platform)

✓ schema valid
```

Add `--json` for the machine-readable version (source + overridden-by chain per key, plus `mode`).

## Tasks without a schema

`ctx.env` is the raw resolved map — `Readonly<Record<string, string | undefined>>`. The cascade and `envFiles` still apply; you just don't get validation or typed keys.
