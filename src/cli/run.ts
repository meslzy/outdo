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
 *
 * After the main run, `finally` tasks owed by started tasks run (even after a
 * failure or Ctrl-C). Services started only as dependencies are stopped once
 * the requested tasks finish; a requested service keeps the run alive.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Command, GlobalFlags } from "~/cli/parse";
import type { SharedRunState } from "~/cli/plan";
import { planFinally, preparePlan } from "~/cli/plan";
import type { CacheDecision } from "~/core/cache";
import { cacheable, checkCache, writeCache } from "~/core/cache";
import { startChildTask } from "~/core/child";
import { EXIT, OutdoError } from "~/core/errors";
import { buildCtx, runTaskInProcess } from "~/core/executor";
import {
	annotationsFromOutput,
	appendStepSummary,
	formatAnnotation,
	inGithubActions,
	summaryMarkdown,
} from "~/core/github";
import { Lifecycle } from "~/core/lifecycle";
import { bold, dim, green, red, yellow } from "~/core/logger";
import type { ArgValues, Task } from "~/core/model";
import { type FailedOutput, OutputMultiplexer } from "~/core/output";
import type { RunReport } from "~/core/report";
import { buildReport, formatSummary, toChromeTrace } from "~/core/report";
import { checkRequires, requiresFailure } from "~/core/requires";
import { retryDelayMs, sleepAbortable } from "~/core/retry";
import type { StartedTask, TaskResult } from "~/core/scheduler";
import { isChain, schedule } from "~/core/scheduler";
import { recordRun, type UsageVia } from "~/core/usage";

export type { SharedRunState } from "~/cli/plan";

type RunLikeCommand = Extract<
	Command,
	{
		kind: "run" | "ci" | "bg-start";
	}
>;

/**
 * The ready-marker path from `outdo bg start`, taken out of the environment
 * before any task spawns: an outdo run nested inside a task must not mark the
 * background run ready.
 */
let backgroundState: string | undefined;

/** Where a run came from, for the usage log. `outdo bg` and the MCP server pass theirs as OUTDO_VIA. */
function runVia(command: RunLikeCommand, flags: GlobalFlags, origin: UsageOrigin): UsageVia {
	const passed = process.env.OUTDO_VIA;
	delete process.env.OUTDO_VIA;
	if (process.env.OUTDO_NESTED === "1") {
		return "nested";
	}
	if (passed === "bg" || passed === "mcp") {
		return passed;
	}
	if (command.kind === "ci") {
		return "ci";
	}
	if (origin.via !== undefined) {
		return origin.via;
	}
	return flags.watch ? "watch" : "cli";
}

export interface UsageOrigin {
	via?: "pick" | "hook";
	hook?: string;
}

