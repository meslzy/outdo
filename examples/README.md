# bundo examples

- `single-repo/do.ts` — a full-featured single-project task file: docker infra,
  env-validated backup/release tasks, typed CLI flags, cached builds, a
  persistent dev server, and `--` passthrough to tests.
- `monorepo/` — a Bun workspace: root `do.ts` + per-package `do.ts` files.
  From `monorepo/`, `bundo build` fans out to `api#build` and `web#build`;
  `bundo -F ...api build` builds api plus what it depends on.

These reference `import { ... } from "bundo"` — inside this repository they are
documentation only (not typechecked against the local source).
