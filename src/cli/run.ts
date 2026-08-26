/**
 * The run pipeline.
 *
 * Backend choice (automatic):
 * - in-process sequential — pure dependency chains with no services and no
 *   --isolate/--json: zero spawn overhead, stdio fully inherited (TTY colors,
 *   interactive prompts work).
 * - child processes — anything that can parallelize, contains a persistent
 *   service, was forced with --isolate, or emits a --json run report: piped
 *   stdio, prefixed multiplexed output, cooperative abort + tree kill.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadProjectFromCwd } from "~/cli/load";
import type { Command, GlobalFlags } from "~/cli/parse";
import { parseTaskArgs, renderTaskHelp, wantsTaskHelp } from "~/core/argspec";
import type { CacheDecision } from "~/core/cache";
import { cacheable, checkCache, writeCache } from "~/core/cache";
import { startChildTask } from "~/core/child";
import { resolveEnv, validateAll } from "~/core/envresolve";
import { EXIT, OutdoError } from "~/core/errors";
import { buildCtx, runTaskInProcess } from "~/core/executor";
import type { ChangedResult } from "~/core/gitaffected";
import { detectChanged, selectAffected } from "~/core/gitaffected";
import { applyConditions, subgraphFor, topoOrder } from "~/core/graph";
import { Lifecycle } from "~/core/lifecycle";
import { dim, green, red, yellow } from "~/core/logger";
import type { Project, Task } from "~/core/model";
import { OutputMultiplexer } from "~/core/output";
import type { RunReport } from "~/core/report";
import { buildReport, formatSummary, toChromeTrace } from "~/core/report";
import { retryDelayMs, sleepAbortable } from "~/core/retry";
import type { StartedTask, TaskResult } from "~/core/scheduler";
import { isChain, schedule } from "~/core/scheduler";
import { didYouMean } from "~/core/util";

type RunCommand = Extract<
	Command,
	{
		kind: "run";
	}
>;

interface AffectedInfo {
	base: string;
	kept: string[];
	dropped: string[];
}

export async function runCommand(command: RunCommand, flags: GlobalFlags): Promise<number> {
	if (flags.watch && flags.json) {
		throw new OutdoError("usage", "--watch cannot be combined with --json (watch is a streaming mode).");
	}
	if (flags.watch && flags.profile !== false) {
		throw new OutdoError("usage", "--watch cannot be combined with --profile.");
	}
	if (flags.watch && flags.affected !== false) {
		throw new OutdoError("usage", "--watch cannot be combined with --affected.");
	}

	const loaded = await loadProjectFromCwd(flags.filter);

	// Env: resolve once, apply the dotenv cascade to this process (process env
	// wins), then evaluate conditional dep edges against the resolved env.
	const resolved = resolveEnv(loaded.rootDir);
	for (const [key, entry] of resolved.keys) {
		if (entry.source !== "process" && process.env[key] === undefined) {
			process.env[key] = entry.value;
		}
	}
	const project: Project = {
		...loaded,
		tasks: applyConditions(loaded.tasks, resolved.env),
	};

	const requestedAll = resolveRequested(project, command.tasks);

	// Per-task flags only make sense for a single task — validated against
	// what the user *asked for*, before --affected filtering: a dropped task
	// must not silently reroute flags, and a --dry preview must not turn into
	// a usage error just because git dropped the target.
	if (command.taskArgv.length > 0 && requestedAll.length !== 1) {
		throw new OutdoError("usage", "Task flags require exactly one task on the command line.");
	}
	const target = requestedAll.length === 1 ? (requestedAll[0] as Task) : undefined;
	if (target !== undefined && command.taskArgv.length > 0 && wantsTaskHelp(target, command.taskArgv)) {
		console.log(renderTaskHelp(target));
		return EXIT.ok;
	}
	const targetArgs = target !== undefined ? parseTaskArgs(target, command.taskArgv) : {};

	// Git-aware selection: keep only tasks affected vs the base rev.
	let requested = requestedAll;
	let affectedInfo: AffectedInfo | undefined;
	if (flags.affected !== false) {
		const changed: ChangedResult = await detectChanged(project.rootDir, flags.affected.base);
		const { kept, dropped } = selectAffected(project, requested, changed);
		affectedInfo = {
			base: changed.base,
			kept: kept.map((t) => t.name),
			dropped: dropped.map((t) => t.name),
		};
		console.error(dim(`affected vs ${changed.base}: running ${kept.length} of ${requested.length} requested task(s)`));
		if (kept.length === 0 && flags.dry === false) {
			return EXIT.ok;
		}
		requested = kept;
	}

	// Validate every schema in the plan before anything runs.
	const subset = subgraphFor(
		project.tasks,
		requested.map((t) => t.name),
	);
	const order = topoOrder(project.tasks, subset);
	const planned = order.map((name) => project.tasks.get(name) as Task);
	const envOutputs = await validateAll(planned, resolved.env);

	const requestedNames = new Set(requested.map((t) => t.name));
	const shared: SharedRunState = {
		project,
		planned,
		requestedNames,
		target,
		targetArgs,
		rest: command.rest,
		shellEnv: resolved.env,
		envOutputs,
		subset,
		fingerprints: new Map(),
		outputs: new Map(),
		force: flags.force,
	};

	if (flags.dry !== false) {
		if (flags.profile !== false) {
			console.error(dim("--profile ignored under --dry (nothing was run)"));
		}
		// Preview pass on the current disk state (real decisions happen at
		// task start, after dependencies have produced their outputs).
		const decisions = new Map<string, CacheDecision>();
		for (const task of planned) {
			const decision = await decideCache(shared, task);
			if (cacheable(task)) {
				decisions.set(task.name, decision);
				if (decision.hit) {
					// Seed replayed outputs so downstream previews compose.
					shared.outputs.set(task.name, decision.previousOutput);
				}
			}
		}
		shared.fingerprints.clear();
		shared.outputs.clear();
		return printDryRun(planned, requested, flags, decisions, affectedInfo);
	}

	if (flags.watch) {
		const { runWatch } = await import("~/cli/watch-run");
		return await runWatch(shared, flags);
	}
	return usesSequentialBackend(project.tasks, order, planned, flags)
		? await runSequential(shared)
		: await runParallel(shared, flags);
}

/**
 * Backend choice, shared with `outdo explain` so its prediction can never
 * drift from the real run. Timeouts need the child backend to be enforceable
 * (in-process abort is cooperative only — a run body that ignores ctx.signal
 * would hang the whole run forever); output-shaping flags need the
 * multiplexer.
 */
