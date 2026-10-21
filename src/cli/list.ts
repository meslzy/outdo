/** The default command: a grouped, aligned task list. Also `ls --json`. */

import { relative } from "node:path";
import { SUBCOMMANDS } from "~/cli/parse";
import { bold, cyan, dim } from "~/core/logger";
import type { Project, Task } from "~/core/model";

const UNGROUPED = Symbol("ungrouped");

function notesFor(task: Task): string[] {
	const notes: string[] = [];
	if (task.steps.length > 0) {
		notes.push(`steps: ${task.steps.join(" → ")}`);
	}
	const steps = new Set(task.steps);
	const deps = task.deps.filter((dep) => !steps.has(dep));
	if (deps.length > 0) {
		notes.push(`deps: ${deps.join(", ")}`);
	}
	if (task.persistent) {
		notes.push("service");
	}
	if (task.confirm !== undefined || task.protect.length > 0) {
		notes.push(task.protect.length > 0 && !task.protect.includes("*") ? `asks in ${task.protect.join("/")}` : "asks");
	}
	if (task.readonly) {
		notes.push("read-only");
	}
	if (task.destructive) {
		notes.push("destructive");
	}
	if (SUBCOMMANDS.has(task.name)) {
		notes.push(`run with "outdo run ${task.name}"`);
	}
	return notes;
}

/**
 * Root tasks (do.ts first, then package.json scripts) by group; workspace
 * members as one compact line each. `namespace` limits the list to `ns:*`.
 */
export function renderList(project: Project, namespace?: string): string {
	const visible = [
		...project.tasks.values(),
	].filter((task) => task.kind !== "hook" && (namespace === undefined || task.localName.startsWith(`${namespace}:`)));
	const rootTasks = visible.filter((task) => !task.name.includes("#"));
	const memberTasks = visible.filter((task) => task.name.includes("#"));

	const groups = new Map<string | typeof UNGROUPED, Task[]>();
	for (const task of rootTasks) {
		const key = task.group ?? (task.kind === "script" ? "package.json" : UNGROUPED);
		const list = groups.get(key);
		if (list) {
			list.push(task);
		} else {
			groups.set(key, [
				task,
			]);
		}
	}

	const width = Math.max(0, ...rootTasks.map((t) => t.name.length));
	const lines: string[] = [];
	const rel = relative(process.cwd(), project.configPath) || project.configPath;
	const header = namespace !== undefined ? `${namespace} tasks in ${rel}` : `tasks in ${rel}`;
	lines.push(
		dim(`${header.replaceAll("\\", "/")}${project.modes.length > 0 ? ` · modes: ${project.modes.join(", ")}` : ""}`),
	);

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
			const notes = notesFor(task);
			if (notes.length > 0) {
				parts.push(`  ${dim(`(${notes.join("; ")})`)}`);
			}
			lines.push(parts.join(""));
		}
	};

	const scripts = groups.get("package.json");
	for (const [key, tasks] of groups) {
		if (key !== UNGROUPED && key !== "package.json") {
			renderGroup(key, tasks);
		}
	}
	const ungrouped = groups.get(UNGROUPED);
	if (ungrouped) {
		renderGroup(groups.size > 1 ? "Other" : undefined, ungrouped);
	}
	if (scripts) {
		renderGroup("package.json", scripts);
	}

	if (memberTasks.length > 0) {
		const byPackage = new Map<string, string[]>();
		for (const task of memberTasks) {
			const pkg = task.name.slice(0, task.name.indexOf("#"));
			const list = byPackage.get(pkg) ?? [];
			list.push(task.localName);
			byPackage.set(pkg, list);
		}
		const pkgWidth = Math.max(
			...[
				...byPackage.keys(),
			].map((p) => p.length),
		);
		lines.push("");
		lines.push(bold("Workspaces"));
		for (const [pkg, names] of byPackage) {
			lines.push(`  ${cyan(pkg.padEnd(pkgWidth))}  ${names.join(", ")}`);
		}
	}

	if (project.hooks.size > 0 && namespace === undefined) {
		lines.push("");
		lines.push(
			dim(
				`git hooks: ${[
					...project.hooks.keys(),
				].join(", ")} — install with "outdo hooks install"`,
			),
		);
	}

	lines.push("");
	lines.push(
		dim(
			memberTasks.length > 0
				? 'run a task with "outdo <task>" (every package) or "outdo <pkg>#<task>" — details with "outdo ls --json"'
				: 'run a task with "outdo <task>" — details with "outdo ls --json"',
		),
	);
	return lines.join("\n");
}

export function listJson(project: Project): unknown {
	return {
		configPath: project.configPath.replaceAll("\\", "/"),
		modes: project.modes,
		hooks: [
			...project.hooks.keys(),
		],
		tasks: [
			...project.tasks.values(),
		]
			.filter((task) => task.kind !== "hook")
			.map((task) => ({
				name: task.name,
				kind: task.kind,
				desc: task.desc ?? null,
				group: task.group ?? null,
				deps: task.deps,
				steps: task.steps,
				finally: task.finally,
				args: Object.fromEntries(
					Object.entries(task.args).map(([flag, def]) => [
						flag,
						{
							type: def.type,
							short: def.short ?? null,
							default: def.default ?? null,
							required: def.required,
							description: def.description ?? null,
							choices: def.choices ?? null,
							schema: def.schema !== undefined,
						},
					]),
				),
				positional: task.positional,
				hasEnvSchema: task.env !== undefined,
				command: task.command ?? null,
				script: task.script ?? null,
				inputs: task.inputs,
				outputs: task.outputs,
				watch: task.watch,
				persistent: task.persistent,
				readonly: task.readonly,
				destructive: task.destructive,
				protect: task.protect,
				confirm: task.confirm ?? null,
			})),
	};
}
