/**
 * `outdo usage` analysis — pure: the usage log, shell-history calls and the
 * project in, a report out.
 *
 * A task is "used" when a recorded run planned it or shell history shows it
 * typed; "referenced" when it never ran but something live points at it (a
 * used task's deps/steps/finally or code, a git hook, a CI workflow, a
 * package.json script); "unused" otherwise. Duplicates are static: hidden
 * package.json scripts, tasks that only call another task, the same command
 * or the same steps twice, scripts that only call outdo.
 */

import { dirname } from "node:path";
import { callsIn } from "~/core/history";
import type { Project, Task, TaskKind } from "~/core/model";
import type { UsageEnd, UsageStart } from "~/core/usage";

/** A flag needs this many runs (since it was added) before "never passed" means anything. */
export const MIN_RUNS = 3;
/** Tracking younger than this is too short to call a task unused with confidence. */
export const YOUNG_MS = 14 * 24 * 60 * 60 * 1000;

/** A task typed in shell history, already resolved against the project. */
export interface TypedUse {
	t: number | undefined;
	task: string;
	flags: readonly string[];
}

/** Something outside the task graph that names a task (a CI workflow, a package.json script, a task's code). */
export interface Mention {
	task: string;
	/** `task:<name>` for another task's code, else a label such as `.github/workflows/ci.yml`. */
	from: string;
}

/** One package's package.json scripts. */
export interface PackageScripts {
	/** Absolute package directory. */
	dir: string;
	/** "" for the root, else the member name. */
	pkg: string;
	/** Every script, as written. */
	scripts: Readonly<Record<string, string>>;
	/** Scripts outdo exposes as tasks (no lifecycle, pre/post or outdo-calling ones). */
	visible: ReadonlySet<string>;
}

export interface UsageInput {
	project: Project;
	starts: readonly UsageStart[];
	ends: ReadonlyMap<string, UsageEnd>;
	seen: Readonly<Record<string, number>>;
	typed: readonly TypedUse[];
	/** `bun run <script>` calls from shell history (script names). */
	typedScripts: readonly string[];
	mentions: readonly Mention[];
	packages: readonly PackageScripts[];
	/** Only count usage at or after this time (epoch ms). */
	since?: number;
	now: number;
}

export interface FlagUsage {
	flag: string;
	/** Times the flag was given (recorded runs + shell history). */
	given: number;
	/** Recorded runs of the task since the flag first appeared. */
	runs: number;
	required: boolean;
	/** Counts per value, for flags with choices. */
	values?: Record<string, number>;
	/** Choices never used (the default counts as used when the flag was left out). */
	unusedValues?: string[];
}

export type TaskStatus = "used" | "referenced" | "unused";

export interface TaskUsage {
	name: string;
	kind: TaskKind;
	group?: string;
	desc?: string;
	/** Asked for by a person. */
	you: number;
	/** Asked for by an agent (AI_AGENT, CLAUDECODE, MCP, ...). */
	agent: number;
	/** Planned without being asked for: a dep, a step, a nested outdo run. */
	deps: number;
	/** Run by a git hook. */
	hooks: number;
	/** Typed in shell history. */
	typed: number;
	last?: number;
	avgMs?: number;
	fails: number;
	service: boolean;
	status: TaskStatus;
	/** What points at this task. */
	usedBy: string[];
	/** When outdo first saw the task. */
	firstSeen?: number;
	flags: FlagUsage[];
}

export type Duplicate =
	| {
			/** A do.ts task with its own run hides the same-named package.json script. */
			kind: "hidden-script";
			task: string;
			pkg: string;
			script: string;
			command: string;
			/** `bun run <script>` calls in shell history (the script still runs that way). */
			typed: number;
	  }
	| {
			/** A do.ts task whose run is `bun run <its own name>`: drop the run, the entry runs the script. */
			kind: "runs-own-script";
			task: string;
			command: string;
	  }
	| {
			/** A task that only runs another task. */
			kind: "alias";
			task: string;
			of: string;
			command: string;
	  }
	| {
			kind: "same-command";
			tasks: string[];
			command: string;
	  }
	| {
			kind: "same-steps";
			tasks: string[];
			steps: string[];
	  }
	| {
			/** A package.json script that only calls outdo. */
			kind: "outdo-script";
			pkg: string;
			script: string;
			command: string;
	  };

export interface UsageReport {
	since?: number;
	now: number;
	/** Recorded runs in the window. */
	runs: number;
	/** First recorded run in the window. */
	firstRun?: number;
	/** When tracking started (oldest first-seen mark). */
	trackedSince?: number;
	/** Shell-history calls that matched this project, and the oldest one's time. */
	history: {
		calls: number;
		from?: number;
	};
	tasks: TaskUsage[];
	modes: {
		name: string;
		runs: number;
	}[];
	hooks: {
		name: string;
		runs: number;
	}[];
	duplicates: Duplicate[];
}

