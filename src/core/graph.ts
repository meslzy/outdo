/** Pure DAG utilities over the normalized task map. */

import { BundoError } from "~/core/errors";
import type { Task } from "~/core/model";

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
			throw new BundoError("cycle", `Dependency cycle: ${cycle.join(" -> ")}`, {
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
