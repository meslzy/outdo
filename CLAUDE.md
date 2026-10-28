# outdo

TypeScript-native task runner CLI, **Bun-only** (`engines.bun >= 1.4.0`), ESM. Users author a typed `do.ts`; outdo runs it as a DAG.

**IMPORTANT: zero runtime dependencies.** Never add one — devDependencies only. Use Bun built-ins (`$`, `Bun.spawn`, `Bun.Glob`, `Bun.hash`, `node:util parseArgs`). Never use `node`/`npm`/`npx` — always `bun`/`bunx`.

## Commands

- `bun test` — full suite. Single file: `bun test test/integration/cache.test.ts`
- `bunx tsc --noEmit` — typecheck gate (also enforces the `@ts-expect-error` type tests in `test/types/`)
- `bunx biome check --write .` — lint + format (tabs, 120 cols; don't hand-format)
- `bun scripts/build.ts` — bundle `dist/` + declarations
- `bun src/cli.ts <args>` — run the CLI from source (e.g. from `test/fixtures/basic/`)
- Dogfood: `bun src/cli.ts check` runs typecheck+lint+test via the repo's own `do.ts`

Definition of done: typecheck, `bun test`, and `biome check` all green. Iterate with targeted tests; run the full suite before finishing.

## Architecture (non-obvious parts only)

- `src/cli.ts` — bin entry. Hot path statically imports only `cli/parse`, `core/errors`, `core/logger`; every command is a dynamic import. Keep it that way (startup budget).
- `src/cli/run.ts` — **hybrid backend choice**: pure dependency chains run in-process with inherited stdio; anything parallelizable, persistent, `--watch`, or `--isolate` uses child processes. Both share `makeStart`/`buildCtx` — keep the backends behaviorally identical.
- `outdo __worker` — hidden child-process entry (`src/cli/worker.ts`), driven over IPC by `src/core/child.ts`. Workers re-import the task's `sourceConfig` and run its `localName`. It must exit via `process.exit` (the open IPC channel otherwise keeps it alive). Keep `__worker`/`__complete` out of help and completion output.
- `src/core/lifecycle.ts` — cooperative IPC abort → 5s grace → tree kill (`taskkill /T /F` on Windows, detached+`kill(-pid)` on POSIX). Use clearable `setTimeout`, never `Bun.sleep`, in races — a pending sleep holds the event loop.
- `src/core/envfile.ts` + `envresolve.ts` — dotenv cascade **byte-matched to Bun 1.4** (verified: `$VAR` expands even in single quotes; `\$` always unescapes). Don't "fix" this to dotenv-spec behavior. Provenance (which file set each key) must survive any change.
- `src/core/cache.ts` — fingerprints are computed at task **start time** (via `decideCache`), never upfront: a task's inputs may be its dep's outputs.
- `src/core/scheduler.ts` — services (`persistent`) unblock dependents on spawn and hold no concurrency slot.
- `src/core/usage.ts` — `runCommand` records every run in `.outdo/usage.jsonl` (start + end line). `outdo bg` and MCP children pass their origin as `OUTDO_VIA`; a run sets `OUTDO_NESTED=1` for its tasks. Recording must never throw or slow a run; flag values are kept only for `choices` flags.
- Bun Shell `.lines()` does **not** stream (buffers until exit, oven-sh/bun#8365) — multiplexed output must stay on `Bun.spawn` pipes.

## Conventions

- `~/*` path alias → `src/*` (but `src/index.ts`/`src/types.ts` use relative imports — their emitted declarations must not contain `~`).
- `verbatimModuleSyntax`: use `import type` for types. `noUncheckedIndexedAccess` is on: index access yields `T | undefined`.
- `src/types.ts` is type-only — no runtime imports there. StandardSchemaV1 is inlined; don't add a schema library.
- Errors: throw `OutdoError(code, message, detail)`; exit codes 0/1/2/3/130 map from the code (`src/core/errors.ts`).
- Commit messages: no Co-Authored-By or session trailers.

## Testing

- Integration tests spawn the real CLI (`runCli` in `test/integration/cli.test.ts`) against `test/fixtures/<name>/`.
- Fixtures import `../../../src/index` relatively; tests that **copy** a fixture to a temp dir must rewrite that import to an absolute path (see `cache.test.ts`).
- `bun test` sets `NODE_ENV=test` in spawned CLIs — pass `NODE_ENV: "development"` explicitly when testing the `.env.local` cascade layer.
- Usage-log tests must clear `CI`, `AI_AGENT`, `CLAUDECODE`, `OUTDO_NESTED` (see `PERSON` in `test/integration/usage.test.ts`) — the suite may itself run under an agent or inside an outdo task — and pass `--no-history` or a temp `HISTFILE`/`HOME` so real shell history is never read.
- Timing-sensitive tests poll with deadlines (`waitFor`), never fixed sleeps; watch tests wait for the *second* occurrence of a marker.