export function usesSequentialBackend(
	tasks: ReadonlyMap<string, Task>,
	order: readonly string[],
	planned: readonly Task[],
	flags: GlobalFlags,
): boolean {
	const hasServices = planned.some((task) => task.persistent);
	const hasTimeouts = planned.some((task) => task.timeoutMs !== undefined);
	const wantsMultiplexed =
		flags.json || flags.profile !== false || flags.logOrder !== "auto" || flags.outputLogs !== "full";
	return !flags.isolate && !wantsMultiplexed && !hasServices && !hasTimeouts && isChain(tasks, order);
}

export interface SharedRunState {
	project: Project;
	planned: Task[];
	requestedNames: Set<string>;
	/** The single requested task carrying parsed CLI flags (multi-task runs: none). */
	target: Task | undefined;
	targetArgs: Record<string, string | boolean | undefined>;
	rest: string[];
	shellEnv: Record<string, string | undefined>;
	envOutputs: ReadonlyMap<string, unknown>;
	subset: ReadonlySet<string>;
	/** Fingerprints recorded as tasks start (deps always precede dependents). */
	fingerprints: Map<string, string>;
	/** Data outputs recorded as tasks finish (or replay from cache). */
	outputs: Map<string, unknown>;
	force: boolean;
}

function argsFor(state: SharedRunState, task: Task): Record<string, string | boolean | undefined> {
	return task === state.target ? state.targetArgs : applyDefaults(task);
}

function restFor(state: SharedRunState, task: Task): string[] {
	return state.requestedNames.has(task.name) ? state.rest : [];
}

