/** The run pipeline. M2: sequential in-process execution in topo order. */

import { loadProjectFromCwd } from "~/cli/load";
import type { Command, GlobalFlags } from "~/cli/parse";
import { parseTaskArgs, renderTaskHelp, wantsTaskHelp } from "~/core/argspec";
import { resolveEnv, validateAll } from "~/core/envresolve";
import { BundoError, EXIT } from "~/core/errors";
import { buildCtx, runTaskInProcess } from "~/core/executor";
import { subgraphFor, topoOrder } from "~/core/graph";
import { dim, green, red } from "~/core/logger";
import type { Project, Task } from "~/core/model";
import { didYouMean } from "~/core/util";

type RunCommand = Extract<
	Command,
	{
		kind: "run";
	}
>;

export async function runCommand(command: RunCommand, flags: GlobalFlags): Promise<number> {
	const project = await loadProjectFromCwd();
	const requested = resolveRequested(project, command.tasks);

	// Per-task flags only make sense for a single task.
	if (command.taskArgv.length > 0 && requested.length !== 1) {
		throw new BundoError("usage", "Task flags require exactly one task on the command line.");
	}
	const target = requested[0] as Task;
	if (command.taskArgv.length > 0 && wantsTaskHelp(target, command.taskArgv)) {
		console.log(renderTaskHelp(target));
		return EXIT.ok;
	}
	const targetArgs = requested.length === 1 ? parseTaskArgs(target, command.taskArgv) : {};

	// Env: resolve once, apply the dotenv cascade to this process (process env
	// wins), and validate every schema in the plan before anything runs.
	const resolved = resolveEnv(project.rootDir);
	for (const [key, entry] of resolved.keys) {
		if (entry.source !== "process" && process.env[key] === undefined) {
			process.env[key] = entry.value;
		}
	}
	const subset = subgraphFor(
		project.tasks,
		requested.map((t) => t.name),
	);
	const order = topoOrder(project.tasks, subset);
	const planned = order.map((name) => project.tasks.get(name) as Task);
	const envOutputs = await validateAll(planned, resolved.env);

	if (flags.dry !== false) {
		return printDryRun(planned, requested, flags);
	}

	// Ctrl-C: abort the current task, exit 130. A second Ctrl-C exits hard.
	const aborter = new AbortController();
	let interrupted = false;
	const onSigint = (): void => {
		if (interrupted) {
			process.exit(EXIT.interrupted);
		}
		interrupted = true;
		aborter.abort(new BundoError("interrupted", "Interrupted."));
	};
	process.on("SIGINT", onSigint);

	const requestedNames = new Set(requested.map((t) => t.name));
	try {
		for (const task of planned) {
			if (interrupted) {
				throw new BundoError("interrupted", "Interrupted.");
			}
			const isRequested = requestedNames.has(task.name);
			const started = performance.now();
			const ctx = buildCtx(task, {
				env: envOutputs.get(task.name) ?? resolved.env,
				shellEnv: resolved.env,
				args: isRequested && task === target ? targetArgs : applyDefaults(task),
				rest: isRequested ? command.rest : [],
				signal: aborter.signal,
			});
			await runTaskInProcess(task, ctx);
			const ms = Math.round(performance.now() - started);
			console.error(`${green("✓")} ${task.name} ${dim(`(${ms}ms)`)}`);
		}
	} catch (error) {
		if (error instanceof BundoError && error.code === "task-failed") {
			console.error(
				`${red("✗")} ${String(
					(
						error.detail as
							| {
									task?: string;
							  }
							| undefined
					)?.task ?? "",
				)}`.trimEnd(),
			);
		}
		throw error;
	} finally {
		process.off("SIGINT", onSigint);
	}
	return EXIT.ok;
}

function resolveRequested(project: Project, names: string[]): Task[] {
	if (names.length === 0) {
		throw new BundoError("usage", "No task given.");
	}
	return names.map((name) => {
		const task = project.tasks.get(name);
		if (task === undefined) {
			const hint = didYouMean(name, [
				...project.tasks.keys(),
			]);
			throw new BundoError(
				"unknown-task",
				`Unknown task "${name}".${hint === undefined ? "" : ` Did you mean "${hint}"?`} Run "bundo" to list tasks.`,
				{
					task: name,
				},
			);
		}
		return task;
	});
}

function applyDefaults(task: Task): Record<string, string | boolean | undefined> {
	const out: Record<string, string | boolean | undefined> = {};
	for (const [flag, spec] of Object.entries(task.args)) {
		out[flag] = spec.default ?? (spec.type === "boolean" ? false : undefined);
	}
	return out;
}

function printDryRun(planned: Task[], requested: Task[], flags: GlobalFlags): number {
	const requestedNames = new Set(requested.map((t) => t.name));
	if (flags.dry === "json") {
		console.log(
			JSON.stringify(
				{
					plan: planned.map((task) => ({
						name: task.name,
						requested: requestedNames.has(task.name),
						deps: task.deps,
						persistent: task.persistent,
						hasRun: task.run !== undefined,
					})),
				},
				null,
				2,
			),
		);
	} else {
		console.log(dim("plan (dependencies first):"));
		for (const task of planned) {
			const marker = requestedNames.has(task.name) ? "*" : " ";
			console.log(`  ${marker} ${task.name}${task.persistent ? dim(" (service)") : ""}`);
		}
		console.log(dim("* requested — nothing was run (--dry)"));
	}
	return EXIT.ok;
}
