/**
 * Shared integration-test helpers. Lives OUTSIDE any *.test.ts file on
 * purpose: importing a test file re-registers its describe blocks in the
 * importer, which duplicates tests and races snapshots under `bun test
 * --parallel`.
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

export const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

const INDEX = join(import.meta.dir, "..", "..", "src", "index.ts").replaceAll("\\", "/");

/**
 * Copy a fixture into a fresh temp dir and rewrite every do.ts relative
 * `src/index` import (any depth — workspace members too) to an absolute path.
 */
export function copyFixture(fixtureName: string): string {
	const fixture = join(import.meta.dir, "..", "fixtures", fixtureName);
	const dir = mkdtempSync(join(tmpdir(), `outdo-${fixtureName.replaceAll(/[^a-z0-9]/gi, "-")}-`));
	cpSync(fixture, dir, {
		recursive: true,
	});
	for (const rel of [
		...new Glob("**/do.ts").scanSync({
			cwd: dir,
		}),
	]) {
		const file = join(dir, rel);
		writeFileSync(file, readFileSync(file, "utf8").replace(/(["'])(?:\.\.\/)+src\/index\1/, `"${INDEX}"`));
	}
	return dir;
}

/**
 * Turn a directory into a one-commit git repo. Returns false when git is
 * unavailable (suites skip via describe.skipIf).
 */
export async function initGit(dir: string): Promise<boolean> {
	const git = async (...args: string[]): Promise<boolean> => {
		try {
			const proc = Bun.spawn(
				[
					"git",
					...args,
				],
				{
					cwd: dir,
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			return (await proc.exited) === 0;
		} catch {
			return false;
		}
	};
	if (!(await git("init", "-q"))) {
		return false;
	}
	await git("config", "user.email", "tests@outdo.local");
	await git("config", "user.name", "outdo tests");
	await git("config", "commit.gpgsign", "false");
	writeFileSync(join(dir, ".gitignore"), ".outdo/\nout/\n");
	if (!(await git("add", "-A"))) {
		return false;
	}
	return await git("commit", "-q", "-m", "init");
}

/** Whether the git CLI is available at all (for describe.skipIf). */
export async function gitAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(
			[
				"git",
				"--version",
			],
			{
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

export interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export async function runCli(cwd: string, args: string[], env?: Record<string, string>): Promise<CliResult> {
	const proc = Bun.spawn(
		[
			process.execPath,
			CLI,
			"--color=never",
			...args,
		],
		{
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
				...env,
			},
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		exitCode,
		stdout,
		stderr,
	};
}
