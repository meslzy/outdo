# Usage & Cleanup

`do.ts` files grow. outdo keeps a local record of what you actually run, so `outdo usage` can tell you which tasks earn their place, which ones nothing uses any more, which flags nobody passes, and which tasks are the same thing twice.

## What gets recorded

Every run appends a line to `.outdo/usage.jsonl` (git-ignored with the rest of `.outdo/`) when it starts, and another when it ends:

- the tasks you asked for, and everything that ran with them (deps, steps)
- the flags given to the task — names only, plus the value for flags with fixed [`choices`](/guide/args-and-flags) (`--source eco`); free-form values such as ids, paths or messages never reach the log
- the [mode](/guide/env#modes)
- where the run came from: `cli`, the picker (`-i`), `watch`, [`bg`](/guide/watch-and-services#background-runs-outdo-bg), `ci`, a [git hook](/guide/ci-cd#git-hooks), [MCP](/reference/ai-agents#mcp-server), or `nested` (an outdo run started by one of your tasks)
- whether a person or an agent ran it (`AI_AGENT`, `CLAUDECODE`, Codex, Cursor and Gemini CLI markers; MCP calls count as an agent)
- how it ended: time per task, failures, cache hits

`.outdo/usage-seen.json` remembers when each task, flag and mode first appeared, so a task you added yesterday isn't reported as unused.

Nothing is recorded under `--dry`, in CI (`CI` set), or with `OUTDO_NO_USAGE=1`. Nothing leaves your machine.

## `outdo usage`

```txt
$ outdo usage
212 runs recorded since Oct 3 · shell history: 94 calls since Aug 23 (any directory)

most used
              you  agent  as dep  shell     last     avg  fails
  gate          9    131       -      2   1h ago  2m 14s     12
  look-shoot    -     58       -      -   3h ago    9.1s      -
  dev          21      -       -      3    today  service     -
  db-reset      4      -       -      1   2d ago    8.0s      -
  … 14 more ran only as dependencies (outdo usage --all)

unused — 3 tasks: never run, not in shell history, and nothing that runs uses them
  observe-sync    dev
  db-backups      db    only used by db-restore (unused too)
  db-restore      db

never run here, but something uses them
  deploy          ← .github/workflows/deploy.yml
  test-stack      ← check

flags never passed — tasks asked for 3+ times
  look-shoot  --marks --measure  (58 runs)

choices never picked
  ai-bench --only  qwen, llama  (6 runs)

modes  dev 205 · prod 7
hooks  pre-commit 64

duplicates — 2
  package.json "test" (turbo run test --concurrency=4) never runs through outdo: do.ts "test" replaces it
  "fix" only runs "format" (bun run format): keep one
```

- **most used**: asked for by **you**, by an **agent**, pulled in **as a dep** (or by a nested run), typed in your **shell** history; when it last ran, its average time (`service` for persistent tasks), and how often it failed. Hook runs count toward a task too.
- **unused**: no recorded run, never typed, and nothing that runs points at it. "only used by …" names what still references it — when those are unused too, they go together.
- **never run here, but something uses them**: a CI workflow, a git hook, a `package.json` script, a Dockerfile or another used task names it. Not dead, just not run on this machine.
- **flags never passed** / **choices never picked**: only for tasks asked for at least 3 times since the flag was added. A flag that always takes its default could be a constant; a choice nobody picks could go.
- **duplicates** are found statically, so they are safe to act on right away (see [below](#duplicates)).

`outdo usage <task>` shows one task: who runs it and how, when it last ran, each flag with how often it was given and with which values, what uses it, and the duplicates it is part of.

```txt
$ outdo usage feed
feed — Pull the feed for one source
  asked for you 3 · agent 11 · hooks 0 · shell history 2 · as a dependency 0
  runs      last 2h ago · avg 4.2s
  status    used
  tracked   since Oct 3

  flags
    --source  14×  eco 12 · all 2  never: none   14 runs since added
    --dry     never passed                       14 runs since added
```

| flag | meaning |
| --- | --- |
| `--since <span>` | only usage since `30d`, `2w`, `12h` or a date (`2026-10-01`) |
| `--all` | every task, used or not, ranked |
| `--no-history` | leave shell history out |
| `--json` | the whole report (or one task) as JSON — for scripts and agents |

When tracking is younger than two weeks, the report says so: give it time before deleting a task for being unused. Duplicates don't need to wait.

## Where the evidence comes from

- **The usage log** — every run outdo makes, whatever started it. This is the only source that sees what your agents run.
- **Shell history** — zsh (`~/.zsh_history` or `$HISTFILE`), bash, fish and PowerShell. It covers the time before outdo recorded anything. Shell history has no working directory, so `outdo dev` typed in another repo counts here too; that is why history only ever keeps a task *off* the unused list, never puts one on it. It is read on each `outdo usage` call and never stored.
- **Files that call outdo** — `.github/workflows/*`, `package.json` scripts, `Dockerfile`s and compose files (exec-form `CMD ["bun", "run", "start"]` included), `Makefile`/`justfile`, `.githooks/*`, `.husky/*`, `*.sh` and `scripts/**/*.sh`, and your tasks' own code. `outdo x`, `bunx outdo x`, `bun run x`, `turbo run x` and `bun --filter pkg x` all count.

Workspace scripts are listed separately ("workspace scripts that never ran through outdo"): a container or a runner outdo doesn't see may still start them, so check before deleting one.

## Duplicates

| finding | fix |
| --- | --- |
| `package.json "x" never runs through outdo: do.ts "x" replaces it` | the do.ts task has its own `run`, so outdo never runs the script. Delete the script, or drop the task's `run` so the entry [runs the script](/guide/tasks-and-deps#package-json-scripts-are-tasks) |
| `"x" runs "bun run x": drop its run` | a do.ts entry without `run` already runs the same-named script — keep the entry for its deps, flags or `desc`, drop the `run` |
| `"x" only runs "y"` | an alias (`bun run y`, `outdo y`) — keep one name |
| `"a", "b" run the same command` | same command in the same package (`bunx tsc` and `tsc` count as the same) |
| `"a", "b" do the same thing` | same steps, or the same deps, and no body of their own |
| `package.json "x" only calls "outdo x"` | outdo runs do.ts tasks itself — keep the script only if something runs `bun run x` |

## Cleaning up with an agent

The report is built for this. Ask your agent to run `outdo usage --json`, propose removals, and wait for your yes:

```txt
> clean up do.ts: remove what outdo usage says is unused or duplicated, ask me first
```

The [outdo skill](/reference/ai-agents#the-outdo-skill) tells agents to treat "unused" as a proposal — tracking age, workspace scripts and external callers are in the JSON (`trackedSince`, `status`, `usedBy`) — and to act on duplicates first.
