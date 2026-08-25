/**
 * The run pipeline.
 *
 * Backend choice (automatic):
 * - in-process sequential — pure dependency chains with no services and no
 *   --isolate: zero spawn overhead, stdio fully inherited (TTY colors,
 *   interactive prompts work).
 * - child processes — anything that can parallelize, contains a persistent
 *   service, or was forced with --isolate: piped stdio, prefixed multiplexed
 *   output, cooperative abort + tree kill.
 */

import { loadProjectFromCwd } from "~/cli/load";
import type { Command, GlobalFlags } from "~/cli/parse";
import { parseTaskArgs, renderTaskHelp, wantsTaskHelp } from "~/core/argspec";
import { startChildTask } from "~/core/child";
import { resolveEnv, validateAll } from "~/core/envresolve";
import { BundoError, EXIT } from "~/core/errors";
import { buildCtx, runTaskInProcess } from "~/core/executor";
import { subgraphFor, topoOrder } from "~/core/graph";
import { Lifecycle } from "~/core/lifecycle";
import { dim, green, red, yellow } from "~/core/logger";
import type { Project, Task } from "~/core/model";
import { OutputMultiplexer } from "~/core/output";
import type { TaskResult } from "~/core/scheduler";
import { isChain, schedule } from "~/core/scheduler";
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

	const requestedNames = new Set(requested.map((t) => t.name));
	const hasServices = planned.some((task) => task.persistent);
	const sequentialOk = !flags.isolate && !hasServices && isChain(project.tasks, order);

	const shared: SharedRunState = {
		project,
		planned,
		requestedNames,
		target,
		targetArgs,
		rest: command.rest,
		shellEnv: resolved.env,
		envOutputs,
	};
	return sequentialOk ? await runSequential(shared) : await runParallel(shared, flags);
}

interface SharedRunState {
	project: Project;
	planned: Task[];
	requestedNames: Set<string>;
	target: Task;
	targetArgs: Record<string, string | boolean | undefined>;
	rest: string[];
	shellEnv: Record<string, string | undefined>;
	envOutputs: ReadonlyMap<string, unknown>;
}

function argsFor(state: SharedRunState, task: Task): Record<string, string | boolean | undefined> {
	return task === state.target ? state.targetArgs : applyDefaults(task);
}

function restFor(state: SharedRunState, task: Task): string[] {
	return state.requestedNames.has(task.name) ? state.rest : [];
}

// ---------------------------------------------------------------------------
// Sequential (in-process) backend
// ---------------------------------------------------------------------------

async function runSequential(state: SharedRunState): Promise<number> {
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

	try {
		for (const task of state.planned) {
			if (interrupted) {
				throw new BundoError("interrupted", "Interrupted.");
			}
			const started = performance.now();
			const ctx = buildCtx(task, {
				env: state.envOutputs.get(task.name) ?? state.shellEnv,
				shellEnv: state.shellEnv,
				args: argsFor(state, task),
				rest: restFor(state, task),
				signal: aborter.signal,
			});
			await runTaskInProcess(task, ctx);
			const ms = Math.round(performance.now() - started);
			console.error(`${green("✓")} ${task.name} ${dim(`(${ms}ms)`)}`);
		}
	} finally {
		process.off("SIGINT", onSigint);
	}
	return EXIT.ok;
}

// ---------------------------------------------------------------------------
// Parallel (child-process) backend
// ---------------------------------------------------------------------------

async function runParallel(state: SharedRunState, flags: GlobalFlags): Promise<number> {
	const isTty = process.stdout.isTTY === true;
	const logOrder = flags.logOrder === "auto" ? (isTty ? "stream" : "grouped") : flags.logOrder;
	const concurrency = flags.concurrency ?? Math.max(1, navigator.hardwareConcurrency ?? 4);
	const mux = new OutputMultiplexer(
		logOrder,
		flags.outputLogs,
		state.planned.map((t) => t.name),
	);
	const lifecycle = new Lifecycle();

	let interrupted = false;
	const onSigint = (): void => {
		if (interrupted) {
			lifecycle.killAll();
			process.exit(EXIT.interrupted);
		}
		interrupted = true;
		console.error(dim("interrupt — stopping tasks (Ctrl-C again to force)"));
		void lifecycle.shutdown();
	};
	process.on("SIGINT", onSigint);

	try {
		const outcome = await schedule({
			tasks: state.project.tasks,
			planned: state.planned.map((t) => t.name),
			concurrency,
			continueOnError: flags.continueOnError,
			start: (task) => {
				const started = startChildTask(task, {
					configPath: state.project.configPath,
					shellEnv: state.shellEnv,
					envOutputs: state.envOutputs,
					argsFor: (t) => argsFor(state, t),
					restFor: (t) => restFor(state, t),
					sinkFor: () => mux.sink(task.name),
					lifecycle,
				});
				void started.result.then((result) => printStatus(task, result));
				return started;
			},
			onAbort: () => lifecycle.shutdown(),
		});

		if (interrupted) {
			throw new BundoError("interrupted", "Interrupted.");
		}

		const failedResults = [
			...outcome.results.values(),
		].filter((r) => r.status === "failed");
		if (failedResults.length > 0 || outcome.failed) {
			printSummary(outcome.results);
			throw new BundoError("task-failed", failureMessage(failedResults), {
				failed: failedResults.map((r) => ({
					task: r.name,
					error: r.error,
				})),
			});
		}

		// Services keep the run alive until Ctrl-C or a service exits by itself.
		if (outcome.services.size > 0) {
			const exited = await Promise.race(outcome.services.values());
			if (interrupted || lifecycle.shuttingDown) {
				throw new BundoError("interrupted", "Interrupted.");
			}
			await lifecycle.shutdown();
			throw new BundoError(
				"task-failed",
				`Service "${exited.name}" exited unexpectedly (${exited.error ?? "no error"}).`,
				{
					task: exited.name,
				},
			);
		}

		printSummary(outcome.results);
		return EXIT.ok;
	} finally {
		process.off("SIGINT", onSigint);
	}
}

function printStatus(task: Task, result: TaskResult): void {
	if (result.status === "ok" && !task.persistent) {
		console.error(`${green("✓")} ${task.name} ${dim(`(${result.durationMs}ms)`)}`);
	} else if (result.status === "failed") {
		console.error(`${red("✗")} ${task.name} ${dim(`(${result.durationMs}ms)`)} ${result.error ?? ""}`.trimEnd());
	}
}

function printSummary(results: ReadonlyMap<string, TaskResult>): void {
	const all = [
		...results.values(),
	];
	const ok = all.filter((r) => r.status === "ok").length;
	const failed = all.filter((r) => r.status === "failed").length;
	const skipped = all.filter((r) => r.status === "skipped" || r.status === "aborted").length;
	const parts = [
		`${ok} ok`,
	];
	if (failed > 0) {
		parts.push(red(`${failed} failed`));
	}
	if (skipped > 0) {
		parts.push(yellow(`${skipped} skipped`));
	}
	console.error(dim(`— ${parts.join(", ")}`));
}

function failureMessage(failed: TaskResult[]): string {
	if (failed.length === 1) {
		const one = failed[0] as TaskResult;
		// Worker errors are already prefixed with the task name.
		return one.error ?? `Task "${one.name}" failed.`;
	}
	return `${failed.length} tasks failed: ${failed.map((r) => r.name).join(", ")}`;
}

// ---------------------------------------------------------------------------

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
