/** Pure DAG utilities over the normalized task map. */

import { OutdoError } from "~/core/errors";
import { type DepEdge, predecessors, type Task } from "~/core/model";

const FALSY_CONDITION_VALUES = new Set([
	"",
	"0",
	"false",
]);

/** Whether a dependency edge is active under the resolved env. May throw (predicates). */
export function edgeActive(edge: DepEdge, env: Record<string, string | undefined>): boolean {
	if (edge.condition === undefined) {
		return true;
	}
	if (typeof edge.condition === "string") {
		const value = env[edge.condition];
		return value !== undefined && !FALSY_CONDITION_VALUES.has(value.toLowerCase());
	}
	return edge.condition(env) === true;
}

/**
 * Filter every task's `deps` down to its active edges. Evaluated once per
 * invocation, after the dotenv cascade is resolved. `depEdges` (the declared
 * set) is left untouched for graph rendering. Cycles are validated over the
 * declared edges at load time, so conditions can never mask a cycle error.
 */
export function applyConditions(
	tasks: ReadonlyMap<string, Task>,
	env: Record<string, string | undefined>,
): Map<string, Task> {
	const out = new Map<string, Task>();
	for (const [name, task] of tasks) {
		if (task.depEdges.every((edge) => edge.condition === undefined)) {
			out.set(name, task);
			continue;
		}
		const active = task.depEdges.filter((edge) => {
			try {
				return edgeActive(edge, env);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new OutdoError("config-invalid", `Task "${name}": condition on dep "${edge.task}" threw: ${message}`);
			}
		});
		out.set(name, {
			...task,
			deps: active.map((edge) => edge.task),
		});
	}
	return out;
}

/** Throws with the cycle path if the dependency graph (deps + step order) has a cycle. */
export function assertAcyclic(tasks: ReadonlyMap<string, Task>): void {
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];

	const visit = (name: string): void => {
		const s = state.get(name);
		if (s === "done") {
			return;
		}
		if (s === "visiting") {
			const start = stack.indexOf(name);
			const cycle = [
				...stack.slice(start),
				name,
			];
			throw new OutdoError("cycle", `Dependency cycle: ${cycle.join(" -> ")}`, {
				cycle,
			});
		}
		state.set(name, "visiting");
		stack.push(name);
		const task = tasks.get(name);
		if (task) {
			for (const dep of predecessors(task)) {
				visit(dep);
			}
		}
		stack.pop();
		state.set(name, "done");
	};

	for (const name of tasks.keys()) {
		visit(name);
	}
}

/** The transitive dependency closure of the requested tasks (requested included). */
export function subgraphFor(tasks: ReadonlyMap<string, Task>, requested: readonly string[]): Set<string> {
	const result = new Set<string>();
	const visit = (name: string): void => {
		if (result.has(name)) {
			return;
		}
		result.add(name);
		const task = tasks.get(name);
		if (task) {
			for (const dep of task.deps) {
				visit(dep);
			}
		}
	};
	for (const name of requested) {
		visit(name);
	}
	return result;
}

/** Topological order (dependencies and step order first) of a subset of tasks. */
export function topoOrder(tasks: ReadonlyMap<string, Task>, subset: ReadonlySet<string>): string[] {
	const order: string[] = [];
	const done = new Set<string>();
	const visit = (name: string): void => {
		if (done.has(name)) {
			return;
		}
		done.add(name);
		const task = tasks.get(name);
		if (task) {
			for (const dep of predecessors(task)) {
				if (subset.has(dep)) {
					visit(dep);
				}
			}
		}
		order.push(name);
	};
	for (const name of subset) {
		visit(name);
	}
	return order;
}

/** Reverse edges: task -> tasks that depend on it (within the whole map). */
export function dependents(tasks: ReadonlyMap<string, Task>): Map<string, Set<string>> {
	const rev = new Map<string, Set<string>>();
	for (const task of tasks.values()) {
		for (const dep of task.deps) {
			let set = rev.get(dep);
			if (!set) {
				set = new Set();
				rev.set(dep, set);
			}
			set.add(task.name);
		}
	}
	return rev;
}

