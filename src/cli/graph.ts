/** Dependency graph rendering: mermaid (default) or graphviz dot. */

import { loadProjectFromCwd } from "~/cli/load";
import type { GlobalFlags } from "~/cli/parse";
import { EXIT } from "~/core/errors";
import type { DepEdge } from "~/core/model";

function edgeLabel(edge: DepEdge): string | undefined {
	const parts: string[] = [];
	if (edge.condition !== undefined) {
		parts.push(typeof edge.condition === "string" ? `if ${edge.condition}` : "if <fn>");
	}
	if (edge.optional) {
		parts.push("optional");
	}
	return parts.length > 0 ? parts.join(", ") : undefined;
}

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
						t.depEdges.map((edge) => ({
							from: edge.task,
							to: t.name,
							...(edge.condition !== undefined
								? {
										if: typeof edge.condition === "string" ? edge.condition : "<fn>",
									}
								: {}),
							...(edge.optional
								? {
										optional: true,
									}
								: {}),
						})),
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
			for (const edge of task.depEdges) {
				const label = edgeLabel(edge);
				const attrs = label !== undefined ? ` [style=dashed, label="${label}"]` : "";
				lines.push(`  ${id(edge.task)} -> ${id(task.name)}${attrs};`);
			}
		}
		lines.push("}");
	} else {
		lines.push("flowchart LR");
		for (const task of tasks) {
			const label = task.persistent ? `${id(task.name)}[["${task.name}"]]` : `${id(task.name)}["${task.name}"]`;
			if (task.depEdges.length === 0) {
				lines.push(`  ${label}`);
			}
			for (const edge of task.depEdges) {
				const note = edgeLabel(edge);
				const arrow = note !== undefined ? `-.->|${note}|` : "-->";
				lines.push(`  ${id(edge.task)} ${arrow} ${label}`);
			}
		}
	}
	console.log(lines.join("\n"));
	return EXIT.ok;
}
