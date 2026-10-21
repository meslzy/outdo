/**
 * Turning command-line words into a run plan, shared by `outdo <task>`,
 * `outdo ci`, `outdo bg start` and the MCP server:
 *
 *   words -> tasks     namespaces (`db reset` -> `db:reset`), positional
 *                      values (`logs api`), workspace fan-out
 *   runner flags       --mode / --yes / --from / --until after the task name
 *   env                dotenv cascade for the mode, per-task envFiles
 *   plan               affected filter, steps ordering, finally owners
 *   guards             OUTDO_READONLY, protect/confirm, env schemas
 */

import { refreshCompletionCache } from "~/cli/complete";
import { loadProjectFromCwd } from "~/cli/load";
import type { GlobalFlags } from "~/cli/parse";
import { extractRunnerFlags } from "~/cli/parse";
import { findTaskMatches } from "~/cli/resolve-task";
import { applyDefaults, parseTaskArgs, renderTaskHelp, wantsTaskHelp } from "~/core/argspec";
import type { ResolvedEnv } from "~/core/envresolve";
import { layerEnvFiles, resolveEnv, validateAll } from "~/core/envresolve";
import { OutdoError } from "~/core/errors";
import type { ChangedResult } from "~/core/gitaffected";
import { detectChanged, selectAffected } from "~/core/gitaffected";
import { applyConditions, applySteps, assertAcyclic, subgraphFor, topoOrder, trimSteps } from "~/core/graph";
import { assertReadonlyAllowed, confirmPlan } from "~/core/guard";
import { dim } from "~/core/logger";
import type { ArgValues, Project, Task } from "~/core/model";
import { didYouMean } from "~/core/util";

export interface AffectedInfo {
	base: string;
	kept: string[];
	dropped: string[];
}

export interface SharedRunState {
	project: Project;
	planned: Task[];
	requestedNames: Set<string>;
	/** The single requested task carrying parsed CLI flags (multi-task runs: none). */
	target: Task | undefined;
	targetArgs: ArgValues;
	/** Default arg values for every planned task (deps, multi-task runs). */
	defaultArgs: Map<string, ArgValues>;
	rest: string[];
	/** The resolved dotenv cascade (before any task's envFiles). */
	env: ResolvedEnv;
	/** Full shell env for one task: cascade + its envFiles, process env on top. */
	envFor: (task: Task) => Record<string, string | undefined>;
	envOutputs: ReadonlyMap<string, unknown>;
	subset: ReadonlySet<string>;
	/** Fingerprints recorded as tasks start (deps always precede dependents). */
	fingerprints: Map<string, string>;
	/** Data outputs recorded as tasks finish (or replay from cache). */
	outputs: Map<string, unknown>;
	force: boolean;
	/** Active --mode ("" when the project declares none). */
	mode: string;
}

export type PlanResult =
	| {
			kind: "plan";
			state: SharedRunState;
			requested: Task[];
			affected: AffectedInfo | undefined;
	  }
	| {
			/** `outdo db` where `db` is a namespace: list its tasks. */
			kind: "namespace";
			project: Project;
			namespace: string;
	  }
	| {
			kind: "help";
			text: string;
	  }
	| {
			/** --affected dropped every requested task. */
			kind: "nothing";
			affected: AffectedInfo;
	  };

export interface PlanOptions {
	/** Leave persistent tasks out of the request (CI never waits on a service). */
	dropPersistent?: boolean;
}

function knows(project: Project, name: string): boolean {
	return project.tasks.has(name) || findTaskMatches(project, name).length > 0;
}

