# Workspaces

At a [Bun workspace](https://bun.com/docs/install/workspaces) root, bundo merges the root `do.ts` with every member package's `do.ts`. Member tasks are namespaced **`pkg#task`**:

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
bundo build           # root build + api#build + lib#build + web#build, in parallel
bundo api#build       # exactly one member
bundo --dry=json build  # inspect the fan-out before running it
```

Member `deps` stay **file-local**: `api#build` depending on `["compile"]` means `api#compile`, never another package's task. Cross-package ordering comes from `--filter`'s dependency closures (below), not task deps.

## Filtering: `-F` / `--filter`

::: code-group

```sh [exact]
bundo -F api build        # just the api package
```

```sh [glob]
bundo -F '@acme/*' build  # name glob
```

```sh [path]
bundo -F ./packages/api build
```

```sh [...deps]
bundo -F ...api build     # api + everything api depends on (workspace deps)
```

```sh [dependents...]
bundo -F lib... build     # lib + everything that depends on lib
```

```sh [combined]
bundo -F api -F web build # filters union
```

:::

Dependency relations come from member `package.json` `dependencies`/`devDependencies` narrowed to workspace-internal packages.

::: tip
When filters are given, **root tasks are excluded** — filters select packages. A filter matching nothing is a usage error, not a silent no-op.
:::

## Member-local mode

Run bundo from **inside** a member directory and it stays local — the nearest `do.ts` wins, tasks keep their bare names, and nothing fans out:

```sh
cd packages/api
bundo build     # just api's build
```

The env cascade in workspace mode resolves from the **workspace root** (one `.env` family for the repo).