export async function runCommand(
	command: RunLikeCommand,
	flags: GlobalFlags,
	origin: UsageOrigin = {},
): Promise<number> {
	if (process.env.OUTDO_BG_STATE !== undefined) {
		backgroundState = process.env.OUTDO_BG_STATE;
		delete process.env.OUTDO_BG_STATE;
	}
	const via = runVia(command, flags, origin);
	// An outdo run started by one of this run's tasks records itself as nested.
	process.env.OUTDO_NESTED = "1";
	if (flags.watch && flags.json) {
		throw new OutdoError("usage", "--watch cannot be combined with --json (watch is a streaming mode).");
	}
	if (flags.watch && flags.profile !== false) {
		throw new OutdoError("usage", "--watch cannot be combined with --profile.");
	}
	if (flags.watch && flags.affected !== false) {
		throw new OutdoError("usage", "--watch cannot be combined with --affected.");
	}
	if (command.kind === "ci") {
		if (flags.watch) {
			throw new OutdoError("usage", "ci cannot be combined with --watch.");
		}
		flags.ci = true;
		if (flags.logOrder === "auto") {
			flags.logOrder = "grouped";
		}
		if (!command.all && flags.affected === false) {
			flags.affected = {
				base: command.base,
			};
		}
	}

	const result = await preparePlan(
		{
			words: command.tasks,
			taskArgv: command.taskArgv,
			rest: command.rest,
		},
		flags,
		{
			dropPersistent: command.kind === "ci",
		},
	);
	if (result.kind === "help") {
		console.log(result.text);
		return EXIT.ok;
	}
	if (result.kind === "namespace") {
		const { renderList } = await import("~/cli/list");
		console.log(renderList(result.project, result.namespace));
		return EXIT.ok;
	}
	if (result.kind === "nothing") {
		if (command.kind === "ci") {
			appendStepSummary(`### ✅ outdo ci ${command.tasks.join(" ")}\n\nNothing affected vs ${result.affected.base}.\n`);
		}
		return EXIT.ok;
	}
	const { state } = result;

	if (flags.dry !== false) {
		if (flags.profile !== false) {
			console.error(dim("--profile ignored under --dry (nothing was run)"));
		}
		// Preview pass on the current disk state (real decisions happen at
		// task start, after dependencies have produced their outputs).
		const decisions = new Map<string, CacheDecision>();
		for (const task of state.planned) {
			const decision = await decideCache(state, task, false);
			if (cacheable(task)) {
				decisions.set(task.name, decision);
				if (decision.hit) {
					// Seed replayed outputs so downstream previews compose.
					state.outputs.set(task.name, decision.previousOutput);
				}
			}
		}
		state.fingerprints.clear();
		state.outputs.clear();
		return printDryRun(state, result.requested, flags, decisions, result.affected);
	}

	const usage = recordRun(state.project, {
		via,
		hook: origin.hook,
		tasks: [
			...state.requestedNames,
			...(result.affected?.dropped ?? []),
		],
		ran: state.planned.map((t) => t.name),
		flags: state.targetFlags,
		mode: state.mode,
	});

	if (flags.watch) {
		const { runWatch } = await import("~/cli/watch-run");
		return await runWatch(state, flags);
	}

	const main = await executePlan(state, flags);
	let error = main.error;

	// `finally` tasks run even when the main run failed or was interrupted.
	const started = new Set<string>();
	const succeeded = new Set<string>();
	for (const [name, r] of main.results) {
		if (r.startedAt !== undefined) {
			started.add(name);
		}
		if (r.status === "ok") {
			succeeded.add(name);
		}
	}
	const cleanup = await planFinally(state, started, succeeded);
	let cleanupFailures: FailedOutput[] = [];
	let cleanupResults = new Map<string, TaskResult>();
	if (cleanup !== undefined) {
		console.error(
			dim(
				`finally: ${[
					...cleanup.requestedNames,
				].join(", ")}`,
			),
		);
		const after = await executePlan(cleanup, flags);
		cleanupFailures = after.failures;
		error ??= after.error;
		cleanupResults = after.results;
	}
	usage?.end(
		[
			...main.results.values(),
			...cleanupResults.values(),
		],
		error === undefined,
	);

	if (flags.ci) {
		const errors = new Map<string, string>();
		for (const r of main.results.values()) {
			if (r.error !== undefined) {
				errors.set(r.name, r.error);
			}
		}
		reportCi(
			command.tasks,
			main.report,
			[
				...main.failures,
				...cleanupFailures,
			],
			errors,
		);
	}
	if (error !== undefined) {
		throw error;
	}
	return EXIT.ok;
}

/** End-of-run CI output: failed logs again (unfolded), annotations, step summary. */
function reportCi(
	requested: readonly string[],
	report: RunReport | undefined,
	failures: readonly FailedOutput[],
	errors: ReadonlyMap<string, string>,
): void {
	const github = inGithubActions();
	for (const failure of failures) {
		const error = errors.get(failure.name);
		console.log(`\n${bold(red(`✗ ${failure.name}`))} ${dim("— output:")}`);
		for (const line of failure.lines) {
			console.log(`  ${line}`);
		}
		if (error !== undefined) {
			console.log(`  ${red(error)}`);
		}
		if (github) {
			const notes = annotationsFromOutput(failure.name, failure.lines);
			for (const note of notes.slice(0, 20)) {
				console.log(formatAnnotation(note));
			}
			const tail = failure.lines.filter((line) => line.trim() !== "").slice(-15);
			console.log(
				formatAnnotation({
					title: `outdo: ${failure.name} failed`,
					message:
						[
							...tail,
							...(error !== undefined
								? [
										error,
									]
								: []),
						].join("\n") || "failed",
				}),
			);
		}
	}
	if (github && report !== undefined) {
		appendStepSummary(summaryMarkdown(`outdo ci ${requested.join(" ")}`, report));
	}
}

interface ExecOutcome {
	results: Map<string, TaskResult>;
	error: OutdoError | undefined;
	report: RunReport | undefined;
	failures: FailedOutput[];
}

