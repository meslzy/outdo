/** Env explain mode: cascade provenance + schema validation, never runs. */

import { loadProjectFromCwd } from "~/cli/load";
import type { GlobalFlags } from "~/cli/parse";
import { resolveEnv, validateTaskEnv } from "~/core/envresolve";
import { BundoError, EXIT } from "~/core/errors";
import { bold, cyan, dim, green, red } from "~/core/logger";
import { didYouMean } from "~/core/util";

export async function printEnvCommand(taskName: string, flags: GlobalFlags): Promise<number> {
	const project = await loadProjectFromCwd(flags.filter);
	const task = project.tasks.get(taskName);
	if (task === undefined) {
		const hint = didYouMean(taskName, [
			...project.tasks.keys(),
		]);
		throw new BundoError(
			"unknown-task",
			`Unknown task "${taskName}".${hint === undefined ? "" : ` Did you mean "${hint}"?`}`,
		);
	}

	const resolved = resolveEnv(project.rootDir);
	const validation = await validateTaskEnv(task, resolved.env);
	const ok = validation.issues.length === 0;

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					task: task.name,
					loadedFiles: resolved.loadedFiles,
					env: Object.fromEntries(
						[
							...resolved.keys.entries(),
						].map(([key, entry]) => [
							key,
							{
								value: entry.value,
								source: entry.source,
								overrides: entry.overrides,
							},
						]),
					),
					validation: {
						ok,
						issues: validation.issues.map((issue) => ({
							path: issue.path,
							message: issue.message,
						})),
					},
				},
				null,
				2,
			),
		);
		return ok ? EXIT.ok : EXIT.config;
	}

	console.log(bold(`env for task "${task.name}"`));
	console.log(
		dim(
			resolved.loadedFiles.length > 0
				? `loaded: ${resolved.loadedFiles.join(" -> ")} (process env wins)`
				: "no .env files found",
		),
	);
	if (resolved.keys.size > 0) {
		console.log("");
		const width = Math.max(
			...[
				...resolved.keys.keys(),
			].map((k) => k.length),
		);
		for (const [key, entry] of resolved.keys) {
			const overridden = entry.overrides.length > 0 ? dim(` (overrides ${entry.overrides.join(", ")})`) : "";
			console.log(`  ${cyan(key.padEnd(width))}  ${entry.value}  ${dim(`<- ${entry.source}`)}${overridden}`);
		}
	}

	console.log("");
	if (task.env === undefined) {
		console.log(dim("no env schema declared for this task"));
		return EXIT.ok;
	}
	if (ok) {
		console.log(`${green("✓")} schema valid`);
		return EXIT.ok;
	}
	console.log(`${red("✗")} schema invalid:`);
	for (const issue of validation.issues) {
		console.log(`    ${issue.path === "" ? "" : `${cyan(issue.path)} — `}${issue.message}`);
	}
	return EXIT.config;
}
