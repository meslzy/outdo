/** Dependency graph rendering: mermaid (default) or graphviz dot. */

import { loadProjectFromCwd } from "~/cli/load";
import type { GlobalFlags } from "~/cli/parse";
import { EXIT } from "~/core/errors";

export async function graphCommand(dot: boolean, flags: GlobalFlags): Promise<number> {
	const project = await loadProjectFromCwd(flags.filter);
	const tasks = [
		...project.tasks.values(),
	];

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					nodes: tasks.map((t) => t.name),
					edges: tasks.flatMap((t) =>
						t.deps.map((dep) => [
							dep,
							t.name,
						]),
					),
				},
				null,
				2,
			),
		);
		return EXIT.ok;
	}

	const id = (name: string): string => name.replaceAll(/[^A-Za-z0-9_]/g, "_");
	const lines: string[] = [];
	if (dot) {
		lines.push("digraph bundo {");
		lines.push("  rankdir=LR;");
		for (const task of tasks) {
			lines.push(`  ${id(task.name)} [label="${task.name}"${task.persistent ? ", shape=box" : ""}];`);
			for (const dep of task.deps) {
				lines.push(`  ${id(dep)} -> ${id(task.name)};`);
			}
		}
		lines.push("}");
	} else {
		lines.push("flowchart LR");
		for (const task of tasks) {
			const label = task.persistent ? `${id(task.name)}[["${task.name}"]]` : `${id(task.name)}["${task.name}"]`;
			if (task.deps.length === 0) {
				lines.push(`  ${label}`);
			}
			for (const dep of task.deps) {
				lines.push(`  ${id(dep)} --> ${label}`);
			}
		}
	}
	console.log(lines.join("\n"));
	return EXIT.ok;
}
