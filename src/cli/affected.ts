/**
 * `outdo affected <task...>` — answer "did this task's inputs change?" for a
 * workflow, using the task's own `inputs` (no second list of paths to keep in
 * sync). Prints `name=true|false` per task; `--github-output` also appends
 * them to $GITHUB_OUTPUT so later steps can `if:` on them.
 */

import { loadProjectFromCwd } from "~/cli/load";
import type { Command, GlobalFlags } from "~/cli/parse";
import { resolveRequested } from "~/cli/plan";
import { EXIT } from "~/core/errors";
import { detectChanged, selectAffected } from "~/core/gitaffected";
import { writeGithubOutputs } from "~/core/github";
import { dim, yellow } from "~/core/logger";

type AffectedCommand = Extract<
	Command,
	{
		kind: "affected";
	}
>;

/** GitHub output names: letters, digits, `-` and `_`. */
export function outputKey(task: string): string {
	return task.replaceAll(/[^A-Za-z0-9_-]/g, "_");
}

export async function affectedCommand(command: AffectedCommand, flags: GlobalFlags): Promise<number> {
	const project = await loadProjectFromCwd(flags.filter);
	const changed = await detectChanged(project.rootDir, command.base);
	const answers: Record<string, boolean> = {};
	for (const name of command.tasks) {
		// A bare name may fan out over workspace members: affected if any is.
		const { kept } = selectAffected(
			project,
			resolveRequested(project, [
				name,
			]),
			changed,
		);
		answers[name] = kept.length > 0;
	}

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					base: changed.base,
					affected: answers,
				},
				null,
				2,
			),
		);
	} else {
		console.error(dim(`compared with ${changed.base}`));
		for (const [name, value] of Object.entries(answers)) {
			console.log(`${outputKey(name)}=${value}`);
		}
	}

	if (command.githubOutput) {
		const written = writeGithubOutputs(
			Object.fromEntries(
				Object.entries(answers).map(([name, value]) => [
					outputKey(name),
					String(value),
				]),
			),
		);
		if (!written) {
			console.error(yellow("--github-output: $GITHUB_OUTPUT is not set (not running in GitHub Actions)"));
		}
	}
	return EXIT.ok;
}