async function executePlan(state: SharedRunState, flags: GlobalFlags): Promise<ExecOutcome> {
	const order = state.planned.map((t) => t.name);
	return usesSequentialBackend(state.project.tasks, order, state.planned, flags)
		? await runSequential(state)
		: await runParallel(state, flags);
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
		flags.json || flags.ci || flags.profile !== false || flags.logOrder !== "auto" || flags.outputLogs !== "full";
	return !flags.isolate && !wantsMultiplexed && !hasServices && !hasTimeouts && isChain(tasks, order);
}

function argsFor(state: SharedRunState, task: Task): ArgValues {
	return task.name === state.target?.name ? state.targetArgs : (state.defaultArgs.get(task.name) ?? {});
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
		if (!state.subset.has(dep) && !state.outputs.has(dep)) {
			continue;
		}
		const local = prefix !== undefined && dep.startsWith(prefix) ? dep.slice(prefix.length) : dep;
		out[local] = state.outputs.get(dep);
	}
	return out;
}

/** Unmet `requires` of a task, as a failure message (undefined when all pass). */
async function unmetRequirements(state: SharedRunState, task: Task): Promise<string | undefined> {
	if (task.requires === undefined) {
		return undefined;
	}
	const results = await checkRequires(task.requires, task.cwd, state.envFor(task));
	return requiresFailure(task.name, task.requires, results);
}

function cachedLine(task: Task, decision: CacheDecision): string {
	return `${green("✓")} ${task.name} ${dim(decision.restored === true ? "(cached, outputs restored)" : "(cached)")}`;
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
				if (decision.previousLog !== undefined && decision.previousLog.length > 0) {
					const replay = mux.sink(task.name);
					replay.stdout(new TextEncoder().encode(`${decision.previousLog.join("\n")}\n`));
					replay.finish(true);
				}
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
				console.error(cachedLine(task, decision));
				return {
					unblocked: Promise.resolve(),
					result: Promise.resolve(result),
				} satisfies StartedTask;
			}

			const unmet = await unmetRequirements(state, task);
			if (unmet !== undefined) {
				const now = performance.now();
				const result: TaskResult = {
					name: task.name,
					status: "failed",
					durationMs: 0,
					startedAt: now,
					endedAt: now,
					error: unmet,
				};
				printStatus(task, result);
				return {
					unblocked: Promise.resolve(),
					result: Promise.resolve(result),
				} satisfies StartedTask;
			}

			const lifecycle = lifecycleFor(task);
			// Cacheable tasks keep their log so a later hit can replay it.
			const captured: string[] | undefined = cacheable(task) ? [] : undefined;
			let current: StartedTask | undefined;
			const attemptOnce = (): StartedTask => {
				captured?.splice(0);
				return startChildTask(task, {
					configPath: state.project.configPath,
					envFor: state.envFor,
					envOutputs: state.envOutputs,
					argsFor: (t) => argsFor(state, t),
					restFor: (t) => restFor(state, t),
					depsFor: (t) => depsDataFor(state, t),
					sinkFor: (t, onLine) =>
						mux.sink(
							t.name,
							captured === undefined
								? onLine
								: (line) => {
										onLine?.(line);
										captured.push(line);
									},
						),
					lifecycle,
					root: state.project.rootDir,
					mode: state.mode,
				});
			};

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
						await writeCache(state.project.rootDir, task, decision, result.output, captured);
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
async function decideCache(state: SharedRunState, task: Task, restore = true): Promise<CacheDecision> {
	const subsetDeps = task.deps.filter((dep) => state.subset.has(dep) || state.fingerprints.has(dep));
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
		restore,
	);
	state.fingerprints.set(task.name, decision.fingerprint);
	return decision;
}

/** Stop handlers for Ctrl-C and (POSIX) SIGTERM — `outdo bg stop` sends the latter. */
function onStopSignals(handler: () => void): () => void {
	process.on("SIGINT", handler);
	const term = process.platform !== "win32";
	if (term) {
		process.on("SIGTERM", handler);
	}
	return () => {
		process.off("SIGINT", handler);
		if (term) {
			process.off("SIGTERM", handler);
		}
	};
}

// ---------------------------------------------------------------------------
// Sequential (in-process) backend
// ---------------------------------------------------------------------------

