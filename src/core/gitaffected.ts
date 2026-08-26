/**
 * Git-aware task selection (--affected): map `git diff` against a base rev to
 * the set of requested tasks whose inputs, package, or (transitive)
 * dependencies changed. Propagation runs through both the workspace package
 * graph (dependents of changed packages) and the task dependency graph.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { OutdoError } from "~/core/errors";
import { compile, matches } from "~/core/globs";
import { dependents } from "~/core/graph";
import type { Project, Task } from "~/core/model";

/**
 * Canonicalize a path for comparison: resolves Windows 8.3 short names
 * (tmpdir often yields ADMINI~1-style paths while git reports long names)
 * and symlinks. Falls back to the input for paths that don't exist.
 */
function canon(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

export interface ChangedResult {
	/** Resolved base rev description, or "(none)" when everything is affected. */
	base: string;
	/** Changed files, absolute with forward slashes. */
	files: Set<string>;
	/** No usable base (e.g. initial commit) — treat every task as affected. */
	everything: boolean;
}

interface GitOutput {
	ok: boolean;
	stdout: string;
	stderr: string;
}

async function git(args: string[], cwd: string): Promise<GitOutput> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(
			[
				"git",
				// Default core.quotepath C-quotes non-ASCII paths, which would make
				// those files invisible to the change matching below.
				"-c",
				"core.quotepath=false",
				...args,
			],
			{
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	} catch {
		throw new OutdoError("git", "--affected requires the git CLI, which was not found on PATH.");
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
		proc.exited,
	]);
	return {
		ok: code === 0,
		stdout: stdout.trim(),
		stderr: stderr.trim(),
	};
}

async function revExists(rev: string, cwd: string): Promise<boolean> {
	const out = await git(
		[
			"rev-parse",
			"--verify",
			"--quiet",
			`${rev}^{commit}`,
		],
		cwd,
	);
	return out.ok;
}

/** Detect the changed-file set vs a base rev (plus working tree + untracked). */
export async function detectChanged(rootDir: string, baseArg: string | undefined): Promise<ChangedResult> {
	const top = await git(
		[
			"rev-parse",
			"--show-toplevel",
		],
		rootDir,
	);
	if (!top.ok) {
		throw new OutdoError("git", `--affected requires a git repository (${top.stderr || "not a git repository"}).`);
	}
	const gitRoot = canon(top.stdout);

	let base: string | undefined;
	let diffArgs: string[] | undefined;
	if (baseArg !== undefined && baseArg !== "") {
		if (!(await revExists(baseArg, rootDir))) {
			throw new OutdoError("git", `--affected: unknown revision "${baseArg}".`);
		}
		base = baseArg;
		diffArgs = [
			"diff",
			"--name-only",
			`${baseArg}...HEAD`,
		];
	} else {
		// origin's default branch -> origin/main -> origin/master -> HEAD~1.
		const sym = await git(
			[
				"symbolic-ref",
				"--quiet",
				"refs/remotes/origin/HEAD",
			],
			rootDir,
		);
		const candidates = sym.ok
			? [
					sym.stdout.replace("refs/remotes/", ""),
				]
			: [
					"origin/main",
					"origin/master",
				];
		for (const candidate of candidates) {
			if (await revExists(candidate, rootDir)) {
				const mergeBase = await git(
					[
						"merge-base",
						candidate,
						"HEAD",
					],
					rootDir,
				);
				if (mergeBase.ok) {
					base = `${candidate} (merge-base ${mergeBase.stdout.slice(0, 12)})`;
					diffArgs = [
						"diff",
						"--name-only",
						mergeBase.stdout,
						"HEAD",
					];
					break;
				}
			}
		}
		if (diffArgs === undefined && (await revExists("HEAD~1", rootDir))) {
			base = "HEAD~1";
			diffArgs = [
				"diff",
				"--name-only",
				"HEAD~1",
				"HEAD",
			];
		}
		if (diffArgs === undefined) {
			return {
				base: "(none)",
				files: new Set(),
				everything: true,
			};
		}
	}

	const files = new Set<string>();
	// A failing git command must be a loud error, never an empty change set —
	// silently "nothing affected" on a shallow CI clone would skip real work.
	const collect = (out: GitOutput, what: string): void => {
		if (!out.ok) {
			throw new OutdoError("git", `--affected: ${what} failed (${out.stderr || "no error output"}).`);
		}
		for (const line of out.stdout.split("\n")) {
			if (line !== "") {
				files.add(resolve(gitRoot, line).replaceAll("\\", "/"));
			}
		}
	};
	collect(await git(diffArgs, rootDir), `git ${diffArgs.join(" ")}`);
	// Working tree (staged + unstaged) and untracked files also count.
	collect(
		await git(
			[
				"diff",
				"--name-only",
				"HEAD",
			],
			rootDir,
		),
		"git diff --name-only HEAD",
	);
	collect(
		await git(
			[
				"ls-files",
				"--others",
				"--exclude-standard",
				// ls-files output is cwd-relative by default; --full-name makes it
				// toplevel-relative like `diff --name-only`, so resolving against
				// gitRoot is correct even when outdo runs in a subdirectory.
				"--full-name",
			],
			rootDir,
		),
		"git ls-files --others",
	);

	return {
		base: base as string,
		files,
		everything: false,
	};
}