export function isNamespaceName(project: Project, name: string): boolean {
	const prefix = `${name}:`;
	for (const task of project.tasks.values()) {
		if (task.localName.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

/** The single task a word refers to, when it is unambiguous. */
function single(project: Project, name: string): Task | undefined {
	const exact = project.tasks.get(name);
	if (exact !== undefined) {
		return exact;
	}
	const matches = findTaskMatches(project, name);
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Split run words into task names and the target's own argv. `db reset`
 * joins into `db:reset` when `db` is a namespace; once a task that takes
 * positional values is named, every later word belongs to it.
 */
export function resolveWords(
	project: Project,
	words: readonly string[],
	taskArgv: readonly string[],
):
	| {
			names: string[];
			targetArgv: string[];
	  }
	| {
			namespace: string;
	  } {
	const names: string[] = [];
	for (let i = 0; i < words.length; ) {
		const word = words[i] as string;
		const next = words[i + 1];
		let name = word;
		if (!knows(project, word) && isNamespaceName(project, word)) {
			if (next === undefined) {
				if (names.length === 0) {
					return {
						namespace: word,
					};
				}
			} else {
				name = `${word}:${next}`;
				i++;
			}
		}
		i++;
		names.push(name);
		const task = single(project, name);
		if (task !== undefined && task.positional.length > 0) {
			return {
				names,
				targetArgv: [
					...words.slice(i),
					...taskArgv,
				],
			};
		}
	}
	return {
		names,
		targetArgv: [
			...taskArgv,
		],
	};
}

export function resolveRequested(project: Project, names: string[]): Task[] {
	if (names.length === 0) {
		throw new OutdoError("usage", "No task given.");
	}
	const out: Task[] = [];
	const seen = new Set<string>();
	const add = (task: Task): void => {
		if (!seen.has(task.name)) {
			seen.add(task.name);
			out.push(task);
		}
	};
	for (const name of names) {
		// A bare name fans out: the root task (if any) plus every member task
		// `pkg#name`. Qualified names target exactly one task.
		const matches = findTaskMatches(project, name);
		if (matches.length > 0) {
			for (const task of matches) {
				add(task);
			}
			continue;
		}
		const hint = didYouMean(
			name,
			[
				...project.tasks.values(),
			]
				.filter((t) => t.kind !== "hook")
				.map((t) => t.name),
		);
		throw new OutdoError(
			"unknown-task",
			`Unknown task "${name}".${hint === undefined ? "" : ` Did you mean "${hint}"?`} Run "outdo" to list tasks.`,
			{
				task: name,
			},
		);
	}
	return out;
}

/** The active mode: --mode (validated) or the first declared mode. */
export function resolveMode(project: Project, requested: string | undefined): string {
	if (project.modes.length === 0) {
		if (requested !== undefined) {
			throw new OutdoError(
				"usage",
				`--mode "${requested}": this project declares no modes (defineTasks(tasks, { modes: [...] })).`,
			);
		}
		return "";
	}
	if (requested === undefined) {
		return project.modes[0] as string;
	}
	if (!project.modes.includes(requested)) {
		throw new OutdoError("usage", `Unknown mode "${requested}". Modes: ${project.modes.join(", ")}.`);
	}
	return requested;
}

/**
 * Resolve the env cascade for this run and apply it to process.env (process
 * env wins), so conditions, schemas, and spawned processes all agree.
 * Returns the resolved cascade plus a per-task env builder for envFiles.
 */
export function prepareEnv(
	project: Project,
	mode: string,
): {
	env: ResolvedEnv;
	envFor: (task: Task) => Record<string, string | undefined>;
} {
	const snapshot: Record<string, string | undefined> = {
		...process.env,
	};
	if (mode !== "") {
		snapshot.OUTDO_MODE = mode;
		process.env.OUTDO_MODE = mode;
	}
	const env = resolveEnv(project.rootDir, snapshot, project.modes.length > 0 ? mode : undefined);
	for (const [key, entry] of env.keys) {
		if (entry.source !== "process" && process.env[key] === undefined) {
			process.env[key] = entry.value;
		}
	}
	const perTask = new Map<string, Record<string, string | undefined>>();
	const envFor = (task: Task): Record<string, string | undefined> => {
		if (task.envFiles.length === 0) {
			return env.env;
		}
		let cached = perTask.get(task.name);
		if (cached === undefined) {
			cached = layerEnvFiles(env, task.envFiles, mode, project.rootDir).env;
			perTask.set(task.name, cached);
		}
		return cached;
	};
	return {
		env,
		envFor,
	};
}

/** Build the full plan for one invocation. Throws usage/config errors before anything runs. */
export async function preparePlan(
	input: {
		words: readonly string[];
		taskArgv: readonly string[];
		rest: readonly string[];
	},
	flags: GlobalFlags,
	options: PlanOptions = {},
): Promise<PlanResult> {
	const loaded = await loadProjectFromCwd(flags.filter);
	if (flags.filter.length === 0) {
		refreshCompletionCache(loaded);
	}

	const resolvedWords = resolveWords(loaded, input.words, input.taskArgv);
	if ("namespace" in resolvedWords) {
		return {
			kind: "namespace",
			project: loaded,
			namespace: resolvedWords.namespace,
		};
	}
	const requestedNames = resolvedWords.names;

	// Runner flags may follow the task name unless the task claims that flag.
	const firstTarget = requestedNames.length === 1 ? single(loaded, requestedNames[0] as string) : undefined;
	const runner = extractRunnerFlags(
		resolvedWords.targetArgv,
		new Set(Object.keys(firstTarget?.args ?? {})),
		new Set(
			Object.values(firstTarget?.args ?? {})
				.map((def) => def.short)
				.filter((s): s is string => s !== undefined),
		),
	);
	const runFlags: GlobalFlags = {
		...flags,
		mode: runner.mode ?? flags.mode,
		yes: runner.yes === true || flags.yes,
		from: runner.from ?? flags.from,
		until: runner.until ?? flags.until,
	};
	Object.assign(flags, {
		mode: runFlags.mode,
		yes: runFlags.yes,
		from: runFlags.from,
		until: runFlags.until,
	});
	const taskArgv = runner.argv;

	const mode = resolveMode(loaded, runFlags.mode);
	const { env, envFor } = prepareEnv(loaded, mode);
	const project: Project = {
		...loaded,
		tasks: applyConditions(loaded.tasks, env.env),
	};

	let requestedAll = resolveRequested(project, requestedNames);
	if (options.dropPersistent === true) {
		const services = requestedAll.filter((t) => t.persistent);
		if (services.length > 0) {
			console.error(dim(`skipping service(s): ${services.map((t) => t.name).join(", ")}`));
		}
		requestedAll = requestedAll.filter((t) => !t.persistent);
		if (requestedAll.length === 0) {
			throw new OutdoError("usage", "Every requested task is a service — nothing to run here.");
		}
	}

	// Per-task flags only make sense for a single task — validated against
	// what the user *asked for*, before --affected filtering: a dropped task
	// must not silently reroute flags, and a --dry preview must not turn into
	// a usage error just because git dropped the target.
	if (taskArgv.length > 0 && requestedAll.length !== 1) {
		throw new OutdoError("usage", "Task flags require exactly one task on the command line.");
	}
	if ((runFlags.from !== undefined || runFlags.until !== undefined) && requestedAll.length !== 1) {
		throw new OutdoError("usage", "--from/--until need exactly one task with steps.");
	}
	let target = requestedAll.length === 1 ? (requestedAll[0] as Task) : undefined;
	if (target !== undefined && taskArgv.length > 0 && wantsTaskHelp(target, taskArgv)) {
		return {
			kind: "help",
			text: renderTaskHelp(target),
		};
	}
	const targetArgs = target !== undefined ? await parseTaskArgs(target, taskArgv) : {};

	// --from/--until trim the target's steps for this run only.
	const tasks = new Map(project.tasks);
	if (target !== undefined && (runFlags.from !== undefined || runFlags.until !== undefined)) {
		target = trimSteps(target, runFlags.from, runFlags.until);
		tasks.set(target.name, target);
		requestedAll = [
			target,
		];
	}

	// Git-aware selection: keep only tasks affected vs the base rev.
	let requested = requestedAll;
	let affected: AffectedInfo | undefined;
	if (runFlags.affected !== false) {
		const changed: ChangedResult = await detectChanged(project.rootDir, runFlags.affected.base);
		const selection = selectAffected(project, requested, changed);
		affected = {
			base: changed.base,
			kept: selection.kept.map((t) => t.name),
			dropped: selection.dropped.map((t) => t.name),
		};
		console.error(
			dim(`affected vs ${changed.base}: running ${selection.kept.length} of ${requested.length} requested task(s)`),
		);
		if (selection.kept.length === 0 && runFlags.dry === false) {
			return {
				kind: "nothing",
				affected,
			};
		}
		requested = selection.kept.map((t) => tasks.get(t.name) as Task);
	}

	const subset = subgraphFor(
		tasks,
		requested.map((t) => t.name),
	);
	const planTasks = applySteps(tasks, subset);
	assertAcyclic(planTasks);
	const order = topoOrder(planTasks, subset);
	const planned = order.map((name) => planTasks.get(name) as Task);
	if (target !== undefined) {
		target = planTasks.get(target.name) ?? target;
	}

	assertReadonlyAllowed(planned);
	if (runFlags.dry === false) {
		confirmPlan(planned, mode, runFlags.yes);
	}
	// Validate every schema in the plan before anything runs.
	const envOutputs = await validateAll(planned, envFor);

	const defaultArgs = new Map<string, ArgValues>();
	for (const task of planned) {
		defaultArgs.set(task.name, await applyDefaults(task));
	}

	return {
		kind: "plan",
		requested,
		affected,
		state: {
			project: {
				...project,
				tasks: planTasks,
			},
			planned,
			requestedNames: new Set(requested.map((t) => t.name)),
			target,
			targetArgs,
			defaultArgs,
			rest: [
				...input.rest,
			],
			env,
			envFor,
			envOutputs,
			subset,
			fingerprints: new Map(),
			outputs: new Map(),
			force: runFlags.force,
			mode,
		},
	};
}

/**
 * Plan the `finally` tasks owed after a run: owners are planned tasks with
 * `finally` whose subgraph started at least one task. Tasks that already
 * succeeded in the main run are not repeated.
 */
export async function planFinally(
	state: SharedRunState,
	started: ReadonlySet<string>,
	succeeded: ReadonlySet<string>,
): Promise<SharedRunState | undefined> {
	const tasks = state.project.tasks;
	const owed = new Set<string>();
	for (const owner of state.planned) {
		if (owner.finally.length === 0) {
			continue;
		}
		const closure = subgraphFor(tasks, [
			owner.name,
		]);
		if (
			![
				...closure,
			].some((name) => started.has(name))
		) {
			continue;
		}
		for (const name of owner.finally) {
			if (!succeeded.has(name)) {
				owed.add(name);
			}
		}
	}
	if (owed.size === 0) {
		return undefined;
	}
	const subset = new Set(
		[
			...subgraphFor(tasks, [
				...owed,
			]),
		].filter((name) => owed.has(name) || !succeeded.has(name)),
	);
	const order = topoOrder(tasks, subset);
	const planned = order.map((name) => tasks.get(name) as Task);
	const envOutputs = await validateAll(planned, state.envFor);
	const defaultArgs = new Map<string, ArgValues>();
	for (const task of planned) {
		defaultArgs.set(task.name, await applyDefaults(task));
	}
	return {
		...state,
		planned,
		requestedNames: new Set(owed),
		target: undefined,
		targetArgs: {},
		defaultArgs,
		rest: [],
		envOutputs,
		subset,
		fingerprints: new Map(state.fingerprints),
	};
}
