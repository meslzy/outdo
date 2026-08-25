/** Shared "find and load the project" step used by most commands. */

import { CONFIG_FILENAME, findConfig, loadProject } from "~/core/config";
import { BundoError } from "~/core/errors";
import { assertAcyclic } from "~/core/graph";
import type { Project } from "~/core/model";

export async function loadProjectFromCwd(): Promise<Project> {
	const configPath = findConfig(process.cwd());
	if (configPath === undefined) {
		throw new BundoError(
			"config-not-found",
			`No ${CONFIG_FILENAME} found in ${process.cwd()} or any parent directory. Create one with "bundo init".`,
		);
	}
	const project = await loadProject(configPath);
	assertAcyclic(project.tasks);
	return project;
}