/** ctx.deps keys use the author's local dep names (unqualified for members). */
function depsDataFor(state: SharedRunState, task: Task): Record<string, unknown> {
	const hash = task.name.indexOf("#");
	const prefix = hash === -1 ? undefined : task.name.slice(0, hash + 1);
	const out: Record<string, unknown> = {};
	for (const dep of task.deps) {
		if (!state.subset.has(dep)) {
			continue;
		}
		const local = prefix !== undefined && dep.startsWith(prefix) ? dep.slice(prefix.length) : dep;
		out[local] = state.outputs.get(dep);
	}
	return out;
}

/**
 * Build the scheduler `start` function shared by plain parallel runs and
 * watch mode. The cache decision is async (hashing) but the scheduler expects
 * a synchronous start — bridged with a promise of the started task. Retries
 * wrap the whole child attempt (fresh worker, sink, and timeout per attempt).
 */
export function makeStart(
	state: SharedRunState,
	mux: OutputMultiplexer,
	lifecycleFor: (task: Task) => Lifecycle,
): (task: Task) => StartedTask {
	return (task) => {
		const startedP: Promise<StartedTask> = (async (): Promise<StartedTask> => {
			const decision = await decideCache(state, task);
			// A shutdown (Ctrl-C, fail-fast, watch supersede) that completed while
			// we were hashing must not be followed by a fresh spawn the shutdown
			// snapshot never saw.
			if (lifecycleFor(task).shuttingDown) {
				const result: TaskResult = {
					name: task.name,
					status: "aborted",
					durationMs: 0,
				};
				return {
					unblocked: Promise.resolve(),
					result: Promise.resolve(result),
				} satisfies StartedTask;
			}
			if (cacheable(task) && decision.hit) {
				const now = performance.now();
				state.outputs.set(task.name, decision.previousOutput);
				const result: TaskResult = {
					name: task.name,
					status: "ok",
					durationMs: 0,
					startedAt: now,
					endedAt: now,
					cached: true,
					...(decision.previousOutput !== undefined
						? {
								output: decision.previousOutput,
							}
						: {}),
				};
				console.error(`${green("✓")} ${task.name} ${dim("(cached)")}`);
				return {
					unblocked: Promise.resolve(),
					result: Promise.resolve(result),
				} satisfies StartedTask;
			}

			const lifecycle = lifecycleFor(task);
			let current: StartedTask | undefined;
			const attemptOnce = (): StartedTask =>
				startChildTask(task, {
					configPath: state.project.configPath,
					shellEnv: state.shellEnv,
					envOutputs: state.envOutputs,
					argsFor: (t) => argsFor(state, t),
					restFor: (t) => restFor(state, t),
					depsFor: (t) => depsDataFor(state, t),
					sinkFor: (t, onLine) => mux.sink(t.name, onLine),
					lifecycle,
				});

			const max = task.retry?.attempts ?? 1;
			const attempts = (async (): Promise<TaskResult> => {
				for (let attempt = 1; ; attempt++) {
					const started = attemptOnce();
					current = started;
					const result = await started.result;
					if (result.status !== "failed" || attempt >= max || lifecycle.shuttingDown) {
						return max > 1
							? {
									...result,
									attempts: attempt,
								}
							: result;
					}
					const delay = retryDelayMs(task.retry as NonNullable<Task["retry"]>, attempt);
					console.error(
						`${yellow("↻")} ${task.name} failed — retrying (attempt ${attempt + 1}/${max})${delay > 0 ? dim(` in ${delay}ms`) : ""}`,
					);
					if (delay > 0 && !(await sleepAbortable(delay, lifecycle.signal))) {
						return {
							...result,
							status: "aborted",
							attempts: attempt,
						};
					}
					if (lifecycle.shuttingDown) {
						return {
							...result,
							status: "aborted",
							attempts: attempt,
						};
					}
				}
			})();

			const finalized = attempts.then(async (result) => {
				if (result.status === "ok") {
					state.outputs.set(task.name, result.output);
					if (cacheable(task)) {
						await writeCache(state.project.rootDir, task, decision, result.output);
					}
				}
				printStatus(task, result);
				return result;
			});
			return {
				// Services never retry (validated), so `current` is the only
				// attempt and carries the readiness-gated unblock.
				unblocked: task.persistent ? (current as StartedTask).unblocked : finalized.then(() => {}),
				result: finalized,
				stop: async () => {
					await current?.stop?.();
				},
			} satisfies StartedTask;
		})().catch((error: unknown): StartedTask => {
			// The scheduler's contract is that start() never rejects. Anything
			// unexpected (cache I/O, spawn plumbing) becomes a failed result so
			// the run degrades cleanly instead of crashing with orphaned children.
			const message = error instanceof Error ? error.message : String(error);
			const result: TaskResult = {
				name: task.name,
				status: "failed",
				durationMs: 0,
				error: message,
			};
			printStatus(task, result);
			return {
				unblocked: Promise.resolve(),
				result: Promise.resolve(result),
			} satisfies StartedTask;
		});
		return {
			unblocked: startedP.then((s) => s.unblocked),
			result: startedP.then((s) => s.result),
			stop: async () => {
				const s = await startedP;
				await s.stop?.();
			},
		};
	};
}

