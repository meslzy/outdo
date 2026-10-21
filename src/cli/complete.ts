/**
 * Hidden `outdo __complete -- <words...>` endpoint. Prints one candidate per
 * line as `value<TAB>description`. Must never fail loudly and must stay fast —
 * shells call this on every TAB press.
 *
 * Speed: the task list is cached in `.outdo/complete.json`, keyed by the
 * mtimes of every do.ts, package.json and lockfile it was built from, so a
 * Tab usually costs one JSON read instead of importing do.ts (and everything
 * it imports). Any normal outdo command refreshes the cache.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILENAME, findConfig } from "~/core/config";
import type { Project } from "~/core/model";
import { findWorkspaceRoot } from "~/core/workspaces";

const CACHE_VERSION = 1;

interface CachedArg {
	type: string;
	description?: string;
	choices?: readonly string[];
}

interface CachedTask {
	name: string;
	desc?: string;
	localName: string;
	args: Record<string, CachedArg>;
	positional: readonly string[];
	steps: readonly string[];
}

interface Snapshot {
	version: number;
	/** source path -> mtimeMs at the time of the snapshot */
	sources: Record<string, number>;
	tasks: CachedTask[];
	modes: readonly string[];
	members: string[];
	hooks: string[];
}

const GLOBAL_FLAGS: [
	string,
	string,
][] = [
	[
		"--mode",
		"mode declared in do.ts",
	],
	[
		"--yes",
		"answer yes to protect/confirm",
	],
	[
		"--watch",
		"re-run on file changes",
	],
	[
		"--concurrency",
		"max parallel tasks",
	],
	[
		"--continue",
		"keep running after a failure",
	],
	[
		"--log-order",
		"stream | grouped | auto",
	],
	[
		"--output-logs",
		"full | errors-only | none",
	],
	[
		"--dry",
		"show the plan without running",
	],
	[
		"--force",
		"ignore the fingerprint cache",
	],
	[
		"--affected",
		"only run tasks affected by git changes",
	],
	[
		"--profile",
		"write a Chrome trace of the run",
	],
	[
		"--isolate",
		"force the child-process backend",
	],
	[
		"--filter",
		"filter workspace packages",
	],
	[
		"--json",
		"machine-readable output",
	],
	[
		"--color",
		"auto | always | never",
	],
	[
		"--print-env",
		"explain resolved env for a task",
	],
	[
		"--help",
		"show help",
	],
];

const SUBCOMMANDS: [
	string,
	string,
][] = [
	[
		"ls",
		"list tasks",
	],
	[
		"run",
		"run a task (also one named like a command)",
	],
	[
		"graph",
		"print the dependency graph",
	],
	[
		"explain",
		"explain cache/plan for a task",
	],
	[
		"doctor",
		"check every task's requirements",
	],
	[
		"bg",
		"background runs: start, ps, logs, stop",
	],
	[
		"ci",
		"CI run of a task",
	],
	[
		"affected",
		"did a task's inputs change?",
	],
	[
		"hooks",
		"git hooks from do.ts",
	],
	[
		"prune",
		"package.jsons + lockfile for Docker",
	],
	[
		"mcp",
		"serve tasks as MCP tools",
	],
	[
		"init",
		"scaffold a starter do.ts",
	],
	[
		"completion",
		"print shell completions",
	],
];

const SHELLS = [
	"bash",
	"zsh",
	"fish",
	"powershell",
];

const VALUE_CHOICES: Record<string, readonly string[]> = {
	"--log-order": [
		"stream",
		"grouped",
		"auto",
	],
	"--output-logs": [
		"full",
		"errors-only",
		"none",
	],
	"--color": [
		"auto",
		"always",
		"never",
	],
};

