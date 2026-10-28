/**
 * Git hook files for hooks declared in do.ts. Each installed hook is a tiny
 * sh script that calls `outdo hooks run <name>` (local install first, then a
 * global outdo, then bunx). A hook file outdo did not write is backed up to
 * `<hook>.pre-outdo` and restored on uninstall.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { OutdoError } from "~/core/errors";

export const HOOK_MARKER = "# installed by outdo";

async function git(
	args: string[],
	cwd: string,
): Promise<{
	ok: boolean;
	out: string;
}> {
	try {
		const proc = Bun.spawn(
			[
				"git",
				...args,
			],
			{
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, , code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return {
			ok: code === 0,
			out: out.trim(),
		};
	} catch {
		return {
			ok: false,
			out: "",
		};
	}
}

/** Absolute hooks directory git uses for this repo (honours core.hooksPath). */
export async function hooksDir(cwd: string): Promise<string> {
	const result = await git(
		[
			"rev-parse",
			"--git-path",
			"hooks",
		],
		cwd,
	);
	if (!result.ok) {
		throw new OutdoError("git", "git hooks need a git repository (git rev-parse failed).");
	}
	return isAbsolute(result.out) ? result.out : join(cwd, result.out);
}

export async function customHooksPath(cwd: string): Promise<string | undefined> {
	const result = await git(
		[
			"config",
			"--get",
			"core.hooksPath",
		],
		cwd,
	);
	return result.ok && result.out !== "" ? result.out : undefined;
}

export function hookScript(hook: string): string {
	return `#!/bin/sh
${HOOK_MARKER} — edit hooks in do.ts, then run "outdo hooks install"
if [ -x node_modules/.bin/outdo ]; then exec node_modules/.bin/outdo hooks run ${hook} -- "$@"; fi
if command -v outdo >/dev/null 2>&1; then exec outdo hooks run ${hook} -- "$@"; fi
exec bunx outdo hooks run ${hook} -- "$@"
`;
}

function isOurs(path: string): boolean {
	try {
		return readFileSync(path, "utf8").includes(HOOK_MARKER);
	} catch {
		return false;
	}
}

export interface InstallResult {
	installed: string[];
	backedUp: string[];
	/** core.hooksPath that was unset so git uses the outdo hooks. */
	unsetHooksPath: string | undefined;
}

export async function installHooks(cwd: string, hooks: readonly string[]): Promise<InstallResult> {
	// A custom hooksPath (e.g. `.githooks` set by a prepare script) would keep
	// git from ever seeing hooks in .git/hooks — take over from it.
	const custom = await customHooksPath(cwd);
	if (custom !== undefined) {
		await git(
			[
				"config",
				"--unset",
				"core.hooksPath",
			],
			cwd,
		);
	}
	const dir = await hooksDir(cwd);
	mkdirSync(dir, {
		recursive: true,
	});
	const backedUp: string[] = [];
	for (const hook of hooks) {
		const path = join(dir, hook);
		if (existsSync(path) && !isOurs(path)) {
			renameSync(path, `${path}.pre-outdo`);
			backedUp.push(hook);
		}
		writeFileSync(path, hookScript(hook));
		try {
			chmodSync(path, 0o755);
		} catch {
			// Windows: git for Windows runs hooks through sh regardless
		}
	}
	return {
		installed: [
			...hooks,
		],
		backedUp,
		unsetHooksPath: custom,
	};
}

export async function uninstallHooks(cwd: string): Promise<string[]> {
	const dir = await hooksDir(cwd);
	const removed: string[] = [];
	const { readdirSync } = await import("node:fs");
	for (const name of existsSync(dir) ? readdirSync(dir) : []) {
		const path = join(dir, name);
		if (name.endsWith(".pre-outdo") || !isOurs(path)) {
			continue;
		}
		rmSync(path);
		removed.push(name);
		if (existsSync(`${path}.pre-outdo`)) {
			renameSync(`${path}.pre-outdo`, path);
		}
	}
	return removed;
}

/** Which declared hooks are currently installed (outdo-written files). */
export async function installedHooks(cwd: string, hooks: readonly string[]): Promise<Map<string, boolean>> {
	const out = new Map<string, boolean>();
	let dir: string | undefined;
	try {
		dir = await hooksDir(cwd);
	} catch {
		dir = undefined;
	}
	for (const hook of hooks) {
		out.set(hook, dir !== undefined && isOurs(join(dir, hook)));
	}
	return out;
}

/** Files staged with no further unstaged edits — safe to re-add after a formatter. */
export async function fullyStagedFiles(cwd: string): Promise<string[]> {
	const staged = await git(
		[
			"-c",
			"core.quotepath=false",
			"diff",
			"--cached",
			"--name-only",
			"--diff-filter=ACMR",
		],
		cwd,
	);
	const unstaged = await git(
		[
			"-c",
			"core.quotepath=false",
			"diff",
			"--name-only",
		],
		cwd,
	);
	const dirty = new Set(unstaged.out.split("\n").filter((l) => l !== ""));
	return staged.out.split("\n").filter((l) => l !== "" && !dirty.has(l));
}

/** Re-stage the fully staged files a hook modified. Returns the files re-added. */
export async function restage(cwd: string, fullyStaged: readonly string[]): Promise<string[]> {
	if (fullyStaged.length === 0) {
		return [];
	}
	const unstaged = await git(
		[
			"-c",
			"core.quotepath=false",
			"diff",
			"--name-only",
		],
		cwd,
	);
	const changed = new Set(unstaged.out.split("\n").filter((l) => l !== ""));
	const files = fullyStaged.filter((file) => changed.has(file));
	if (files.length > 0) {
		const top = await git(
			[
				"rev-parse",
				"--show-toplevel",
			],
			cwd,
		);
		await git(
			[
				"add",
				"--",
				...files,
			],
			top.ok ? top.out : cwd,
		);
	}
	return files;
}