/**
 * Compute this task's cache decision now — at start time, so input globs see
 * whatever files its (already finished) dependencies produced.
 */
async function decideCache(state: SharedRunState, task: Task): Promise<CacheDecision> {
	const subsetDeps = task.deps.filter((dep) => state.subset.has(dep));
	const decision = await checkCache(
		state.project.rootDir,
		task,
		{
			envOutput: task.env !== undefined ? state.envOutputs.get(task.name) : null,
			args: argsFor(state, task),
			rest: restFor(state, task),
			depFingerprints: subsetDeps.map((dep) => state.fingerprints.get(dep) ?? ""),
			depOutputs: subsetDeps.map((dep) => JSON.stringify(state.outputs.get(dep) ?? null)),
		},
		state.force,
	);
	state.fingerprints.set(task.name, decision.fingerprint);
	return decision;
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
		aborter.abort(new OutdoError("interrupted", "Interrupted."));
	};
	process.on("SIGINT", onSigint);

	const results = new Map<string, TaskResult>();
	const runStart = performance.now();
	const wallStart = Date.now();
	let failedResult: TaskResult | undefined;

	try {
		for (let i = 0; i < state.planned.length; i++) {
			const task = state.planned[i] as Task;
			if (interrupted) {
				throw new OutdoError("interrupted", "Interrupted.");
			}
			const decision = await decideCache(state, task);
			if (interrupted) {
				throw new OutdoError("interrupted", "Interrupted.");
			}
			if (cacheable(task) && decision.hit) {
				const now = performance.now();
				state.outputs.set(task.name, decision.previousOutput);
				results.set(task.name, {
					name: task.name,
					status: "ok",
					durationMs: 0,
					startedAt: now,
					endedAt: now,
					cached: true,
				});
				console.error(`${green("✓")} ${task.name} ${dim("(cached)")}`);
				continue;
			}

			// No timeout handling here: plans containing a timeoutMs task always
			// use the child backend, where the budget is actually enforceable.
			const max = task.retry?.attempts ?? 1;
			let result: TaskResult | undefined;
			for (let attempt = 1; ; attempt++) {
				const startedAt = performance.now();
				let error: string | undefined;
				let output: unknown;
				try {
					const ctx = buildCtx(task, {
						env: state.envOutputs.get(task.name) ?? state.shellEnv,
						shellEnv: state.shellEnv,
						args: argsFor(state, task),
						rest: restFor(state, task),
						signal: aborter.signal,
						depsData: depsDataFor(state, task),
					});
					output = await runTaskInProcess(task, ctx);
				} catch (err) {
					if (interrupted) {
						throw err;
					}
					error = err instanceof Error ? err.message : String(err);
				}
				const endedAt = performance.now();
				const durationMs = Math.round(endedAt - startedAt);

				if (error === undefined) {
					result = {
						name: task.name,
						status: "ok",
						durationMs,
						startedAt,
						endedAt,
						...(max > 1
							? {
									attempts: attempt,
								}
							: {}),
						...(output !== undefined
							? {
									output,
								}
							: {}),
					};
					state.outputs.set(task.name, output);
					if (cacheable(task)) {
						await writeCache(state.project.rootDir, task, decision, output);
					}
					console.error(
						`${green("✓")} ${task.name} ${dim(`(${durationMs}ms${attempt > 1 ? `, ${attempt} attempts` : ""})`)}`,
					);
					break;
				}
				if (attempt >= max) {
					result = {
						name: task.name,
						status: "failed",
						durationMs,
						startedAt,
						endedAt,
						error,
						...(max > 1
							? {
									attempts: attempt,
								}
							: {}),
					};
					console.error(`${red("✗")} ${task.name} ${dim(`(${durationMs}ms)`)} ${error}`.trimEnd());
					break;
				}
				const delay = retryDelayMs(task.retry as NonNullable<Task["retry"]>, attempt);
				console.error(
					`${yellow("↻")} ${task.name} failed — retrying (attempt ${attempt + 1}/${max})${delay > 0 ? dim(` in ${delay}ms`) : ""}`,
				);
				if (delay > 0 && !(await sleepAbortable(delay, aborter.signal))) {
					throw new OutdoError("interrupted", "Interrupted.");
				}
			}

			results.set(task.name, result as TaskResult);
			if ((result as TaskResult).status === "failed") {
				failedResult = result;
				for (let j = i + 1; j < state.planned.length; j++) {
					const remaining = state.planned[j] as Task;
					results.set(remaining.name, {
						name: remaining.name,
						status: "skipped",
						durationMs: 0,
					});
				}
				break;
			}
		}
	} finally {
		process.off("SIGINT", onSigint);
	}

	const report = buildReport({
		planned: state.planned,
		results,
		services: new Set(),
		runStart,
		runEnd: performance.now(),
		wallStart,
	});
	console.error(formatSummary(report));
	if (failedResult !== undefined) {
		throw new OutdoError(
			"task-failed",
			failureMessage([
				failedResult,
			]),
			{
				failed: [
					{
						task: failedResult.name,
						error: failedResult.error,
					},
				],
			},
		);
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
	// Under --json all task output moves to stderr; stdout carries the report.
	const mux = new OutputMultiplexer(
		logOrder,
		flags.outputLogs,
		state.planned.map((t) => t.name),
		flags.json ? process.stderr : process.stdout,
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

	const runStart = performance.now();
	const wallStart = Date.now();
	try {
		const outcome = await schedule({
			tasks: state.project.tasks,
			planned: state.planned.map((t) => t.name),
			concurrency,
			continueOnError: flags.continueOnError,
			start: makeStart(state, mux, () => lifecycle),
			onAbort: () => lifecycle.shutdown(),
		});

		if (interrupted) {
			throw new OutdoError("interrupted", "Interrupted.");
		}

		const report = buildReport({
			planned: state.planned,
			results: outcome.results,
			services: new Set(outcome.services.keys()),
			runStart,
			runEnd: performance.now(),
			wallStart,
		});
		await emitArtifacts(report, state, flags);
		console.error(formatSummary(report));

		const failedResults = [
			...outcome.results.values(),
		].filter((r) => r.status === "failed");
		if (failedResults.length > 0 || outcome.failed) {
			throw new OutdoError("task-failed", failureMessage(failedResults), {
				failed: failedResults.map((r) => ({
					task: r.name,
					error: r.error,
				})),
			});
		}

		// Services keep the run alive until Ctrl-C or a service exits by itself.
		if (outcome.services.size > 0) {
			const exited = await Promise.race(
				[
					...outcome.services.values(),
				].map((handle) => handle.result),
			);
			if (interrupted || lifecycle.shuttingDown) {
				throw new OutdoError("interrupted", "Interrupted.");
			}
			await lifecycle.shutdown();
			throw new OutdoError(
				"task-failed",
				`Service "${exited.name}" exited unexpectedly (${exited.error ?? "no error"}).`,
				{
					task: exited.name,
				},
			);
		}

		return EXIT.ok;
	} finally {
		process.off("SIGINT", onSigint);
	}
}

/** Emit the --json report (stdout) and/or the --profile Chrome trace. */
async function emitArtifacts(report: RunReport, state: SharedRunState, flags: GlobalFlags): Promise<void> {
	if (flags.json) {
		console.log(JSON.stringify(report, null, 2));
	}
	if (flags.profile !== false) {
		const path = resolve(state.project.rootDir, flags.profile);
		mkdirSync(dirname(path), {
			recursive: true,
		});
		await Bun.write(path, JSON.stringify(toChromeTrace(report)));
		console.error(dim(`profile written to ${flags.profile}`));
	}
}

export function printStatus(task: Task, result: TaskResult): void {
	if (result.status === "ok" && !task.persistent) {
		const attempts = result.attempts !== undefined && result.attempts > 1 ? `, ${result.attempts} attempts` : "";
		console.error(`${green("✓")} ${task.name} ${dim(`(${result.durationMs}ms${attempts})`)}`);
	} else if (result.status === "failed") {
		console.error(`${red("✗")} ${task.name} ${dim(`(${result.durationMs}ms)`)} ${result.error ?? ""}`.trimEnd());
	}
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
		throw new OutdoError("usage", "No task given.");
	}
	const out: Task[] = [];
	const seen = new Set<string>();
	const add = (task: Task): void => {
		if (!seen.has(task.name)) {
			seen.add(task.name);
			out.push(task);
		}
	};
	for (const name of names) {
		// A bare name fans out: the root task (if any) plus every member task
		// `pkg#name`. Qualified names target exactly one task.
		const matches: Task[] = [];
		const exact = project.tasks.get(name);
		if (exact !== undefined) {
			matches.push(exact);
		}
		if (!name.includes("#")) {
			for (const task of project.tasks.values()) {
				if (task.localName === name && task.name.includes("#")) {
					matches.push(task);
				}
			}
		}
		if (matches.length > 0) {
			for (const task of matches) {
				add(task);
			}
			continue;
		}
		const hint = didYouMean(name, [
			...project.tasks.keys(),
		]);
		throw new OutdoError(
			"unknown-task",
			`Unknown task "${name}".${hint === undefined ? "" : ` Did you mean "${hint}"?`} Run "outdo" to list tasks.`,
			{
				task: name,
			},
		);
	}
	return out;
}