function underDir(file: string, dir: string): boolean {
	const rel = relative(dir, file);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Select which requested tasks are affected. Directly affected:
 *  - a changed file matches the task's `inputs` globs (relative to its cwd), or
 *  - the task's own do.ts changed, or
 *  - the task declares no inputs and anything under its package dir changed
 *    (declaring inputs is the opt-in to precision).
 * Propagated: workspace dependents of changed packages, and task-graph
 * dependents of affected tasks.
 */
export function selectAffected(
	project: Project,
	requested: readonly Task[],
	changed: ChangedResult,
): {
	kept: Task[];
	dropped: Task[];
} {
	if (changed.everything) {
		return {
			kept: [
				...requested,
			],
			dropped: [],
		};
	}
	const files = [
		...changed.files,
	];

	// Which workspace packages changed (any file under the member dir)?
	// Dirs are canonicalized so Windows short/long path forms compare equal.
	const members = (project.members ?? []).map((m) => ({
		...m,
		dir: canon(m.dir),
	}));
	const rootDir = canon(project.rootDir);
	const memberByName = new Map(
		members.map((m) => [
			m.name,
			m,
		]),
	);
	const changedPackages = new Set<string>();
	for (const member of members) {
		if (files.some((file) => underDir(file, member.dir))) {
			changedPackages.add(member.name);
		}
	}
	// Propagate to transitive workspace dependents (a dependent consumes
	// rebuilt artifacts it cannot express in its own cwd-relative globs).
	const memberDependents = new Map<string, Set<string>>();
	for (const member of members) {
		for (const dep of member.deps) {
			let set = memberDependents.get(dep);
			if (!set) {
				set = new Set();
				memberDependents.set(dep, set);
			}
			set.add(member.name);
		}
	}
	const affectedPackages = new Set<string>();
	const visitPkg = (name: string): void => {
		if (affectedPackages.has(name)) {
			return;
		}
		affectedPackages.add(name);
		for (const dependent of memberDependents.get(name) ?? []) {
			visitPkg(dependent);
		}
	};
	for (const name of changedPackages) {
		visitPkg(name);
	}

	const packageOf = (task: Task): string | undefined => {
		const hash = task.name.indexOf("#");
		return hash === -1 ? undefined : task.name.slice(0, hash);
	};
	const packageDirOf = (task: Task): string => {
		const pkg = packageOf(task);
		return pkg !== undefined ? (memberByName.get(pkg)?.dir ?? rootDir) : rootDir;
	};

	const directlyAffected = (task: Task): boolean => {
		if (files.includes(canon(task.sourceConfig).replaceAll("\\", "/"))) {
			return true;
		}
		const pkg = packageOf(task);
		if (pkg !== undefined && affectedPackages.has(pkg) && task.inputs.length === 0) {
			return true;
		}
		if (task.inputs.length === 0) {
			// No inputs declared: conservatively affected by any change under its
			// package dir (root tasks: any change at all).
			return pkg !== undefined ? files.some((file) => underDir(file, packageDirOf(task))) : true;
		}
		const set = compile(task.inputs);
		const cwd = canon(task.cwd);
		for (const file of files) {
			const rel = relative(cwd, file);
			if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
				continue;
			}
			if (matches(set, rel)) {
				return true;
			}
		}
		// Inputs-declaring tasks in an affected *dependency* package still rerun
		// via the task/package propagation below, not via dir noise.
		return false;
	};

	// Seed with directly-affected tasks (across the whole project, so
	// propagation can flow through intermediate tasks), then close over
	// task-graph dependents.
	const affected = new Set<string>();
	for (const task of project.tasks.values()) {
		if (directlyAffected(task)) {
			affected.add(task.name);
		}
		// Tasks in a workspace-dependent package are affected wholesale.
		const pkg = packageOf(task);
		if (pkg !== undefined && affectedPackages.has(pkg) && changedPackages.has(pkg) === false) {
			affected.add(task.name);
		}
	}
	const rev = dependents(project.tasks);
	const queue = [
		...affected,
	];
	while (queue.length > 0) {
		const name = queue.pop() as string;
		for (const dependent of rev.get(name) ?? []) {
			if (!affected.has(dependent)) {
				affected.add(dependent);
				queue.push(dependent);
			}
		}
	}

	const kept: Task[] = [];
	const dropped: Task[] = [];
	for (const task of requested) {
		(affected.has(task.name) ? kept : dropped).push(task);
	}
	return {
		kept,
		dropped,
	};
}
