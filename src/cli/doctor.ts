/**
 * `outdo doctor` — run every task's `requires` checks at once, plus a few
 * repo-level ones (declared git hooks installed). Exit 1 when anything fails.
 */

import { loadProjectFromCwd } from "~/cli/load";
import type { GlobalFlags } from "~/cli/parse";
import { prepareEnv, resolveMode } from "~/cli/plan";
import { EXIT } from "~/core/errors";
import { installedHooks } from "~/core/hookfiles";
import { bold, dim, green, red, yellow } from "~/core/logger";
import { type CheckResult, checkRequires } from "~/core/requires";

export async function doctorCommand(flags: GlobalFlags): Promise<number> {
	const project = await loadProjectFromCwd(flags.filter);
	const mode = resolveMode(project, flags.mode);
	const { envFor } = prepareEnv(project, mode);

	const report: {
		task: string;
		hint: string | undefined;
		checks: CheckResult[];
	}[] = [];
	for (const task of project.tasks.values()) {
		if (task.requires === undefined) {
			continue;
		}
		report.push({
			task: task.name,
			hint: task.requires.hint,
			checks: await checkRequires(task.requires, task.cwd, envFor(task)),
		});
	}
	const hooks =
		project.hooks.size > 0
			? await installedHooks(project.rootDir, [
					...project.hooks.keys(),
				])
			: undefined;
	const missingHooks =
		hooks === undefined
			? []
			: [
					...hooks,
				]
					.filter(([, ok]) => !ok)
					.map(([name]) => name);
	const failed = report.some((entry) => entry.checks.some((c) => !c.ok));

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					ok: !failed,
					mode: mode === "" ? null : mode,
					tasks: report,
					hooks: hooks === undefined ? {} : Object.fromEntries(hooks),
				},
				null,
				2,
			),
		);
		return failed ? EXIT.taskFailure : EXIT.ok;
	}

	if (report.length === 0) {
		console.log(dim('no task declares "requires" — nothing to check'));
	}
	for (const entry of report) {
		const ok = entry.checks.every((c) => c.ok);
		console.log(`${ok ? green("✓") : red("✗")} ${bold(entry.task)}`);
		for (const check of entry.checks) {
			console.log(`    ${check.ok ? green("✓") : red("✗")} ${check.label}`);
		}
		if (!ok && entry.hint !== undefined) {
			console.log(`    ${dim(`→ ${entry.hint}`)}`);
		}
	}
	if (missingHooks.length > 0) {
		console.log(
			`${yellow("!")} git hooks not installed: ${missingHooks.join(", ")} ${dim('— run "outdo hooks install"')}`,
		);
	}
	return failed ? EXIT.taskFailure : EXIT.ok;
}
