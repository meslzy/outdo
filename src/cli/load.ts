/**
 * Shared "find and load the project" step.
 *
 * Single-project mode: the nearest do.ts up from cwd.
 * Workspace mode: cwd is at (or resolves to) a workspace root — the root
 * do.ts (if any) plus every member's do.ts, member tasks qualified as
 * `pkg#task` with file-local deps. --filter selects members; when filters
 * are given, root tasks are excluded (filters select packages).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILENAME, findConfig, loadProject } from "~/core/config";
import { OutdoError } from "~/core/errors";
import { assertAcyclic } from "~/core/graph";
import type { Project, Task } from "~/core/model";
import { applyFilters, enumerateMembers, findWorkspaceRoot } from "~/core/workspaces";

export async function loadProjectFromCwd(filters: readonly string[] = []): Promise<Project> {
	const cwd = process.cwd();
	const configPath = findConfig(cwd);
	const wsRoot = findWorkspaceRoot(cwd);
	const atWorkspaceRoot = wsRoot !== undefined && (configPath === undefined || dirname(configPath) === wsRoot.rootDir);

	if (!atWorkspaceRoot) {
		if (configPath === undefined) {
			throw new OutdoError(
				"config-not-found",
				`No ${CONFIG_FILENAME} found in ${cwd} or any parent directory. Create one with "outdo init".`,
			);
		}
		const project = await loadProject(configPath);
		assertAcyclic(project.tasks);
		return project;
	}

	const members = applyFilters(await enumerateMembers(wsRoot), filters, wsRoot.rootDir);
	const tasks = new Map<string, Task>();

	if (filters.length === 0 && configPath !== undefined) {
		const rootProject = await loadProject(configPath);
		for (const task of rootProject.tasks.values()) {
			tasks.set(task.name, task);
		}
	}

	for (const member of members) {
		const memberConfig = join(member.dir, CONFIG_FILENAME);
		if (!existsSync(memberConfig)) {
			continue;
		}
		const memberProject = await loadProject(memberConfig);
		for (const task of memberProject.tasks.values()) {
			const qualified = `${member.name}#${task.name}`;
			tasks.set(qualified, {
				...task,
				name: qualified,
				deps: task.deps.map((dep) => `${member.name}#${dep}`),
				depEdges: task.depEdges.map((edge) => ({
					...edge,
					task: `${member.name}#${edge.task}`,
				})),
			});
		}
	}

	if (tasks.size === 0) {
		throw new OutdoError(
			"config-not-found",
			`No ${CONFIG_FILENAME} found at the workspace root or in any member package. Create one with "outdo init".`,
		);
	}

	const project: Project = {
		configPath: configPath ?? join(wsRoot.rootDir, "package.json"),
		rootDir: wsRoot.rootDir,
		tasks,
		members,
	};
	assertAcyclic(project.tasks);
	return project;
}