function bump(map: Map<string, number>, key: string, by = 1): void {
	map.set(key, (map.get(key) ?? 0) + by);
}

const inWindow = (t: number | undefined, since: number | undefined): boolean =>
	since === undefined || (t !== undefined && t >= since);

/** Collapse whitespace; `bunx x` / `bun x x` / `npx x` run the same bin as `x`. */
export function normalizeCommand(command: string): string {
	return command
		.trim()
		.replaceAll(/\s+/g, " ")
		.replaceAll(/(^|&& |; |\|\| )(?:bunx|bun x|npx) /g, "$1");
}

function packageDir(task: Task): string {
	return dirname(task.sourceConfig);
}

function commandOf(task: Task, scripts: ReadonlyMap<string, PackageScripts>): string | undefined {
	if (task.command !== undefined) {
		return task.command.join(" && ");
	}
	if (task.script !== undefined && task.run === undefined) {
		return scripts.get(packageDir(task))?.scripts[task.script];
	}
	return undefined;
}

export function findDuplicates(
	project: Project,
	packages: readonly PackageScripts[],
	typedScripts: readonly string[],
): Duplicate[] {
	const byDir = new Map(
		packages.map((p) => [
			p.dir,
			p,
		]),
	);
	const out: Duplicate[] = [];
	const typedCount = new Map<string, number>();
	for (const script of typedScripts) {
		bump(typedCount, script);
	}
	const tasks = [
		...project.tasks.values(),
	].filter((t) => t.kind !== "hook");
	const localTask = (dir: string, local: string): Task | undefined =>
		tasks.find((t) => t.localName === local && packageDir(t) === dir);
	const aliased = new Set<string>();

	for (const task of tasks) {
		if (task.kind !== "task") {
			continue;
		}
		const pkg = byDir.get(packageDir(task));
		const own = task.command?.length === 1 ? (task.command[0] as string) : undefined;
		const call = own === undefined ? undefined : callsIn(own);
		const single = call?.length === 1 ? call[0] : undefined;
		if (pkg !== undefined && task.script === undefined && pkg.visible.has(task.localName)) {
			if (single?.kind === "script" && single.script === task.localName) {
				out.push({
					kind: "runs-own-script",
					task: task.name,
					command: own as string,
				});
			} else {
				out.push({
					kind: "hidden-script",
					task: task.name,
					pkg: pkg.pkg,
					script: task.localName,
					command: pkg.scripts[task.localName] as string,
					typed: pkg.pkg === "" ? (typedCount.get(task.localName) ?? 0) : 0,
				});
			}
			continue;
		}
		const target =
			single?.kind === "script"
				? single.script
				: single?.kind === "outdo" && single.argv.length === 1
					? single.argv[0]
					: undefined;
		if (target !== undefined && target !== task.localName) {
			const of = localTask(packageDir(task), target) ?? project.tasks.get(target);
			if (of !== undefined) {
				aliased.add(task.name);
				out.push({
					kind: "alias",
					task: task.name,
					of: of.name,
					command: own as string,
				});
			}
		}
	}

	const sameCommand = new Map<string, string[]>();
	const sameSteps = new Map<string, string[]>();
	for (const task of tasks) {
		const command = commandOf(task, byDir);
		if (command !== undefined && !aliased.has(task.name)) {
			const key = `${packageDir(task)}\0${normalizeCommand(command)}`;
			sameCommand.set(key, [
				...(sameCommand.get(key) ?? []),
				task.name,
			]);
		}
		if (task.run === undefined && task.command === undefined && task.script === undefined) {
			const stepSet = new Set(task.steps);
			const deps = task.deps.filter((d) => !stepSet.has(d)).sort();
			if (task.steps.length > 0 || deps.length > 0) {
				const key = `${task.steps.join(",")}|${deps.join(",")}`;
				sameSteps.set(key, [
					...(sameSteps.get(key) ?? []),
					task.name,
				]);
			}
		}
	}
	for (const [key, names] of sameCommand) {
		if (names.length > 1) {
			out.push({
				kind: "same-command",
				tasks: names,
				command: key.slice(key.indexOf("\0") + 1),
			});
		}
	}
	for (const [key, names] of sameSteps) {
		if (names.length > 1) {
			const [steps, deps] = key.split("|") as [
				string,
				string,
			];
			out.push({
				kind: "same-steps",
				tasks: names,
				steps: steps === "" ? deps.split(",") : steps.split(","),
			});
		}
	}

	for (const pkg of packages) {
		for (const [script, command] of Object.entries(pkg.scripts)) {
			const calls = callsIn(command);
			if (calls.length === 1 && calls[0]?.kind === "outdo" && script !== "outdo") {
				out.push({
					kind: "outdo-script",
					pkg: pkg.pkg,
					script,
					command,
				});
			}
		}
	}
	return out;
}

