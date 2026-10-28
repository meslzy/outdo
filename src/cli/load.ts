/**
 * Shared "find and load the project" step.
 *
 * Single-project mode: the nearest do.ts up from cwd (or, without one, the
 * nearest package.json — its scripts are the tasks).
 * Workspace mode: cwd is at (or resolves to) a workspace root — the root
 * do.ts (if any) plus every member's do.ts and package.json scripts, member
 * tasks qualified as `pkg#task`. --filter selects members; when filters are
 * given, root tasks are excluded (filters select packages).
 *
 * package.json scripts become tasks unless a do.ts task of the same name
 * exists; a do.ts entry with no run/steps of its own runs the same-named
 * script (so do.ts can add deps, inputs or flags to a script).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILENAME, findConfig, type LoadedFile, loadConfigFile, withStepEdges } from "~/core/config";
import { OutdoError } from "~/core/errors";
import { assertAcyclic } from "~/core/graph";
import type { DepEdge, HookSpec, Project, Task } from "~/core/model";
import { didYouMean } from "~/core/util";
import { applyFilters, enumerateMembers, findWorkspaceRoot, type WorkspaceMember } from "~/core/workspaces";
import type { DefineOptions, MemberDefaults } from "~/types";

/** npm lifecycle scripts: run by the package manager, never tasks of their own. */
const LIFECYCLE = new Set([
	"preinstall",
	"install",
	"postinstall",
	"preuninstall",
	"uninstall",
	"postuninstall",
	"prepublish",
	"preprepare",
	"prepare",
	"postprepare",
	"prepublishOnly",
	"prepack",
	"postpack",
	"publish",
	"postpublish",
	"preversion",
	"version",
	"postversion",
	"dependencies",
]);

/** A script that just calls outdo would recurse (or duplicate a do.ts task). */
const CALLS_OUTDO = /^\s*(?:bunx\s+|bun\s+x\s+|npx\s+)?(?:@meslzy\/)?outdo(?:\s|$)/;

export function readScripts(pkgPath: string): Record<string, string> {
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
			scripts?: Record<string, unknown>;
		};
		const scripts: Record<string, string> = {};
		const all = pkg.scripts ?? {};
		for (const [name, command] of Object.entries(all)) {
			if (typeof command !== "string" || LIFECYCLE.has(name) || name === "outdo" || CALLS_OUTDO.test(command)) {
				continue;
			}
			// pre<x>/post<x> hooks run with <x> under `bun run`.
			const base = /^(?:pre|post)(.+)$/.exec(name)?.[1];
			if (base !== undefined && typeof all[base] === "string") {
				continue;
			}
			scripts[name] = command;
		}
		return scripts;
	} catch {
		return {};
	}
}

function scriptTask(name: string, script: string, command: string, pkgPath: string): Task {
	return {
		name,
		desc: command,
		group: undefined,
		kind: "script",
		deps: [],
		depEdges: [],
		after: [],
		steps: [],
		finally: [],
		env: undefined,
		args: {},
		positional: [],
		inputs: [],
		outputs: [],
		watch: [],
		persistent: false,
		ready: undefined,
		retry: undefined,
		timeoutMs: undefined,
		cwd: dirname(pkgPath),
		run: undefined,
		command: undefined,
		script,
		envFiles: [],
		protect: [],
		confirm: undefined,
		requires: undefined,
		readonly: false,
		destructive: false,
		sourceConfig: pkgPath,
		localName: script,
	};
}

/** do.ts tasks plus the package's scripts, keyed by local name. */
function packageTasks(file: LoadedFile | undefined, pkgPath: string): Map<string, Task> {
	const tasks = new Map<string, Task>(file?.tasks ?? []);
	const scripts = readScripts(pkgPath);
	for (const [name, command] of Object.entries(scripts)) {
		const existing = tasks.get(name);
		if (existing === undefined) {
			tasks.set(name, scriptTask(name, name, command, pkgPath));
		} else if (existing.run === undefined && existing.command === undefined && existing.steps.length === 0) {
			existing.script = name;
			existing.desc ??= command;
		}
	}
	return tasks;
}

