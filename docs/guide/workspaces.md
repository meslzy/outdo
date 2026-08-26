# Workspaces

At a [Bun workspace](https://bun.com/docs/install/workspaces) root, outdo merges the root `do.ts` with every member package's `do.ts`. Member tasks are namespaced **`pkg#task`**:

```txt
my-monorepo/
  package.json          { "workspaces": ["packages/*"] }
  do.ts                 → build, fmt:check
  packages/
    api/do.ts           → api#build, api#dev
    lib/do.ts           → lib#build
    web/do.ts           → web#build
```

## Fan-out

A bare task name runs it **everywhere it's defined** — root and members — respecting each member's own dependencies and working directory:

```sh
outdo build           # root build + api#build + lib#build + web#build, in parallel
outdo api#build       # exactly one member
outdo --dry=json build  # inspect the fan-out before running it
```

Member `deps` stay **file-local**: `api#build` depending on `["compile"]` means `api#compile`, never another package's task. Cross-package ordering comes from `--filter`'s dependency closures (below), not task deps.

## Filtering: `-F` / `--filter`

::: code-group

```sh [exact]
outdo -F api build        # just the api package
```

```sh [glob]
outdo -F '@acme/*' build  # name glob
```

```sh [path]
outdo -F ./packages/api build
```

```sh [...deps]
outdo -F ...api build     # api + everything api depends on (workspace deps)
```

```sh [dependents...]
outdo -F lib... build     # lib + everything that depends on lib
```

```sh [combined]
outdo -F api -F web build # filters union
```

:::

Dependency relations come from member `package.json` `dependencies`/`devDependencies`/`peerDependencies` narrowed to workspace-internal packages.

::: tip
When filters are given, **root tasks are excluded** — filters select packages. A filter matching nothing is a usage error, not a silent no-op.
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

A task counts as affected when:

- a changed file matches its `inputs` globs, or its own `do.ts` changed
- it declares **no** `inputs` and anything under its package changed (declaring `inputs` is your opt-in to precision)
- it lives in a package that (transitively) **depends on** a changed package — `packages/ui` changes ripple to every app that consumes it
- one of its task-graph dependencies is affected

The changed set includes committed diffs vs the base, staged/unstaged edits, and untracked files. Kept tasks still run with their full dependency subgraphs — unaffected deps are just fast cache hits. When nothing is affected, outdo prints so and exits `0`.

`--dry=json` adds an `affected: { base, kept, dropped }` block so you can audit the selection without running anything.

## Member-local mode

Run outdo from **inside** a member directory and it stays local — the nearest `do.ts` wins, tasks keep their bare names, and nothing fans out:

```sh
cd packages/api
outdo build     # just api's build
```

The env cascade in workspace mode resolves from the **workspace root** (one `.env` family for the repo).
