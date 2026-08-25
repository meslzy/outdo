/** The default command: a grouped, aligned task list. Also `ls --json`. */

import { relative } from "node:path";
import { bold, cyan, dim } from "~/core/logger";
import type { Project, Task } from "~/core/model";

const UNGROUPED = Symbol("ungrouped");

export function renderList(project: Project): string {
	const groups = new Map<string | typeof UNGROUPED, Task[]>();
	for (const task of project.tasks.values()) {
		const key = task.group ?? UNGROUPED;
		const list = groups.get(key);
		if (list) {
			list.push(task);
		} else {
			groups.set(key, [
				task,
			]);
		}
	}

	const width = Math.max(
		0,
		...[
			...project.tasks.keys(),
		].map((n) => n.length),
	);
	const lines: string[] = [];
	const rel = relative(process.cwd(), project.configPath) || project.configPath;
	lines.push(dim(`tasks in ${rel.replaceAll("\\", "/")}`));

	const renderGroup = (title: string | undefined, tasks: Task[]): void => {
		lines.push("");
		if (title !== undefined) {
			lines.push(bold(title));
		}
		for (const task of tasks) {
			const parts = [
				`  ${cyan(task.name.padEnd(width))}`,
			];
			if (task.desc !== undefined) {
				parts.push(`  ${task.desc}`);
			}
			const notes: string[] = [];
			if (task.deps.length > 0) {
				notes.push(`deps: ${task.deps.join(", ")}`);
			}
			if (task.persistent) {
				notes.push("service");
			}
			if (notes.length > 0) {
				parts.push(`  ${dim(`(${notes.join("; ")})`)}`);
			}
			lines.push(parts.join(""));
		}
	};

	for (const [key, tasks] of groups) {
		if (key !== UNGROUPED) {
			renderGroup(key, tasks);
		}
	}
	const ungrouped = groups.get(UNGROUPED);
	if (ungrouped) {
		renderGroup(groups.size > 1 ? "Other" : undefined, ungrouped);
	}

	lines.push("");
	lines.push(dim('run a task with "bundo <task>" — details with "bundo ls --json"'));
	return lines.join("\n");
}

export function listJson(project: Project): unknown {
	return {
		configPath: project.configPath.replaceAll("\\", "/"),
		tasks: [
			...project.tasks.values(),
		].map((task) => ({
			name: task.name,
			desc: task.desc ?? null,
			group: task.group ?? null,
			deps: task.deps,
			args: Object.fromEntries(
				Object.entries(task.args).map(([flag, spec]) => [
					flag,
					{
						type: spec.type,
						short: spec.short ?? null,
						default: spec.default ?? null,
						required: spec.required === true,
						description: spec.description ?? null,
					},
				]),
			),
			hasEnvSchema: task.env !== undefined,
			inputs: task.inputs,
			outputs: task.outputs,
			watch: task.watch,
			persistent: task.persistent,
		})),
	};
}
