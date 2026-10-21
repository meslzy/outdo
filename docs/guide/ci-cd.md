# CI & Deploys

The glue around your tasks — the CI workflow, git hooks, deploy scripts, Docker layers, compose wrappers — lives in `do.ts` too.

## `outdo ci`

One line in GitHub Actions:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # outdo compares against the PR base / previous push
- uses: oven-sh/setup-bun@v2
- run: bun install --frozen-lockfile
- run: bunx outdo ci check
```

`outdo ci <task...>` is a normal run with CI defaults:

- **Only what changed.** It runs with [`--affected`](/guide/workspaces#git-aware-runs-affected) against [the right base](#what-changed). `--all` runs everything; `--base <rev>` picks the base. Both may follow the task names (`outdo ci check --all`).
- **Folded logs.** Output is grouped per task; in GitHub Actions each task is a collapsible `::group::` (`::group::test (failed)` when it failed).
- **Failures at the end, unfolded.** After the run, each failed task's output is printed again with its error — no hunting through folds.
- **Annotations.** In Actions, errors from `tsc` (`file(line,col): error TS…`), Biome (`file:line:col rule`) and `bun test` (`(fail) name`) become annotations on the files, plus one per failed task with the end of its output.
- **A summary table** on the run page (`$GITHUB_STEP_SUMMARY`): every task's status and time, cached ones marked.
- **Services are skipped.** A requested persistent task never finishes, so CI leaves it out (`skipping service(s): dev`); one needed as a dependency still starts and is stopped at the end.

When nothing changed, `outdo ci` says so (also in the summary) and exits `0`. Outside Actions you get the grouped output and the failure recap, without the workflow commands.

### What changed

`--affected` and `outdo ci` pick the base from the Actions event:

| event | compared with |
| --- | --- |
| `pull_request` (`GITHUB_BASE_REF`) | the merge-base with `origin/<base branch>` |
| `push` | the previous tip of the branch (the event's `before` commit) |
| anything else, or outside Actions | the merge-base with origin's default branch, else `HEAD~1` |

A base that isn't in the clone is a loud error telling you to use `fetch-depth: 0` — never a silent "nothing changed".

### `outdo ci init`

Writes `.github/workflows/ci.yml` for you (refuses to overwrite without `--force`):

```txt
$ outdo ci init
✓ wrote .github/workflows/ci.yml (runs "outdo ci check")
```

It runs the first of `check`, `ci`, `gate`, `verify`, `test`, `build` that your project has, on pushes to your default branch and on pull requests.

## Skipping jobs: `outdo affected`

To decide whether a whole job should run — without a second list of paths to keep in sync — ask outdo about the task's own `inputs`:

```yaml
- id: changes
  run: bunx outdo affected deploy --github-output # writes deploy=true|false
- if: steps.changes.outputs.deploy == 'true'
  run: bunx outdo deploy --mode prod --yes
```

```txt
$ outdo affected deploy api
compared with origin/main (merge-base 4f2a91c0d1e2)
deploy=true
api=false
```

- One `name=true|false` line per task; names are made output-safe (`db:reset` → `db_reset`, `@acme/api#build` → `_acme_api_build`).
- `--github-output` also appends them to `$GITHUB_OUTPUT`; `--json` prints `{ base, affected }`; `--base <rev>` sets the base. The exit code is `0` whatever the answer (a git problem is still an error).
- A bare name that fans out over workspace members is affected when any of its tasks is.

This replaces `dorny/paths-filter`-style path lists.

## Git hooks

Hooks live next to your tasks:

```ts
export default defineTasks(
	{
		fix: "bunx biome check --write",
		typegen: "bun scripts/typegen.ts",
		tsc: "bunx tsc --noEmit",
	},
	{
		hooks: {
			"pre-commit": { steps: ["fix", "typegen", "tsc"], restage: true }, // [!code highlight]
			"pre-push": "bun scripts/pre-push-guard.ts",
		},
	},
);
```

A hook is a command, a command list, or a task-like object (`steps`, `deps`, `run`, `desc`). Hook names and their step/dep names are checked at compile time.

```sh
outdo hooks install     # once per clone
outdo hooks             # (or hooks list) declared hooks and whether they're installed
outdo hooks uninstall
```

```txt
$ outdo hooks
  pre-commit           installed  git pre-commit hook (restage)
```

