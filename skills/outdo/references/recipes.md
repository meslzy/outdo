# Moving a repo onto outdo

## package.json scripts

Nothing to do: scripts are tasks already (`outdo test` runs `bun run test`). Move a script into do.ts when it needs deps, flags, caching or a description:

```ts
// was: "check": "bun run fix && bun run tsc && bun test"
check: { steps: ["fix", "tsc", "test"] },
// keep the script, add metadata: an entry without run/steps runs the same-named script
test: { deps: ["tsc"], readonly: true },
```

Remove scripts that only call outdo (`"gate": "outdo gate"`) — outdo ignores them anyway.

## 5-line `run` wrappers

```ts
// was: run: async ({ $ }) => { await $`bun run fix`; }
fix: "bun run fix",
```

## Re-validating flags inside run

```ts
// was: args: { source: { type: "string" } } + z.enum(X).parse(args.source)
args: { source: z.enum(X).default("all") },
```

## turbo

```ts
// was: "tsc": "turbo run tsc && tsc" with turbo.json dependsOn ["^tsc"]
export default defineTasks(
	{ tsc: { deps: ["^tsc"], run: "tsc" } },             // members first, root last
	{ members: { tsc: { deps: ["^tsc"], inputs: ["src/**", "package.json"] } } },
);
```

Then delete turbo.json and the turbo devDependency.

## `--i-know-this-is-production` / assertNotProduction

```ts
"db-reset": { protect: "prod", run: ... }   // asks in prod; scripts pass --yes
```

Declare `modes: ["dev", "prod"]` and drop custom `MODE` env handling: `ctx.mode` and `.env.<mode>` files come for free.

## pid files and stop tasks

```ts
"look-serve": { persistent: true, ready: { port: 3100 }, run: ... },
```

`outdo bg start look-serve` / `outdo bg stop look-serve` replace the pid file code. For "start server, run checks, stop": `{ steps: ["look-serve", "look-shoot"] }` — services started as dependencies stop when the run ends.

## Docker compose wrappers

```ts
import { compose } from "@meslzy/outdo/compose";
...compose({ files: (mode) => ["docker-compose.base.yml", `docker-compose.${mode}.yml`], wait: true }),
```

## .githooks + prepare script

```ts
defineTasks(tasks, { hooks: { "pre-commit": { steps: ["fix", "typegen", "tsc"], restage: true } } });
```

Run `outdo hooks install` once per clone (it unsets `core.hooksPath`), then delete `.githooks/` and the `prepare` script.

## CI

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: oven-sh/setup-bun@v2
- run: bun install --frozen-lockfile
- run: bunx outdo ci check
```

`outdo ci init` writes this. To gate a job on changes (replaces dorny/paths-filter), give the task `inputs` and:

```yaml
- id: changes
  run: bunx outdo affected deploy --github-output
- if: steps.changes.outputs.deploy == 'true'
  run: bunx outdo deploy --mode prod --yes
```

## makefile deploys over ssh

```ts
deploy: {
	protect: "prod",
	env: z.object({ VPS: z.string() }),
	run: async ({ ssh, env }) => {
		const vps = ssh(env.VPS).cwd("~/app");
		await vps`git fetch origin && git reset --hard origin/main`;
		await vps`bunx outdo up --mode prod`;
	},
},
```

## Generated Dockerfile COPY blocks

`outdo prune --docker`, then `COPY out/json/ ./` + `RUN bun install --frozen-lockfile` + `COPY . .`.

## Leftovers after the move

`outdo usage` lists what the move left behind: package.json scripts a do.ts task now hides (`"test": "turbo run test"` next to a do.ts `test`), do.ts entries whose `run` is `bun run <their own name>` (drop the `run`), aliases, and scripts that only call outdo. Delete those right away. Tasks nobody runs show up once outdo has recorded a few weeks of runs — `outdo usage --since 30d`.
