/**
 * Shared single-task resolution for commands that target exactly one task
 * (explain, --print-env, completion candidates). A bare name resolves to the
 * root task or, in workspaces, to the unique member task with that local name
 * — matching the run pipeline's fan-out rules without the fan-out.
 */

import { OutdoError } from "~/core/errors";
import type { Project, Task } from "~/core/model";
import { didYouMean } from "~/core/util";

/**
 * Every task a name could refer to: exact match plus workspace local names.
 * Member package.json scripts join a bare name only when the root has no task
 * of that name — a root `build` stays the root build (a root task that wants
 * every package's script depends on `^build`).
 */
export function findTaskMatches(project: Project, name: string): Task[] {
	const matches: Task[] = [];
	const exact = project.tasks.get(name);
	if (exact !== undefined) {
		matches.push(exact);
	}
	if (!name.includes("#")) {
		for (const task of project.tasks.values()) {
			if (task.localName === name && task.name.includes("#") && !(task.kind === "script" && exact !== undefined)) {
				matches.push(task);
			}
		}
	}
	return matches;
}

/** Resolve to exactly one task, or throw a usage/unknown-task error. */
export function resolveSingleTask(project: Project, name: string): Task {
	// An exact name always wins — a root task shadows same-named member tasks
	// for single-task commands (fan-out is the run pipeline's business).
	const exact = project.tasks.get(name);
	if (exact !== undefined) {
		return exact;
	}
	const matches = findTaskMatches(project, name);
	if (matches.length === 1) {
		return matches[0] as Task;
	}
	if (matches.length > 1) {
		throw new OutdoError(
			"usage",
			`"${name}" matches multiple workspace tasks (${matches.map((t) => t.name).join(", ")}). Use the qualified name.`,
		);
	}
	const hint = didYouMean(name, [
		...project.tasks.keys(),
	]);
	throw new OutdoError(
		"unknown-task",
		`Unknown task "${name}".${hint === undefined ? "" : ` Did you mean "${hint}"?`} Run "outdo" to list tasks.`,
		{
			task: name,
		},
	);
}