async function runSequential(state: SharedRunState): Promise<ExecOutcome> {
	const aborter = new AbortController();
	let interrupted = false;
	const offSignals = onStopSignals(() => {
		if (interrupted) {
			process.exit(EXIT.interrupted);
		}
		interrupted = true;
		aborter.abort(new OutdoError("interrupted", "Interrupted."));
	});

	const results = new Map<string, TaskResult>();
	const runStart = performance.now();
	const wallStart = Date.now();
	let failedResult: TaskResult | undefined;
	let error: OutdoError | undefined;

	const skipRest = (from: number): void => {
		for (let j = from; j < state.planned.length; j++) {
			const remaining = state.planned[j] as Task;
			if (!results.has(remaining.name)) {
				results.set(remaining.name, {
					name: remaining.name,
					status: "skipped",
					durationMs: 0,
				});
			}
		}
	};

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
				if (decision.previousLog !== undefined && decision.previousLog.length > 0) {
					process.stdout.write(`${decision.previousLog.join("\n")}\n`);
				}
				console.error(cachedLine(task, decision));
				continue;
			}

			const unmet = await unmetRequirements(state, task);
			if (unmet !== undefined) {
				const now = performance.now();
				failedResult = {
					name: task.name,
					status: "failed",
					durationMs: 0,
					startedAt: now,
					endedAt: now,
					error: unmet,
				};
				results.set(task.name, failedResult);
				printStatus(task, failedResult);
				skipRest(i + 1);
				break;
			}

			// No timeout handling here: plans containing a timeoutMs task always
			// use the child backend, where the budget is actually enforceable.
			const max = task.retry?.attempts ?? 1;
			let result: TaskResult | undefined;
			for (let attempt = 1; ; attempt++) {
				const startedAt = performance.now();
				let taskError: string | undefined;
				let output: unknown;
				try {
					const shellEnv = state.envFor(task);
					const ctx = buildCtx(task, {
						env: state.envOutputs.get(task.name) ?? shellEnv,
						shellEnv,
						args: argsFor(state, task),
						rest: restFor(state, task),
						signal: aborter.signal,
						depsData: depsDataFor(state, task),
						root: state.project.rootDir,
						mode: state.mode,
					});
					output = await runTaskInProcess(task, ctx, shellEnv);
				} catch (err) {
					if (interrupted) {
						throw err;
					}
					taskError = err instanceof Error ? err.message : String(err);
				}
				const endedAt = performance.now();
				const durationMs = Math.round(endedAt - startedAt);

				if (taskError === undefined) {
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
						error: taskError,
						...(max > 1
							? {
									attempts: attempt,
								}
							: {}),
					};
					console.error(`${red("✗")} ${task.name} ${dim(`(${durationMs}ms)`)} ${taskError}`.trimEnd());
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
				skipRest(i + 1);
				break;
			}
		}
	} catch (err) {
		if (!(err instanceof OutdoError) || err.code !== "interrupted") {
			throw err;
		}
		error = err;
		const current = state.planned.find((t) => !results.has(t.name));
		if (current !== undefined) {
			results.set(current.name, {
				name: current.name,
				status: "aborted",
				durationMs: 0,
				startedAt: performance.now(),
			});
		}
		skipRest(0);
	} finally {
		offSignals();
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
	if (error === undefined && failedResult !== undefined) {
		error = new OutdoError(
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
	return {
		results,
		error,
		report,
		failures: [],
	};
}

// ---------------------------------------------------------------------------
// Parallel (child-process) backend
// ---------------------------------------------------------------------------

/** `outdo bg start` points this at its state file; the run marks itself ready there. */
function markBackgroundReady(): void {
	const path = backgroundState;
	if (path === undefined || path === "") {
		return;
	}
	try {
		writeFileSync(
			path,
			JSON.stringify({
				ready: true,
				at: Date.now(),
			}),
		);
	} catch {
		// the starter falls back to the log and the pid
	}
}

async function runParallel(state: SharedRunState, flags: GlobalFlags): Promise<ExecOutcome> {
	const isTty = process.stdout.isTTY === true;
	const logOrder = flags.logOrder === "auto" ? (isTty ? "stream" : "grouped") : flags.logOrder;
	const concurrency = flags.concurrency ?? Math.max(1, navigator.hardwareConcurrency ?? 4);
	// Under --json all task output moves to stderr; stdout carries the report.
	const mux = new OutputMultiplexer(
		logOrder,
		flags.outputLogs,
		state.planned.map((t) => t.name),
		flags.json ? process.stderr : process.stdout,
		flags.ci
			? {
					groups: inGithubActions(),
				}
			: undefined,
	);
	const lifecycle = new Lifecycle();

	let interrupted = false;
	const offSignals = onStopSignals(() => {
		if (interrupted) {
			lifecycle.killAll();
			process.exit(EXIT.interrupted);
		}
		interrupted = true;
		console.error(dim("interrupt — stopping tasks (Ctrl-C again to force)"));
		void lifecycle.shutdown();
	});

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

		const report = buildReport({
			planned: state.planned,
			results: outcome.results,
			services: new Set(outcome.services.keys()),
			runStart,
			runEnd: performance.now(),
			wallStart,
		});
		const done = (error: OutdoError | undefined): ExecOutcome => ({
			results: outcome.results,
			error,
			report,
			failures: mux.failures,
		});

		if (interrupted) {
			return done(new OutdoError("interrupted", "Interrupted."));
		}
		await emitArtifacts(report, state, flags);
		console.error(formatSummary(report));

		const failedResults = [
			...outcome.results.values(),
		].filter((r) => r.status === "failed");
		if (failedResults.length > 0 || outcome.failed) {
			await lifecycle.shutdown();
			return done(
				new OutdoError("task-failed", failureMessage(failedResults), {
					failed: failedResults.map((r) => ({
						task: r.name,
						error: r.error,
					})),
				}),
			);
		}

		if (outcome.services.size > 0) {
			// Services pulled in only as dependencies served their dependents.
			const keepAlive = [
				...state.requestedNames,
			].some((name) => state.project.tasks.get(name)?.persistent === true);
			if (!keepAlive) {
				console.error(
					dim(
						`stopping ${[
							...outcome.services.keys(),
						].join(", ")}`,
					),
				);
				await lifecycle.shutdown();
				return done(undefined);
			}
			markBackgroundReady();
			// A requested service keeps the run alive until Ctrl-C or it exits by itself.
			const exited = await Promise.race(
				[
					...outcome.services.values(),
				].map((handle) => handle.result),
			);
			if (interrupted || lifecycle.shuttingDown) {
				return done(new OutdoError("interrupted", "Interrupted."));
			}
			await lifecycle.shutdown();
			return done(
				new OutdoError("task-failed", `Service "${exited.name}" exited unexpectedly (${exited.error ?? "no error"}).`, {
					task: exited.name,
				}),
			);
		}

		return done(undefined);
	} finally {
		offSignals();
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
	if (failed.length === 0) {
		return "Run failed.";
	}
	return `${failed.length} tasks failed: ${failed.map((r) => r.name).join(", ")}`;
}

// ---------------------------------------------------------------------------

function printDryRun(
	state: SharedRunState,
	requested: Task[],
	flags: GlobalFlags,
	decisions: ReadonlyMap<string, CacheDecision>,
	affected:
		| {
				base: string;
				kept: string[];
				dropped: string[];
		  }
		| undefined,
): number {
	const requestedNames = new Set(requested.map((t) => t.name));
	const planned = state.planned;
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
							...(task.after.length > 0
								? {
										after: task.after,
									}
								: {}),
							...(inactive.length > 0
								? {
										inactiveDeps: inactive,
									}
								: {}),
							persistent: task.persistent,
							hasRun: task.run !== undefined || task.command !== undefined || task.script !== undefined,
							cached: decisions.get(task.name)?.hit === true,
						};
					}),
					...(state.mode !== ""
						? {
								mode: state.mode,
							}
						: {}),
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
		console.log(dim(`plan (dependencies first)${state.mode !== "" ? ` · mode ${state.mode}` : ""}:`));
		for (const task of planned) {
			const marker = requestedNames.has(task.name) ? "*" : " ";
			const cachedNote = decisions.get(task.name)?.hit === true ? dim(" (cached — would skip)") : "";
			const afterNote = task.after.length > 0 ? dim(` (after ${task.after.join(", ")})`) : "";
			console.log(`  ${marker} ${task.name}${task.persistent ? dim(" (service)") : ""}${afterNote}${cachedNote}`);
		}
		console.log(dim("* requested — nothing was run (--dry)"));
	}
	return EXIT.ok;
}
