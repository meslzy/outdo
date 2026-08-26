/** Pure DAG utilities over the normalized task map. */

import { OutdoError } from "~/core/errors";
import type { DepEdge, Task } from "~/core/model";

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

/** Throws with the cycle path if the dependency graph has a cycle. */
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
			for (const dep of task.deps) {
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

/** Topological order (dependencies first) of a subset of tasks. */
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
			for (const dep of task.deps) {
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
