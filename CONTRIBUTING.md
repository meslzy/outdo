# Contributing to outdo

Thanks for helping! outdo is small on purpose — a focused, zero-dependency task runner for Bun.

## Setup

Bun >= 1.4.0 is the only prerequisite.

```sh
bun install
```

## Commands

```sh
bun test                 # full suite (integration tests spawn the real CLI)
bun test test/integration/cache.test.ts   # one file
bunx tsc --noEmit        # typecheck (also gates the type tests in test/types/)
bunx biome check --write .   # lint + format (tabs, 120 cols — don't hand-format)
bun scripts/build.ts     # bundle dist/ + declarations
bun src/cli.ts <args>    # run the CLI from source
bun src/cli.ts check     # dogfood: typecheck + lint + test via the repo's own do.ts
```

Definition of done: `bunx tsc --noEmit`, `bun test`, and `bunx biome check .` all green.

## The two hard rules

1. **Zero runtime dependencies.** `devDependencies` only. Use Bun built-ins (`$`, `Bun.spawn`, `Bun.Glob`, `Bun.hash`, `node:util parseArgs`). Never `node`/`npm`/`npx` — always `bun`/`bunx`.
2. **The two execution backends stay behaviorally identical.** Pure chains run in-process; everything else runs in child processes. A feature that works in one must work the same in the other (see `makeStart`/`runSequential` in `src/cli/run.ts`).

## Testing conventions

- Integration tests spawn the real CLI (`runCli` in `test/integration/helpers.ts`) against `test/fixtures/<name>/`.
- Tests that mutate files copy their fixture to a temp dir with `copyFixture()` (it rewrites the fixture's relative `src/index` import).
- Timing-sensitive tests poll with deadlines (`waitFor`), never fixed sleeps.
- Type-level behavior is asserted in `test/types/` with `@ts-expect-error`, enforced by `tsc --noEmit`.

## Docs

`docs/reference/cli.md` mirrors the `HELP` text in `src/cli.ts` — update both together. Behavior changes need matching updates in `README.md` and `docs/`, plus a `CHANGELOG.md` entry (the release workflow turns the version's section into the GitHub Release notes).

## Commit messages

Plain, imperative, no trailers.