/** Merge per-name member defaults into a member task (the task's own settings win). */
function applyMemberDefaults(task: Task, defaults: MemberDefaults | undefined): void {
	if (defaults === undefined) {
		return;
	}
	const extra = (defaults.deps ?? []).map(
		(entry): DepEdge =>
			typeof entry === "string"
				? {
						task: entry,
						// A default's plain dep may not exist in every package.
						optional: !entry.startsWith("^") && !entry.includes("#"),
						condition: undefined,
					}
				: {
						task: entry.task,
						optional: entry.optional === true || (!entry.task.startsWith("^") && !entry.task.includes("#")),
						condition: entry.if,
					},
	);
	task.depEdges = [
		...task.depEdges,
		...extra,
	];
	task.desc ??= defaults.desc;
	task.group ??= defaults.group;
	if (task.inputs.length === 0 && defaults.inputs !== undefined) {
		task.inputs = defaults.inputs;
	}
	if (task.outputs.length === 0 && defaults.outputs !== undefined) {
		task.outputs = defaults.outputs;
	}
	if (task.watch.length === 0 && defaults.watch !== undefined) {
		task.watch = defaults.watch;
	}
	task.readonly ||= defaults.readonly === true;
	task.destructive ||= defaults.destructive === true;
	task.requires ??= defaults.requires;
	if (task.protect.length === 0 && defaults.protect !== undefined) {
		task.protect =
			defaults.protect === true
				? [
						"*",
					]
				: typeof defaults.protect === "string"
					? [
							defaults.protect,
						]
					: defaults.protect;
	}
	task.confirm ??= defaults.confirm;
}

interface Owner {
	member: WorkspaceMember | undefined;
}

/**
 * Expand one reference made by a task:
 *   ^name     — `name` in each workspace dependency (root: in every member)
 *   pkg#name  — that member's task
 *   name      — the owner package's own task
 */
function expandRef(
	ref: string,
	owner: Owner,
	tasks: ReadonlyMap<string, Task>,
	members: readonly WorkspaceMember[],
): string[] {
	if (ref.startsWith("^")) {
		const name = ref.slice(1);
		const pkgs = owner.member !== undefined ? owner.member.deps : members.map((m) => m.name);
		return pkgs.map((pkg) => `${pkg}#${name}`).filter((full) => tasks.has(full));
	}
	if (ref.includes("#") || owner.member === undefined) {
		return [
			ref,
		];
	}
	return [
		`${owner.member.name}#${ref}`,
	];
}

function unknownRef(
	task: Task,
	ref: string,
	what: string,
	tasks: ReadonlyMap<string, Task>,
	configPath: string,
): never {
	const hint = didYouMean(ref, [
		...tasks.keys(),
	]);
	throw new OutdoError(
		"config-invalid",
		`Task "${task.name}" ${what} unknown task "${ref}".${hint ? ` Did you mean "${hint}"?` : ""}`,
		{
			task: task.name,
			dep: ref,
			configPath,
		},
	);
}

/** Resolve every dep/step/finally reference to a full task name; drop absent optional deps. */
function resolveRefs(
	tasks: Map<string, Task>,
	owners: ReadonlyMap<string, Owner>,
	members: readonly WorkspaceMember[],
): void {
	for (const task of tasks.values()) {
		const owner = owners.get(task.name) ?? {
			member: undefined,
		};
		const edges: DepEdge[] = [];
		for (const edge of task.depEdges) {
			if (edge.step === true) {
				continue;
			}
			const targets = expandRef(edge.task, owner, tasks, members);
			for (const target of targets) {
				if (tasks.has(target)) {
					edges.push({
						...edge,
						task: target,
					});
				} else if (!edge.optional) {
					unknownRef(task, edge.task, "depends on", tasks, task.sourceConfig);
				}
			}
		}
		task.depEdges = edges;
		const resolveList = (list: readonly string[], what: string): string[] =>
			list.flatMap((ref) => {
				const targets = expandRef(ref, owner, tasks, members);
				for (const target of targets) {
					if (!tasks.has(target)) {
						unknownRef(task, ref, what, tasks, task.sourceConfig);
					}
				}
				return targets;
			});
		task.steps = resolveList(task.steps, "has a step on");
		task.finally = resolveList(task.finally, "has a finally on");
		withStepEdges(task);
	}
}