/** Everything that points at each task: tasks (deps, steps, finally, code), hooks, files. */
function referrers(project: Project, mentions: readonly Mention[]): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	const add = (task: string, from: string): void => {
		if (task === from) {
			return;
		}
		let set = out.get(task);
		if (set === undefined) {
			set = new Set();
			out.set(task, set);
		}
		set.add(from);
	};
	for (const task of project.tasks.values()) {
		for (const edge of task.depEdges) {
			add(edge.task, task.name);
		}
		for (const name of task.finally) {
			add(name, task.name);
		}
	}
	for (const mention of mentions) {
		add(mention.task, mention.from.startsWith("task:") ? mention.from.slice(5) : mention.from);
	}
	return out;
}

const HOOK_PREFIX = "hooks:";

export function analyzeUsage(input: UsageInput): UsageReport {
	const { project, since } = input;
	const starts = input.starts.filter((s) => inWindow(s.t, since));
	const typed = input.typed.filter((u) => inWindow(u.t, since));

	const you = new Map<string, number>();
	const agent = new Map<string, number>();
	const deps = new Map<string, number>();
	const hooks = new Map<string, number>();
	const typedCount = new Map<string, number>();
	const last = new Map<string, number>();
	const fails = new Map<string, number>();
	const time = new Map<
		string,
		{
			total: number;
			count: number;
		}
	>();
	const direct = new Map<string, number[]>();
	const given = new Map<string, Map<string, number>>();
	const values = new Map<string, Map<string, number>>();
	const modeRuns = new Map<string, number>();
	const hookRuns = new Map<string, number>();
	const seeLast = (name: string, t: number | undefined): void => {
		if (t !== undefined && t > (last.get(name) ?? 0)) {
			last.set(name, t);
		}
	};
	const noteFlags = (task: string, flags: readonly string[]): void => {
		let g = given.get(task);
		if (g === undefined) {
			g = new Map();
			given.set(task, g);
		}
		for (const token of flags) {
			const eq = token.indexOf("=");
			const flag = eq === -1 ? token : token.slice(0, eq);
			bump(g, flag);
			if (eq !== -1) {
				const key = `${task} --${flag}`;
				let v = values.get(key);
				if (v === undefined) {
					v = new Map();
					values.set(key, v);
				}
				bump(v, token.slice(eq + 1));
			}
		}
	};

	for (const start of starts) {
		const asked = new Set(start.tasks);
		for (const name of start.tasks) {
			if (start.via === "hook") {
				bump(hooks, name);
			} else if (start.via === "nested") {
				bump(deps, name);
			} else if (start.agent !== undefined) {
				bump(agent, name);
			} else {
				bump(you, name);
			}
		}
		for (const name of start.ran) {
			if (!asked.has(name)) {
				bump(deps, name);
			}
			seeLast(name, start.t);
		}
		if (start.mode !== undefined) {
			bump(modeRuns, start.mode);
		}
		if (start.hook !== undefined) {
			bump(hookRuns, start.hook);
		}
		if (start.tasks.length === 1 && start.via !== "hook" && start.via !== "nested") {
			const name = start.tasks[0] as string;
			direct.set(name, [
				...(direct.get(name) ?? []),
				start.t,
			]);
			noteFlags(name, start.flags ?? []);
		}
		const end = input.ends.get(start.id);
		for (const [name, ms] of Object.entries(end?.ms ?? {})) {
			const entry = time.get(name) ?? {
				total: 0,
				count: 0,
			};
			entry.total += ms;
			entry.count++;
			time.set(name, entry);
		}
		for (const name of end?.failed ?? []) {
			bump(fails, name);
		}
	}
	for (const use of typed) {
		bump(typedCount, use.task);
		seeLast(use.task, use.t);
		noteFlags(use.task, use.flags);
	}

	// Liveness: used tasks, hooks and externally mentioned tasks are roots;
	// whatever a live task points at is live too.
	const refs = referrers(project, input.mentions);
	const pointsAt = new Map<string, string[]>();
	for (const [task, from] of refs) {
		for (const source of from) {
			pointsAt.set(source, [
				...(pointsAt.get(source) ?? []),
				task,
			]);
		}
	}
	const isUsed = (name: string): boolean =>
		(you.get(name) ?? 0)
			+ (agent.get(name) ?? 0)
			+ (deps.get(name) ?? 0)
			+ (hooks.get(name) ?? 0)
			+ (typedCount.get(name) ?? 0)
		> 0;
	const live = new Set<string>();
	const queue: string[] = [];
	const mark = (name: string): void => {
		if (!live.has(name)) {
			live.add(name);
			queue.push(name);
		}
	};
	for (const task of project.tasks.values()) {
		if (isUsed(task.name) || task.kind === "hook") {
			mark(task.name);
		}
	}
	for (const mention of input.mentions) {
		if (!mention.from.startsWith("task:")) {
			mark(mention.task);
		}
	}
	while (queue.length > 0) {
		for (const target of pointsAt.get(queue.pop() as string) ?? []) {
			mark(target);
		}
	}

	const tasks: TaskUsage[] = [];
	for (const task of project.tasks.values()) {
		if (task.kind === "hook") {
			continue;
		}
		const runs = direct.get(task.name) ?? [];
		const flags: FlagUsage[] = Object.entries(task.args).map(([flag, def]) => {
			const firstSeen = input.seen[`${task.name} --${flag}`] ?? 0;
			const counted = runs.filter((t) => t >= firstSeen).length;
			const count = given.get(task.name)?.get(flag) ?? 0;
			const usage: FlagUsage = {
				flag,
				given: count,
				runs: counted,
				required: def.required,
			};
			if (def.choices !== undefined) {
				const seenValues = values.get(`${task.name} --${flag}`) ?? new Map<string, number>();
				usage.values = Object.fromEntries(seenValues);
				const used = new Set(seenValues.keys());
				if (count < counted && def.default !== undefined) {
					for (const value of Array.isArray(def.default)
						? def.default
						: [
								def.default,
							]) {
						used.add(String(value));
					}
				}
				const unused = def.choices.filter((c) => !used.has(c));
				if (counted >= MIN_RUNS && unused.length > 0) {
					usage.unusedValues = unused;
				}
			}
			return usage;
		});
		const timing = time.get(task.name);
		const usedBy = [
			...(refs.get(task.name) ?? []),
		].map((from) => (from.startsWith(HOOK_PREFIX) ? `hook ${from.slice(HOOK_PREFIX.length)}` : from));
		const firstSeen = input.seen[task.name];
		tasks.push({
			name: task.name,
			kind: task.kind,
			...(task.group !== undefined
				? {
						group: task.group,
					}
				: {}),
			...(task.desc !== undefined
				? {
						desc: task.desc,
					}
				: {}),
			you: you.get(task.name) ?? 0,
			agent: agent.get(task.name) ?? 0,
			deps: deps.get(task.name) ?? 0,
			hooks: hooks.get(task.name) ?? 0,
			typed: typedCount.get(task.name) ?? 0,
			...(last.has(task.name)
				? {
						last: last.get(task.name),
					}
				: {}),
			...(timing !== undefined && timing.count > 0
				? {
						avgMs: Math.round(timing.total / timing.count),
					}
				: {}),
			fails: fails.get(task.name) ?? 0,
			service: task.persistent,
			status: isUsed(task.name) ? "used" : live.has(task.name) ? "referenced" : "unused",
			usedBy,
			...(firstSeen !== undefined
				? {
						firstSeen,
					}
				: {}),
			flags,
		});
	}

	const seenTimes = Object.values(input.seen);
	const historyTimes = typed.map((u) => u.t).filter((t): t is number => t !== undefined);
	return {
		...(since !== undefined
			? {
					since,
				}
			: {}),
		now: input.now,
		runs: starts.length,
		...(starts.length > 0
			? {
					firstRun: Math.min(...starts.map((s) => s.t)),
				}
			: {}),
		...(seenTimes.length > 0
			? {
					trackedSince: Math.min(...seenTimes),
				}
			: {}),
		history: {
			calls: typed.length,
			...(historyTimes.length > 0
				? {
						from: Math.min(...historyTimes),
					}
				: {}),
		},
		tasks,
		modes: project.modes.map((name) => ({
			name,
			runs: modeRuns.get(name) ?? 0,
		})),
		hooks: [
			...project.hooks.keys(),
		].map((name) => ({
			name,
			runs: hookRuns.get(name) ?? 0,
		})),
		duplicates: findDuplicates(project, input.packages, input.typedScripts),
	};
}

/** Score for "most used": asked-for runs and typed calls first, dependency runs as a tiebreak. */
export function usageScore(task: TaskUsage): number {
	return (task.you + task.agent + task.typed + task.hooks) * 1000 + task.deps;
}
