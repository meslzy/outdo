# Environment

bundo treats the environment as a first-class, **verifiable** input — not something you debug four minutes into a failed deploy.

## The cascade

Resolved from the `do.ts` directory (not your shell's cwd), matching Bun's own loader byte-for-byte:

```txt
.env  →  .env.{NODE_ENV}  →  .env.local  →  .env.{NODE_ENV}.local  →  process env
(lowest precedence)                                                    (always wins)
```

- `.env.local` is skipped when `NODE_ENV=test` (so tests stay reproducible)
- `NODE_ENV` defaults to `development`
- `$VAR` / `${VAR}` expand — including inside single quotes, exactly like Bun; escape with `\$`

## Schemas: fail before anything runs

Declare required env per task with **any [Standard Schema](https://standardschema.dev) validator** — zod v4, valibot, arktype… bundo depends on none of them:

::: code-group

```ts [zod]
deploy: task({
	env: z.object({
		DEPLOY_URL: z.url(),
		RETRIES: z.coerce.number().default(3),
	}),
	run: ({ env }) => {
		env.DEPLOY_URL; // string
		env.RETRIES;    // number — the schema OUTPUT, coercion included
	},
}),
```

```ts [valibot]
deploy: task({
	env: v.object({
		DEPLOY_URL: v.pipe(v.string(), v.url()),
		RETRIES: v.optional(v.pipe(v.string(), v.transform(Number)), "3"),
	}),
	run: ({ env }) => {
		env.DEPLOY_URL; // string
		env.RETRIES;    // number
	},
}),
```

```ts [arktype]
deploy: task({
	env: type({
		DEPLOY_URL: "string.url",
		"RETRIES?": "string.numeric.parse",
	}),
	run: ({ env }) => {
		env.DEPLOY_URL; // string
	},
}),
```

:::

Every schema in the resolved plan is validated **before the first task starts**. One missing secret = one clean line and exit code `3` — zero side effects:

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
$ bundo --print-env deploy
env for task "deploy"
loaded: .env -> .env.local (process env wins)

  DEPLOY_URL  https://prod.example.com  <- .env.local (overrides .env)
  RETRIES     5                         <- process (overrides .env)

✓ schema valid
```

Add `--json` for the machine-readable version (source + overridden-by chain per key).

## Tasks without a schema

`ctx.env` is the raw resolved map — `Readonly<Record<string, string | undefined>>`. The cascade still applies; you just don't get validation or typed keys.