/** Root dir and cache file for the project cwd resolves to — without loading anything. */
function locate(): string | undefined {
	const cwd = process.cwd();
	const configPath = findConfig(cwd);
	const ws = findWorkspaceRoot(cwd);
	if (ws !== undefined && (configPath === undefined || dirname(configPath) === ws.rootDir)) {
		return ws.rootDir;
	}
	if (configPath !== undefined) {
		return dirname(configPath);
	}
	let dir = cwd;
	for (;;) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

function cachePath(rootDir: string): string {
	return join(rootDir, ".outdo", "complete.json");
}

function mtime(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

function snapshotOf(project: Project): Snapshot {
	const sources: Record<string, number> = {};
	for (const path of project.sources) {
		const m = mtime(path);
		if (m !== undefined) {
			sources[path] = m;
		}
	}
	return {
		version: CACHE_VERSION,
		sources,
		tasks: [
			...project.tasks.values(),
		]
			.filter((task) => task.kind !== "hook")
			.map((task) => ({
				name: task.name,
				...(task.desc !== undefined
					? {
							desc: task.desc,
						}
					: {}),
				localName: task.localName,
				args: Object.fromEntries(
					Object.entries(task.args).map(([flag, def]) => [
						flag,
						{
							type: def.type,
							...(def.description !== undefined
								? {
										description: def.description,
									}
								: {}),
							...(def.choices !== undefined
								? {
										choices: def.choices,
									}
								: {}),
						},
					]),
				),
				positional: task.positional,
				steps: task.steps,
			})),
		modes: project.modes,
		members: (project.members ?? []).map((m) => m.name),
		hooks: [
			...project.hooks.keys(),
		],
	};
}

/** Best-effort write of the completion snapshot (atomic rename; never throws). */
export function refreshCompletionCache(project: Project): void {
	try {
		const path = cachePath(project.rootDir);
		mkdirSync(dirname(path), {
			recursive: true,
		});
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(snapshotOf(project)));
		renameSync(tmp, path);
	} catch {
		// read-only checkout etc. — completion just stays uncached
	}
}

function readFresh(rootDir: string): Snapshot | undefined {
	try {
		const snapshot = JSON.parse(readFileSync(cachePath(rootDir), "utf8")) as Snapshot;
		if (snapshot.version !== CACHE_VERSION) {
			return undefined;
		}
		const paths = Object.keys(snapshot.sources);
		if (paths.length === 0) {
			return undefined;
		}
		for (const path of paths) {
			if (mtime(path) !== snapshot.sources[path]) {
				return undefined;
			}
		}
		// A do.ts created since the snapshot would not be in its sources.
		if (!paths.some((p) => p.endsWith(CONFIG_FILENAME)) && existsSync(join(rootDir, CONFIG_FILENAME))) {
			return undefined;
		}
		return snapshot;
	} catch {
		return undefined;
	}
}

async function snapshot(): Promise<Snapshot | undefined> {
	const rootDir = locate();
	if (rootDir === undefined) {
		return undefined;
	}
	const cached = readFresh(rootDir);
	if (cached !== undefined) {
		return cached;
	}
	const { loadProjectFromCwd } = await import("~/cli/load");
	const project = await loadProjectFromCwd().catch(() => undefined);
	if (project === undefined) {
		return undefined;
	}
	refreshCompletionCache(project);
	return snapshotOf(project);
}

function namespaces(snap: Snapshot): Map<string, number> {
	const out = new Map<string, number>();
	for (const task of snap.tasks) {
		const colon = task.name.indexOf(":");
		if (colon > 0 && !task.name.includes("#")) {
			const ns = task.name.slice(0, colon);
			out.set(ns, (out.get(ns) ?? 0) + 1);
		}
	}
	return out;
}

/** The task a sequence of words names (`db reset` or `db:reset`), if unambiguous. */
function findTask(
	snap: Snapshot,
	words: readonly string[],
):
	| {
			task: CachedTask;
			used: number;
	  }
	| undefined {
	const byName = (name: string): CachedTask | undefined => {
		const exact = snap.tasks.find((t) => t.name === name);
		if (exact !== undefined) {
			return exact;
		}
		const members = snap.tasks.filter((t) => t.localName === name && t.name.includes("#"));
		return members.length === 1 ? members[0] : undefined;
	};
	const [first, second] = words;
	if (first === undefined) {
		return undefined;
	}
	const direct = byName(first);
	if (direct !== undefined) {
		return {
			task: direct,
			used: 1,
		};
	}
	if (second !== undefined) {
		const joined = byName(`${first}:${second}`);
		if (joined !== undefined) {
			return {
				task: joined,
				used: 2,
			};
		}
	}
	return undefined;
}

const GLOBAL_VALUE_FLAGS = new Set([
	"--mode",
	"-m",
	"--filter",
	"-F",
	"--concurrency",
	"-j",
	"--log-order",
	"--output-logs",
	"--color",
	"--print-env",
	"--from",
	"--until",
]);

export async function completeCommand(words: string[]): Promise<number> {
	try {
		// `--empty` (before `--`) means the cursor sits on a fresh word — sent by
		// shells that can't pass a literal "" to native commands (PowerShell).
		let raw = words;
		let cursorOnFreshWord = false;
		if (raw[0] === "--empty") {
			cursorOnFreshWord = true;
			raw = raw.slice(1);
		}
		const args = raw[0] === "--" ? raw.slice(1) : raw;
		if (cursorOnFreshWord) {
			args.push("");
		}
		// The last word is the partial being completed (may be "").
		const current = args.at(-1) ?? "";
		const prior = args.slice(0, -1).filter((w) => w !== "");
		const previous = prior.at(-1);

		const out: string[] = [];
		const emit = (value: string, desc: string): void => {
			if (value.startsWith(current)) {
				out.push(`${value}\t${desc}`);
			}
		};
		const flush = (): number => {
			if (out.length > 0) {
				console.log(out.join("\n"));
			}
			return 0;
		};

		// Positional words, skipping flags and the values of value-taking flags.
		const positionals: string[] = [];
		for (let i = 0; i < prior.length; i++) {
			const word = prior[i] as string;
			if (word.startsWith("-")) {
				if (!word.includes("=") && GLOBAL_VALUE_FLAGS.has(word)) {
					i++;
				}
				continue;
			}
			positionals.push(word);
		}
		const sub = positionals[0];

		if (sub === "completion") {
			for (const shell of SHELLS) {
				emit(shell, "shell");
			}
			return flush();
		}

		const snap = await snapshot();
		const emitTasks = (): void => {
			if (snap === undefined) {
				return;
			}
			for (const task of snap.tasks) {
				emit(task.name, task.desc ?? "");
			}
		};

		// Values for the flag just before the cursor.
		if (previous?.startsWith("-") && !previous.includes("=")) {
			const fixed = VALUE_CHOICES[previous];
			if (fixed !== undefined) {
				for (const value of fixed) {
					emit(value, previous);
				}
				return flush();
			}
			if (previous === "--mode" || previous === "-m") {
				for (const mode of snap?.modes ?? []) {
					emit(mode, "mode");
				}
				return flush();
			}
			if (previous === "--filter" || previous === "-F") {
				for (const member of snap?.members ?? []) {
					emit(member, "workspace package");
				}
				return flush();
			}
			if (previous === "--print-env") {
				emitTasks();
				return flush();
			}
			if (previous === "--concurrency" || previous === "-j") {
				return flush();
			}
			const found = snap === undefined ? undefined : findTask(snap, sub === "run" ? positionals.slice(1) : positionals);
			if (previous === "--from" || previous === "--until") {
				for (const step of found?.task.steps ?? []) {
					emit(step.includes("#") ? step.slice(step.indexOf("#") + 1) : step, "step");
				}
				return flush();
			}
			const flag = previous.replace(/^-+/, "");
			const def =
				found === undefined
					? undefined
					: (found.task.args[flag]
						?? Object.entries(found.task.args).find(
							([, d]) =>
								previous
								=== `-${
									(
										d as {
											short?: string;
										}
									).short
								}`,
						)?.[1]);
			if (def !== undefined && def.type !== "boolean") {
				for (const choice of def.choices ?? []) {
					emit(choice, def.description ?? flag);
				}
				return flush();
			}
		}

		if (current.startsWith("-")) {
			for (const [flag, desc] of GLOBAL_FLAGS) {
				emit(flag, desc);
			}
			const found = snap === undefined ? undefined : findTask(snap, sub === "run" ? positionals.slice(1) : positionals);
			if (found !== undefined) {
				for (const [flag, def] of Object.entries(found.task.args)) {
					emit(`--${flag}`, def.description ?? def.choices?.join(" | ") ?? def.type);
				}
				if (found.task.steps.length > 0) {
					emit("--from", "start at this step");
					emit("--until", "stop after this step");
				}
			}
			return flush();
		}

		if (sub === undefined) {
			emitTasks();
			for (const [ns, count] of snap === undefined ? [] : namespaces(snap)) {
				emit(ns, `${count} task${count === 1 ? "" : "s"}`);
			}
			for (const [name, desc] of SUBCOMMANDS) {
				emit(name, desc);
			}
			return flush();
		}

		if (sub === "bg") {
			const verb = positionals[1];
			if (verb === undefined) {
				for (const [v, desc] of [
					[
						"start",
						"start a task in the background",
					],
					[
						"ps",
						"what is running",
					],
					[
						"logs",
						"show a background run's log",
					],
					[
						"stop",
						"stop background runs",
					],
				] as const) {
					emit(v, desc);
				}
				return flush();
			}
			if (verb === "start" && positionals.length === 2) {
				emitTasks();
			} else if ((verb === "stop" || verb === "logs") && snap !== undefined) {
				const dir = join(locate() ?? ".", ".outdo", "bg");
				const { readdirSync } = await import("node:fs");
				for (const file of existsSync(dir) ? readdirSync(dir) : []) {
					if (file.endsWith(".json")) {
						emit(file.slice(0, -5), "background run");
					}
				}
			}
			return flush();
		}

		if (sub === "hooks") {
			if (positionals.length === 1) {
				for (const action of [
					"install",
					"uninstall",
					"list",
					"run",
				]) {
					emit(action, "hooks");
				}
			} else if (positionals[1] === "run" && positionals.length === 2) {
				for (const hook of snap?.hooks ?? []) {
					emit(hook, "git hook");
				}
			}
			return flush();
		}

		if (sub === "explain" || sub === "affected" || sub === "ci" || sub === "run") {
			if (sub === "ci" && positionals.length === 1) {
				emit("init", "write .github/workflows/ci.yml");
			}
			if (sub === "explain" && positionals.length > 1) {
				return flush();
			}
			const rest = positionals.slice(1);
			const found = snap === undefined ? undefined : findTask(snap, rest);
			if (found === undefined || found.task.positional.length === 0) {
				emitTasks();
			} else {
				emitPositional(found.task, rest.length - found.used, emit);
			}
			return flush();
		}

		if (snap === undefined) {
			return flush();
		}

		// `outdo db <Tab>`: the namespace's own tasks.
		if (
			positionals.length === 1
			&& namespaces(snap).has(sub)
			&& findTask(snap, [
				sub,
			])?.used !== 1
		) {
			for (const task of snap.tasks) {
				if (task.name.startsWith(`${sub}:`)) {
					emit(task.name.slice(sub.length + 1), task.desc ?? "");
				}
			}
			return flush();
		}

		// After a task with positional values: complete the next one.
		const found = findTask(snap, positionals);
		if (found !== undefined && found.task.positional.length > 0) {
			emitPositional(found.task, positionals.length - found.used, emit);
			return flush();
		}

		// Completing additional task names.
		emitTasks();
		return flush();
	} catch {
		// Completions are best-effort; stay silent.
	}
	return 0;
}

function emitPositional(task: CachedTask, given: number, emit: (value: string, desc: string) => void): void {
	const index = Math.min(given, task.positional.length - 1);
	const flag = task.positional[index] as string;
	const def = task.args[flag];
	if (def === undefined || (given >= task.positional.length && def.type !== "array")) {
		return;
	}
	for (const choice of def.choices ?? []) {
		emit(choice, def.description ?? flag);
	}
}
