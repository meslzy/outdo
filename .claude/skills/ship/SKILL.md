---
name: ship
description: Ship a bundo change end-to-end — branch, verify, changelog, version bump, commit, PR/merge, and the automated npm release. Use this whenever the user wants to publish, release, or ship their changes, fix a bug and get it out, bump the version, cut a release, merge work into main, or asks "how do I publish this?" — even if they only say something like "I fixed the bug, let's get it live". Also use it to answer questions about bundo's branching strategy or release pipeline.
---

# Shipping a bundo change

bundo uses **trunk-based development with an automated release pipeline**: short-lived branches merge into `main`, and pushing a new `package.json` version to `main` publishes to npm, tags `v<version>`, and creates a GitHub Release — all automatically via `.github/workflows/release.yml`. Your job is to prepare the change so that automation does the rest.

The pipeline, end to end:

```
branch → verify → CHANGELOG + version bump → commit → PR → squash-merge to main
                                                              │
                              release.yml: version not on npm yet?
                                    ├─ no  → skip (docs/CI-only change)
                                    └─ yes → tsc + biome + test + build
                                             → npm publish (OIDC, provenance)
                                             → git tag v<version>
                                             → GitHub Release (notes from CHANGELOG)
```

## 1. Branch

Branch off `main`, named by intent: `fix/<slug>`, `feat/<slug>`, `docs/<slug>`, `chore/<slug>` (e.g. `fix/watch-poll-fallback`). Keep branches short-lived — one change, one branch, deleted after merge (GitHub auto-deletes them). Never rebase/force-push `main` — the ruleset blocks it anyway.

If the user already made their changes directly on `main` locally, that's fine for a solo tiny fix (admin bypass exists), but prefer moving the work to a branch (`git switch -c fix/<slug>`) so CI gates the merge.

## 2. Verify — the definition of done

All three must be green before anything ships (the release workflow re-runs them and will refuse to publish otherwise, so catching failures locally saves a broken release attempt):

```sh
bunx tsc --noEmit
bunx biome check --write .
bun test
```

Or dogfood it in one shot: `bun src/cli.ts check`.

## 3. Decide: does this publish a new version?

- **User-facing change** (behavior, CLI surface, API, bug fix) → bump the version. bundo is 0.x: **breaking change → bump minor** (`0.1.0`), **feature or fix → bump patch** (`0.0.2`).
- **Docs, CI, tests, refactors with no visible change** → do NOT bump. The merge lands on main, release.yml sees the version already on npm, and skips with a warning. That's the designed behavior, not an error.

## 4. Changelog + version bump (only when publishing)

These three edits travel together in the same commit:

1. **`package.json`** — bump `"version"`.
2. **`CHANGELOG.md`** — add a section at the top, directly under the intro. The heading format is load-bearing — the release workflow extracts the section with an exact-match on the second word, so it must be:

   ```markdown
   ## <version> - <YYYY-MM-DD>

   - One bullet per user-facing change, written for users, not committers.
   ```

   (`## 0.0.2 - 2026-08-26`, never `## v0.0.2` or `## [0.0.2](link)`.) This section becomes the GitHub Release notes verbatim — write it like release notes.
3. **`docs/.vitepress/config.ts`** — update the nav version pin (`text: "v<version>"`). Easy to forget; grep for the old version to be sure: `grep -rn "v0\." docs/.vitepress/config.ts`.

If behavior changed, also check the doc mirrors: `README.md`, the relevant `docs/` pages, and the `HELP` text in `src/cli.ts` (which `docs/reference/cli.md` mirrors — update both together).

## 5. Commit

Plain imperative messages, scoped like the existing history (`fix: watch poll fallback on NFS`, `feat: retry backoff jitter`). **No Co-Authored-By or session trailers** — repo rule. The version bump + changelog + code can be one commit for small changes, or code commits followed by a final `release: 0.0.2` commit for larger ones.

## 6. PR and merge

```sh
git push -u origin fix/<slug>
gh pr create --fill
```

The PR template checklist mirrors steps 2–4 — fill it honestly. CI runs the 6-job matrix (3 OS × 2 Bun versions); the `protect-main` ruleset requires all of them. **Squash-merge** (repo convention — one commit per change on main):

```sh
gh pr merge --squash --delete-branch
```

## 7. After the merge — trust but verify

Nothing manual remains; watch the automation land:

```sh
gh run watch --repo meslzy/bundo          # release workflow
gh release view v<version>                 # tag + notes exist
curl -s https://registry.npmjs.org/bundo/<version> | head -c 200   # it's on npm
```

If the publish step failed with an OIDC/auth error, the trusted publisher config on npmjs.com is the suspect (package Settings → Trusted Publisher: owner `meslzy`, repo `bundo`, workflow `release.yml`) — that's account state, only the user can fix it.

## Gotchas worth knowing

- **release.yml's path filter** (`src/**`, `scripts/**`, `package.json`, the workflow itself) — a version bump always touches `package.json`, so a publish-intent merge always triggers it.
- **Same version, second merge**: publishing is idempotent — already-on-npm versions skip cleanly, and an already-existing GitHub Release is skipped too. Re-running the workflow is always safe.
- **Never `npm publish` locally** after the trusted publisher is set up — let the workflow do it so releases carry provenance and always have a tag + Release.
- **Zero runtime dependencies** is a hard repo rule — a change that adds one to `dependencies` must not ship; devDependencies are fine.