/**
 * Keep only the steps of `task` between `from` and `until` (inclusive,
 * by step name). Dropped steps leave its deps too, so they are not planned.
 */
export function trimSteps(task: Task, from: string | undefined, until: string | undefined): Task {
	if (from === undefined && until === undefined) {
		return task;
	}
	if (task.steps.length === 0) {
		throw new OutdoError("usage", `--from/--until need a task with steps; "${task.name}" has none.`);
	}
	const prefix = task.name.includes("#") ? task.name.slice(0, task.name.indexOf("#") + 1) : "";
	const indexOf = (step: string, flag: string): number => {
		const at = task.steps.findIndex((s) => s === step || s === `${prefix}${step}` || s.endsWith(`:${step}`));
		if (at === -1) {
			throw new OutdoError(
				"usage",
				`${flag} "${step}" is not a step of "${task.name}". Steps: ${task.steps.join(", ")}.`,
			);
		}
		return at;
	};
	const start = from === undefined ? 0 : indexOf(from, "--from");
	const end = until === undefined ? task.steps.length - 1 : indexOf(until, "--until");
	if (start > end) {
		throw new OutdoError("usage", `--from "${from}" comes after --until "${until}" in "${task.name}".`);
	}
	const kept = new Set(task.steps.slice(start, end + 1));
	const dropped = new Set(task.steps.filter((step) => !kept.has(step)));
	const depEdges = task.depEdges.filter((edge) => edge.step !== true || kept.has(edge.task));
	return {
		...task,
		steps: task.steps.filter((step) => kept.has(step)),
		depEdges,
		deps: task.deps.filter((dep) => !dropped.has(dep) || depEdges.some((edge) => edge.task === dep)),
	};
}

/**
 * Turn `steps` into ordering edges for one run: every task that step k
 * newly brings into the plan waits for step k-1 (the first step waits for
 * the task's own deps). Shared tasks still run once, as early as needed.
 * Returns the plan's task map (copies for every task that gained edges).
 */
export function applySteps(tasks: ReadonlyMap<string, Task>, subset: ReadonlySet<string>): Map<string, Task> {
	const after = new Map<string, Set<string>>();
	const closure = (name: string): Set<string> => {
		const out = new Set<string>();
		const visit = (n: string): void => {
			if (out.has(n) || !subset.has(n)) {
				return;
			}
			out.add(n);
			for (const dep of tasks.get(n)?.deps ?? []) {
				visit(dep);
			}
		};
		visit(name);
		return out;
	};
	for (const name of subset) {
		const task = tasks.get(name);
		if (task === undefined || task.steps.length === 0) {
			continue;
		}
		const declared = task.depEdges.filter((edge) => edge.step !== true && task.deps.includes(edge.task));
		const seen = new Set<string>();
		for (const edge of declared) {
			for (const n of closure(edge.task)) {
				seen.add(n);
			}
		}
		let barrier = [
			...new Set(declared.map((edge) => edge.task)),
		];
		for (const step of task.steps) {
			const fresh = [
				...closure(step),
			].filter((n) => !seen.has(n));
			const freshSet = new Set(fresh);
			for (const n of fresh) {
				const t = tasks.get(n) as Task;
				const isRoot = !t.deps.some((dep) => freshSet.has(dep));
				if (isRoot) {
					let set = after.get(n);
					if (!set) {
						set = new Set();
						after.set(n, set);
					}
					for (const b of barrier) {
						if (b !== n) {
							set.add(b);
						}
					}
				}
				seen.add(n);
			}
			barrier = [
				step,
			];
		}
	}
	const out = new Map(tasks);
	for (const [name, set] of after) {
		const task = out.get(name) as Task;
		out.set(name, {
			...task,
			after: [
				...set,
			].filter((dep) => !task.deps.includes(dep)),
		});
	}
	return out;
}