export function applyDefaults(task: Task): Record<string, string | boolean | undefined> {
	const out: Record<string, string | boolean | undefined> = {};
	for (const [flag, spec] of Object.entries(task.args)) {
		out[flag] = spec.default ?? (spec.type === "boolean" ? false : undefined);
	}
	return out;
}

function printDryRun(
	planned: Task[],
	requested: Task[],
	flags: GlobalFlags,
	decisions: ReadonlyMap<string, CacheDecision>,
	affected: AffectedInfo | undefined,
): number {
	const requestedNames = new Set(requested.map((t) => t.name));
	if (flags.dry === "json") {
		console.log(
			JSON.stringify(
				{
					plan: planned.map((task) => {
						const inactive = task.depEdges.map((edge) => edge.task).filter((dep) => !task.deps.includes(dep));
						return {
							name: task.name,
							requested: requestedNames.has(task.name),
							deps: task.deps,
							...(inactive.length > 0
								? {
										inactiveDeps: inactive,
									}
								: {}),
							persistent: task.persistent,
							hasRun: task.run !== undefined,
							cached: decisions.get(task.name)?.hit === true,
						};
					}),
					...(affected !== undefined
						? {
								affected,
							}
						: {}),
				},
				null,
				2,
			),
		);
	} else {
		console.log(dim("plan (dependencies first):"));
		for (const task of planned) {
			const marker = requestedNames.has(task.name) ? "*" : " ";
			const cachedNote = decisions.get(task.name)?.hit === true ? dim(" (cached — would skip)") : "";
			console.log(`  ${marker} ${task.name}${task.persistent ? dim(" (service)") : ""}${cachedNote}`);
		}
		console.log(dim("* requested — nothing was run (--dry)"));
	}
	return EXIT.ok;
}
