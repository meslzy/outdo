# Why outdo? (and why not)

Every tool below is good at what it was built for. This page is the honest version of the comparison — including what outdo **can't** do — so you can decide in five minutes whether it fits. Claims verified against each tool's official docs, August 2026.

## The matrix

| | Make | just | Task | mise | wireit | Turbo | Nx | `bun run` | **outdo** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Config | Makefile DSL | justfile DSL | YAML | TOML | package.json | turbo.json | nx.json | package.json | **typed TS** |
| Editor typing | — | 3rd-party LSP | JSON Schema | JSON Schema | JSON Schema | JSON Schema | JSON Schema + LSP | — | **full TypeScript** |
| Task DAG + parallel | ✓ `-j` | ✓ | ✓ | ✓ | ✓ | ✓ `^build` | ✓ `^build` | pre/post only | ✓ |
| Dep typo caught | at run | at invocation | at run (fuzzy hint) | at run | editor diagnostics | silent no-op | at run | "not found" | **compile time + did-you-mean** |
| `.env` loading | — | ✓ | ✓ | ✓ | — | explicitly no | ✓ | ✓ | ✓ Bun-matched cascade |
| Env **validation** | — | presence (`env()`) | presence (`requires`) | presence | — | filter-only | — | — | **schema (zod/valibot/arktype), pre-flight** |
| Env provenance | — | — | — | ✓ (`env --json-extended`) | — | — | — | — | ✓ `--print-env` |
| Per-task CLI flags | — | params (untyped) | raw `CLI_ARGS` | ✓ usage spec | — | — | executor schemas | — | **TS-inferred + auto help** |
| Caching | mtime | content-hash skip (unstable) | checksum skip | mtime + experimental artifacts | **artifact restore** | **artifact restore + log replay** | **artifact restore + log replay** | — | checksum **skip only** |
| Remote cache | — | — | — | experimental | GH Actions only | **✓ free tier** | Nx Cloud | — | **✗** |
| Watch mode | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ with service restarts |
| Service readiness | — | — | — | — | **✓ `readyWhen`** | persistent, not dependable | no readiness | — | **✓ log / port / http probes** |
| Git-affected runs | — | — | — | — | — | ✓ `--filter=[ref]` | ✓ `nx affected` | — | ✓ `--affected` |
| Cache explainability | — | — | — | — | — | `--summarize` | ✓ Nx Cloud UI | — | **✓ `explain` — per-component diff, local** |
| Run report / trace | — | — | — | — | — | `--summarize` JSON | ✓ | — | **✓ `--json` report + Chrome trace** |
| Runtime needed | none (C) | none (Rust) | none (Go) | none (Rust) | Node | Node/npm | Node | Bun | **Bun ≥ 1.4 only** |
| Since / backing | 1988, FSF | 2016, community | ~2017, community | Rust, community | 2022, Google repo | 2021, Vercel | 2017, Nx Ltd | Oven | **2026, one maintainer** |

## Where outdo genuinely wins

- **Errors move left.** A dependency typo is a *compile error in your editor* with a fix suggestion — every other tool tells you at invocation or later. Env problems fail in one line *before* any task runs, not mid-deploy.
- **Types are the config.** Autocomplete, refactoring, go-to-definition on your task graph; `ctx.env` and `ctx.args` are real inferred types, not strings you cast.
- **Typed per-task flags.** mise and Nx have declared flags too — outdo's are TypeScript-inferred end-to-end with generated `--help` and completions.
- **Services you can depend on.** `deps: ["dev"]` on a persistent task works; Turborepo's persistent tasks can't be depended on at all.
- **Nothing to install but outdo.** Zero runtime dependencies, one 74KB package, and your task file is just TypeScript running on the runtime you already use.

## What outdo can't do (yet or by design)

::: warning Read this before adopting
- **No remote cache.** Turborepo and Nx share build artifacts across CI machines; outdo's cache is per-machine.
- **Skip, not restore.** A cache hit means "don't re-run" — outdo never re-materializes a deleted `dist/` from an archive the way Turbo/Nx/wireit can. Delete outputs → full re-run.
- **No content-addressable storage, no distributed execution** (Nx Agents territory).
- **Bun ≥ 1.4 or nothing.** No Node, no Deno. Make/just/Task/mise are single binaries that run anywhere.
- **Config is code.** `do.ts` is arbitrary TypeScript executed on load — maximum power, but external tools can't statically analyze your graph the way they can a YAML/JSON file.
- **Young.** First released 2026, single maintainer, no plugin ecosystem. The tools above have years of production mileage.
:::

## Choose something else when…

- **Turborepo** — you need a real remote cache that restores artifacts and replays logs across CI machines (free tier works outside Vercel).
- **Nx** — a large enterprise monorepo wanting plugins, code generators, and distributed task execution.
- **just / Make** — you need a runtime-independent binary (polyglot repos, machines without JS runtimes). `just` also catches unknown recipes before running.
- **mise** — you want task running *plus* tool-version management in one Rust binary, without adopting Bun.
- **wireit** — you're committed to Node and need an artifact-restoring cache.
- **plain `bun run`** — a handful of scripts with no dependency graph; `--filter` already runs package scripts in parallel.

## Choose outdo when…

You're on Bun, your task graph deserves the same type safety as the rest of your code, your environment deserves validation before execution, and you want one fast tool — not a build platform — doing it. That's the entire pitch.
