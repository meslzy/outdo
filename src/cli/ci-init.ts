/** `outdo ci init` — write a GitHub Actions workflow that runs `outdo ci <task>`. */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadProjectFromCwd } from "~/cli/load";
import type { GlobalFlags } from "~/cli/parse";
import { EXIT, OutdoError } from "~/core/errors";
import { dim, green } from "~/core/logger";

/** The task CI should run: the usual "everything must pass" names, first match wins. */
const PREFERRED = [
	"check",
	"ci",
	"gate",
	"verify",
	"test",
	"build",
];

async function defaultBranch(cwd: string): Promise<string> {
	try {
		const proc = Bun.spawn(
			[
				"git",
				"symbolic-ref",
				"--quiet",
				"--short",
				"refs/remotes/origin/HEAD",
			],
			{
				cwd,
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const out = (await new Response(proc.stdout).text()).trim();
		if ((await proc.exited) === 0 && out.startsWith("origin/")) {
			return out.slice("origin/".length);
		}
	} catch {
		// no git — fall through
	}
	return "main";
}

export function workflowYaml(task: string, branch: string): string {
	return `name: CI

on:
  push:
    branches: [${branch}]
  pull_request:

jobs:
  ${task.replaceAll(/[^A-Za-z0-9_-]/g, "-")}:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # outdo compares against the PR base / previous push
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx outdo ci ${task}
`;
}

export async function ciInitCommand(flags: GlobalFlags): Promise<number> {
	const project = await loadProjectFromCwd(flags.filter);
	const target = join(project.rootDir, ".github", "workflows", "ci.yml");
	if (existsSync(target) && !flags.force) {
		throw new OutdoError("usage", `${target} already exists — re-run with --force to overwrite.`);
	}
	const task = PREFERRED.find((name) => project.tasks.has(name)) ?? "check";
	mkdirSync(join(project.rootDir, ".github", "workflows"), {
		recursive: true,
	});
	await Bun.write(target, workflowYaml(task, await defaultBranch(project.rootDir)));
	console.log(`${green("✓")} wrote .github/workflows/ci.yml ${dim(`(runs "outdo ci ${task}")`)}`);
	if (!project.tasks.has(task)) {
		console.log(dim(`  no "${task}" task yet — add one to do.ts, or edit the workflow.`));
	}
	return EXIT.ok;
}