function nearestPackageJson(startDir: string): string | undefined {
	let dir = resolve(startDir);
	for (;;) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

function lockfiles(dir: string): string[] {
	return [
		"bun.lock",
		"bun.lockb",
	]
		.map((name) => join(dir, name))
		.filter((path) => existsSync(path));
}

function modesOf(options: DefineOptions | undefined): readonly string[] {
	const modes = options?.modes ?? [];
	if (!Array.isArray(modes) || !modes.every((m) => typeof m === "string" && m !== "")) {
		throw new OutdoError("config-invalid", `defineTasks option "modes" must be a list of non-empty names.`);
	}
	return modes;
}

export async function loadProjectFromCwd(filters: readonly string[] = []): Promise<Project> {
	const cwd = process.cwd();
	const configPath = findConfig(cwd);
	const wsRoot = findWorkspaceRoot(cwd);
	const atWorkspaceRoot = wsRoot !== undefined && (configPath === undefined || dirname(configPath) === wsRoot.rootDir);

	if (!atWorkspaceRoot) {
		const pkgPath = configPath !== undefined ? join(dirname(configPath), "package.json") : nearestPackageJson(cwd);
		if (configPath === undefined && pkgPath === undefined) {
			throw new OutdoError(
				"config-not-found",
				`No ${CONFIG_FILENAME} found in ${cwd} or any parent directory (and no package.json with scripts). Create one with "outdo init".`,
			);
		}
		const file = configPath !== undefined ? await loadConfigFile(configPath) : undefined;
		const rootDir = dirname(configPath ?? (pkgPath as string));
		const tasks = packageTasks(file, pkgPath ?? join(rootDir, "package.json"));
		if (tasks.size === 0) {
			throw new OutdoError(
				"config-not-found",
				`No ${CONFIG_FILENAME} and no package.json scripts in ${rootDir}. Create a do.ts with "outdo init".`,
			);
		}
		resolveRefs(tasks, new Map(), []);
		assertAcyclic(tasks);
		return {
			configPath: configPath ?? (pkgPath as string),
			rootDir,
			tasks,
			modes: modesOf(file?.options),
			hooks: file?.hooks ?? new Map<string, HookSpec>(),
			sources: [
				...(configPath !== undefined
					? [
							configPath,
						]
					: []),
				...(pkgPath !== undefined && existsSync(pkgPath)
					? [
							pkgPath,
						]
					: []),
				...lockfiles(rootDir),
			],
		};
	}

	const members = applyFilters(await enumerateMembers(wsRoot), filters, wsRoot.rootDir);
	const allMembers = filters.length === 0 ? members : await enumerateMembers(wsRoot);
	const tasks = new Map<string, Task>();
	const owners = new Map<string, Owner>();
	const sources: string[] = [];
	const rootPkg = join(wsRoot.rootDir, "package.json");
	sources.push(rootPkg, ...lockfiles(wsRoot.rootDir));

	const rootFile = configPath !== undefined ? await loadConfigFile(configPath) : undefined;
	if (configPath !== undefined) {
		sources.push(configPath);
	}
	if (filters.length === 0) {
		for (const task of packageTasks(rootFile, rootPkg).values()) {
			tasks.set(task.name, task);
		}
	}

	const defaults = rootFile?.options?.members ?? {};
	for (const member of members) {
		const memberConfig = join(member.dir, CONFIG_FILENAME);
		const memberPkg = join(member.dir, "package.json");
		sources.push(memberPkg);
		let file: LoadedFile | undefined;
		if (existsSync(memberConfig)) {
			sources.push(memberConfig);
			file = await loadConfigFile(memberConfig);
		}
		for (const task of packageTasks(file, memberPkg).values()) {
			if (task.kind === "hook") {
				continue; // hooks belong to the repo root
			}
			const qualified = `${member.name}#${task.name}`;
			const copy: Task = {
				...task,
				name: qualified,
			};
			applyMemberDefaults(copy, defaults[task.localName]);
			tasks.set(qualified, copy);
			owners.set(qualified, {
				member,
			});
		}
	}

	if (tasks.size === 0) {
		throw new OutdoError(
			"config-not-found",
			`No ${CONFIG_FILENAME} or package.json scripts at the workspace root or in any member package. Create one with "outdo init".`,
		);
	}

	resolveRefs(tasks, owners, allMembers);
	const project: Project = {
		configPath: configPath ?? rootPkg,
		rootDir: wsRoot.rootDir,
		tasks,
		members,
		modes: modesOf(rootFile?.options),
		hooks: filters.length === 0 && rootFile !== undefined ? rootFile.hooks : new Map<string, HookSpec>(),
		sources,
	};
	assertAcyclic(project.tasks);
	return project;
}