- `install` writes a small script per hook into git's hooks directory. The script runs the repo's own outdo (`node_modules/.bin/outdo`, else a global `outdo`, else `bunx outdo`) with `outdo hooks run <hook>`, passing git's arguments along (they arrive in `ctx.rest` — e.g. the message file for `commit-msg`).
- If `core.hooksPath` is set (say, to `.githooks` by a `prepare` script), `install` unsets it so git uses these hooks — the old directory and the `prepare` script can go. An existing hook outdo didn't write is kept as `<hook>.pre-outdo` and put back on `uninstall`.
- **`restage: true`**: files that were fully staged before the hook ran (no unstaged edits of their own) and that the hook changed — a formatter, typically — are staged again once the hook succeeds, so the commit includes the fix. Partially staged files are left alone.
- A failing hook fails the git command, as usual. `outdo doctor` warns about declared hooks that aren't installed.

## Deploys over ssh: `ctx.ssh`

A `$` that runs on a remote host, through your system `ssh`:

```ts
deploy: {
	protect: "prod",
	env: z.object({ VPS_HOST: z.string(), VPS_USER: z.string() }),
	run: async ({ ssh, env }) => {
		const vps = ssh(`${env.VPS_USER}@${env.VPS_HOST}`).cwd("~/meslzy.com");
		await vps`git fetch origin && git reset --hard origin/main`;
		await vps`bunx outdo up --mode prod`;
	},
},
```

```txt
vps.example.com | HEAD is now at 4f2a91c ...
```

- Interpolated values are shell-escaped for the remote shell; arrays become several words; an interpolated `{ raw: "..." }` object is inserted as is.
- Output streams line by line with a `host |` prefix (`ssh(target, { label: "vps" })` to rename it) and is also returned: `{ exitCode, stdout, stderr }`.
- A non-zero exit throws; `.nothrow()` returns it instead. `.quiet()` stops the echo. `.cwd(dir)` runs every command from `dir` (`~/…` stays the remote home). `ssh(target, { args: ["-p", "2222"] })` adds ssh arguments.
- Ctrl-C / an aborted run kills the ssh process.

This replaces deploy steps written as inline ssh in workflow files and a `makefile` on the server — the server only needs Bun and the repo.

## Docker layers: `outdo prune --docker`

Copies what `bun install` needs into `out/json/` — the root `package.json`, every workspace member's `package.json` at its own path, and `bun.lock` / `bun.lockb` / `bunfig.toml` when present — so the dependency layer of your image only rebuilds when dependencies change:

```txt
$ outdo prune --docker
✓ out/json/ (4 files)
  package.json
  bun.lock
  packages/app/package.json
  packages/lib/package.json
```

```dockerfile
COPY out/json/ ./
RUN bun install --frozen-lockfile
COPY . .
```

`out/json/` is wiped first; `--out <dir>` changes the base. No `do.ts` is loaded (it may import packages that aren't installed yet), and `.npmrc` is never copied — it often holds registry tokens. Trimming to a single package's dependencies isn't supported yet.

## Docker Compose: `@meslzy/outdo/compose`

One spread gives you the compose tasks every stack repo rewrites:

```ts
import { defineTasks } from "@meslzy/outdo";
import { compose } from "@meslzy/outdo/compose";

export default defineTasks(
	{
		...compose({
			files: (mode) => ["docker-compose.base.yml", `docker-compose.${mode}.yml`],
			env: { COMPOSE_BAKE: "true" },
			wait: true, // up waits until every service is running/healthy
		}),
	},
	{ modes: ["dev", "prod"] },
);
```

| task | runs `docker compose …` |
| --- | --- |
| `up [svc]` | `up -d [--wait] [svc]` |
| `down` | `down` |
| `restart` | `down`, then `up -d` |
| `rebuild [svc]` | `up -d --build --force-recreate [svc]` |
| `fresh` | `down -v --remove-orphans`, then `up -d --build` — `destructive`, asks in `prod` |
| `logs [svc] [-f] [--tail 200]` | `logs --tail=200 [--follow] [svc]` (read-only) |
| `ps` | `ps` (read-only) |
| `shell <svc>` | `exec <svc> sh` |
| `exec <svc> -- cmd` | `exec <svc> cmd…` |

Options: `files` (a list, or a function of the active mode), `project` (`-p`), `env`, `envFile` (`--env-file`, or a function of the mode), `services`, `wait`, `protect` (modes in which `fresh` asks; default `"prod"`), `group` (default `"Docker"`), `cwd`, `shell` (default `sh`).

Commands run with your terminal attached, so `shell` and `exec` are interactive. Service names complete with Tab: from `services` when you pass it (then flags only accept those), otherwise read from the compose files in the directory (hints only). Pass `import.meta.dir` as the second argument when outdo may run from another directory: `compose(options, import.meta.dir)`. The tasks are plain entries — rename, drop or wrap them like any other.
