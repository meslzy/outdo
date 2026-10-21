# Workspaces

At a [Bun workspace](https://bun.com/docs/install/workspaces) root, outdo merges the root `do.ts` (and root `package.json` scripts) with every member package's `do.ts` **and its `package.json` scripts**. Member tasks are namespaced **`pkg#task`**:

```txt
my-monorepo/
  package.json          { "workspaces": ["packages/*"] }
  do.ts                 → tsc, lint
  packages/
    app/package.json    scripts: tsc, test        → @acme/app#tsc, @acme/app#test
    lib/package.json    scripts: tsc, test        → @acme/lib#tsc, @acme/lib#test
    api/do.ts           → @acme/api#dev            (do.ts tasks win over same-named scripts)
```

Members don't need a `do.ts` — their scripts are tasks already. The task list shows members compactly:

```txt
$ outdo
tasks in do.ts

  tsc   Type-check every package, dependencies first  (deps: @acme/app#tsc, @acme/lib#tsc)
  lint  Lint the repo  (read-only)

Workspaces
  @acme/app  tsc, test
  @acme/lib  tsc, test
```

## Fan-out

A bare task name runs it **everywhere it's defined** — respecting each member's own dependencies and working directory:

```sh
outdo test              # @acme/app#test + @acme/lib#test, in parallel
outdo @acme/app#test    # exactly one member
outdo --dry=json test   # inspect the fan-out before running it
```

**A root task keeps its name.** When the root has a task of that name, a bare name runs the root task and members' `do.ts` tasks — but not members' `package.json` scripts. So a root `build` that builds your Docker images doesn't suddenly also run every package's `build` script. A root task that wants them depends on them with [`^build`](#dependencies-across-packages).

## Dependencies across packages

Three ways to name a task in another package:

| dep | means |
| --- | --- |
| `"compile"` | in a member: the same package's `compile`; at the root: the root task |
| `"^tsc"` | `tsc` in each of this package's **workspace dependencies** (at the root: in every member) — packages without it are skipped |
| `"@acme/lib#build"` | exactly that package's task |

Workspace dependencies come from member `package.json` `dependencies`/`devDependencies`/`peerDependencies`, narrowed to workspace-internal packages.

## Member defaults: replacing turbo

Declare per-task-name defaults once in the root `do.ts`; outdo merges them into every member's task of that name — `package.json` scripts included:

```ts
export default defineTasks(
	{
		tsc: { desc: "Type-check every package, dependencies first", deps: ["^tsc"], run: "tsc" }, // [!code highlight]
	},
	{
		members: {
			tsc: { deps: ["^tsc"], inputs: ["src/**", "package.json", "tsconfig.json"] }, // [!code highlight]
			test: { deps: ["^test"] },
		},
	},
);
```

```txt
$ outdo tsc
✓ @acme/lib#tsc (1.9s)
✓ @acme/app#tsc (2.4s)
✓ tsc (3.1s)
— 3 ok · 7.5s total · critical path 7.4s (@acme/lib#tsc → @acme/app#tsc → tsc)
```

That's `turbo run tsc && tsc` with a `turbo.json` `dependsOn: ["^tsc"]` — without turbo. With `inputs`, unchanged packages are cache hits.

How defaults merge:

- `deps` are **added** to the member's own. Plain names in defaults are optional (a package may not have them); `^name` and `pkg#name` resolve as usual.
- `inputs`, `outputs`, `watch`, `desc`, `group`, `requires`, `protect`, `confirm` apply only where the member's task doesn't set them.
- `readonly` / `destructive` from defaults switch the flag on.

## Filtering: `-F` / `--filter`

::: code-group

```sh [exact]
outdo -F @acme/api build        # just the api package
```

```sh [glob]
outdo -F '@acme/*' build  # name glob
```

```sh [path]
outdo -F ./packages/api build
```

```sh [...deps]
outdo -F ...@acme/api build     # api + everything api depends on (workspace deps)
```

```sh [dependents...]
outdo -F @acme/lib... build     # lib + everything that depends on lib
```

```sh [combined]
outdo -F @acme/api -F @acme/web build # filters union
```

:::

::: tip
When filters are given, **root tasks are excluded** — filters select packages. A filter matching nothing is a usage error, not a silent no-op. `^` deps into filtered-out packages are dropped.
:::

## Git-aware runs: `--affected`

On a big graph, most CI time goes to packages nothing touched. `--affected` selects only the requested tasks that git says could have changed:

```sh
outdo build --affected                 # vs the merge-base with origin's default branch
outdo test --affected=origin/main      # explicit base rev
outdo build --affected -F '*'          # composes with filters
```

```txt
affected vs origin/main (merge-base 4f2a91c): running 2 of 7 requested task(s)
```

In GitHub Actions the base is the pull request's base branch, or the previous tip for a push — see [CI & Deploys](/guide/ci-cd#what-changed).

A task counts as affected when:

- a changed file matches its `inputs` globs, or its own `do.ts` changed
- it declares **no** `inputs` and anything under its package changed (declaring `inputs` is your opt-in to precision)
- it lives in a package that (transitively) **depends on** a changed package — `packages/ui` changes ripple to every app that consumes it
- one of its task-graph dependencies is affected

The changed set includes committed diffs vs the base, staged/unstaged edits, and untracked files. Kept tasks still run with their full dependency subgraphs — unaffected deps are just fast cache hits. When nothing is affected, outdo prints so and exits `0`.

`--dry=json` adds an `affected: { base, kept, dropped }` block so you can audit the selection without running anything. To ask the question without running anything at all — for a workflow `if:` — use [`outdo affected`](/guide/ci-cd#skipping-jobs-outdo-affected).

## Member-local mode

A member with its **own `do.ts`** is a project of its own when you run outdo inside it — the nearest `do.ts` wins, tasks keep their bare names, and nothing fans out:

```sh
cd packages/api
outdo build     # just api's build
```

Inside a member without a `do.ts`, outdo uses the whole workspace.

The env cascade in workspace mode resolves from the **workspace root** (one `.env` family for the repo). Git hooks are only read from the root `do.ts`.
