<!-- One or two sentences: what does this change and why? -->

## Checklist

- [ ] `bun test` passes
- [ ] `bunx tsc --noEmit` is clean
- [ ] `bunx biome check .` is clean
- [ ] Docs updated if behavior changed (`README.md`, `docs/`, and the `HELP` text in `src/cli.ts` mirror each other)
- [ ] `CHANGELOG.md` gets an entry if the change is user-facing
- [ ] No runtime dependencies added (Bun built-ins only — this is a hard rule)
- [ ] Sequential and child-process backends stay behaviorally identical (if the change touches execution)
