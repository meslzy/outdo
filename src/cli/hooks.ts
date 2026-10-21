/**
 * `outdo hooks install | uninstall | list | run <hook>` — git hooks declared
 * in `defineTasks(tasks, { hooks })`. `run` is what the installed hook calls:
 * it runs the hook's task (steps, deps, run) and, with `restage: true`,
 * re-adds the fully staged files the hook changed (formatters).
 */

import { loadProjectFromCwd } from "~/cli/load";
import type { Command, GlobalFlags } from "~/cli/parse";
import { runCommand } from "~/cli/run";
import { EXIT, OutdoError } from "~/core/errors";
import { fullyStagedFiles, installedHooks, installHooks, restage, uninstallHooks } from "~/core/hookfiles";
import { dim, green, yellow } from "~/core/logger";

type HooksCommand = Extract<
	Command,
	{
		kind: "hooks";
	}
>;

export async function hooksCommand(command: HooksCommand, flags: GlobalFlags): Promise<number> {
	if (command.action === "uninstall") {
		const removed = await uninstallHooks(process.cwd());
		console.log(
			removed.length > 0 ? `${green("✓")} removed ${removed.join(", ")}` : dim("no outdo hooks were installed"),
		);
		return EXIT.ok;
	}

	const project = await loadProjectFromCwd();
	const declared = [
		...project.hooks.keys(),
	];

	if (command.action === "install") {
		if (declared.length === 0) {
			throw new OutdoError("usage", 'No hooks declared — add defineTasks(tasks, { hooks: { "pre-commit": ... } }).');
		}
		const result = await installHooks(project.rootDir, declared);
		if (result.unsetHooksPath !== undefined) {
			console.log(
				`${yellow("!")} unset core.hooksPath (was "${result.unsetHooksPath}") — git now runs the outdo hooks; that directory can go`,
			);
		}
		for (const hook of result.backedUp) {
			console.log(dim(`  kept your old ${hook} as ${hook}.pre-outdo`));
		}
		console.log(`${green("✓")} installed ${result.installed.join(", ")}`);
		return EXIT.ok;
	}

	if (command.action === "list") {
		if (declared.length === 0) {
			console.log(dim("no hooks declared in do.ts"));
			return EXIT.ok;
		}
		const installed = await installedHooks(project.rootDir, declared);
		for (const hook of declared) {
			const spec = project.hooks.get(hook);
			const task = spec === undefined ? undefined : project.tasks.get(spec.task);
			const state = installed.get(hook) === true ? green("installed") : yellow("not installed");
			console.log(`  ${hook.padEnd(20)} ${state}  ${dim(task?.desc ?? "")}${spec?.restage ? dim(" (restage)") : ""}`);
		}
		if (
			[
				...installed.values(),
			].some((ok) => !ok)
		) {
			console.log(dim('\nrun "outdo hooks install" to install them'));
		}
		return EXIT.ok;
	}

	// run
	const hook = command.hook as string;
	const spec = project.hooks.get(hook);
	if (spec === undefined) {
		// A stale installed hook for a hook no longer declared: let git proceed.
		console.error(dim(`outdo: no "${hook}" hook declared in do.ts — skipping`));
		return EXIT.ok;
	}
	const before = spec.restage ? await fullyStagedFiles(project.rootDir) : [];
	const code = await runCommand(
		{
			kind: "run",
			tasks: [
				spec.task,
			],
			taskArgv: [],
			rest: command.rest,
		},
		flags,
	);
	if (spec.restage) {
		const added = await restage(project.rootDir, before);
		if (added.length > 0) {
			console.error(dim(`restaged ${added.length} file(s) the hook changed: ${added.join(", ")}`));
		}
	}
	return code;
}
