/**
 * Child-process execution backend: each task runs in its own `bundo __worker`
 * process with piped stdio (multiplexed by the parent) and IPC coordination.
 */

import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { type Lifecycle, spawnDetachedFlag } from "~/core/lifecycle";
import { colorsEnabled } from "~/core/logger";
import type { Task } from "~/core/model";
import type { TaskSink } from "~/core/output";
import { OutputMultiplexer } from "~/core/output";
import { READY_TIMEOUT_MS, startReadyWait } from "~/core/ready";
import type { StartedTask, TaskResult } from "~/core/scheduler";

export interface ChildRunnerOptions {
	configPath: string;
	shellEnv: Record<string, string | undefined>;
	envOutputs: ReadonlyMap<string, unknown>;
	argsFor: (task: Task) => Record<string, string | boolean | undefined>;
	restFor: (task: Task) => string[];
	depsFor: (task: Task) => Record<string, unknown>;
	sinkFor: (task: Task, onLine?: (line: string) => void) => TaskSink;
	lifecycle: Lifecycle;
}

interface ResultMessage {
	type: "result";
	ok: boolean;
	error?: string;
	output?: unknown;
}

/** The bin/entry that `bundo` itself was started with (cli.ts in dev, dist/cli.js published). */
const SELF = resolve(process.argv[1] as string);

export function startChildTask(task: Task, opts: ChildRunnerOptions): StartedTask {
	const startedAt = performance.now();

	// Readiness probe (persistent tasks with `ready`). The log observer must
	// attach before spawn so no early output line is lost.
	const probeAbort = new AbortController();
	const wait = task.persistent && task.ready !== undefined ? startReadyWait(task.ready, probeAbort.signal) : undefined;
	const sink = opts.sinkFor(task, wait?.onLine);
	let probeError: string | undefined;

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(opts.shellEnv)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	if (colorsEnabled()) {
		env.FORCE_COLOR = "1";
	}

	let resolveResultMsg: (msg: ResultMessage | undefined) => void = () => {};
	const resultMsg = new Promise<ResultMessage | undefined>((resolve) => {
		resolveResultMsg = resolve;
	});

	const proc: Subprocess = Bun.spawn(
		[
			process.execPath,
			SELF,
			"__worker",
		],
		{
			cwd: task.cwd,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: spawnDetachedFlag(),
			ipc(message: ResultMessage) {
				if (message?.type === "result") {
					resolveResultMsg(message);
				}
			},
			serialization: "advanced",
		},
	);
	opts.lifecycle.track(task.name, proc);

	// Per-attempt timeout: cooperative abort (IPC) -> grace -> tree kill.
	let timedOut = false;
	const timeoutTimer =
		task.timeoutMs !== undefined
			? setTimeout(() => {
					timedOut = true;
					void opts.lifecycle.stop(proc);
				}, task.timeoutMs)
			: undefined;

	proc.send({
		type: "run",
		configPath: task.sourceConfig,
		taskName: task.localName,
		env: opts.envOutputs.get(task.name) ?? opts.shellEnv,
		shellEnv: opts.shellEnv,
		args: opts.argsFor(task),
		rest: opts.restFor(task),
		depsData: opts.depsFor(task),
	});

	const streams = Promise.all([
		OutputMultiplexer.pipe(proc.stdout as ReadableStream<Uint8Array>, sink.stdout),
		OutputMultiplexer.pipe(proc.stderr as ReadableStream<Uint8Array>, sink.stderr),
	]);

	const result: Promise<TaskResult> = (async () => {
		const [exitCode, message] = await Promise.all([
			proc.exited,
			Promise.race([
				resultMsg,
				proc.exited.then(() => undefined),
			]),
		]);
		if (timeoutTimer !== undefined) {
			clearTimeout(timeoutTimer);
		}
		// Cancel probe timers if the service exited on its own mid-probe.
		probeAbort.abort();
		await streams.catch(() => {});
		const ok = message?.ok === true && exitCode === 0 && !timedOut && probeError === undefined;
		const aborted = opts.lifecycle.shuttingDown && !ok && !timedOut;
		sink.finish(ok);
		const endedAt = performance.now();
		return {
			name: task.name,
			status: ok ? "ok" : aborted ? "aborted" : "failed",
			durationMs: Math.round(endedAt - startedAt),
			startedAt,
			endedAt,
			...(ok && message?.output !== undefined
				? {
						output: message.output,
					}
				: {}),
			...(ok || aborted
				? {}
				: {
						error: timedOut
							? `Task "${task.name}" timed out after ${task.timeoutMs}ms`
							: (probeError ?? message?.error ?? `exited with code ${exitCode}`),
					}),
		};
	})();

	// Services without a probe unblock on spawn (v1 semantics); with a probe,
	// dependents wait for readiness. A failed probe stops the service and never
	// resolves `unblocked` — the scheduler's race then reads the failed result.
	const unblocked: Promise<void> =
		wait !== undefined
			? wait.done.then((ready) => {
					if (ready) {
						return;
					}
					const alive = proc.exitCode === null && proc.signalCode === null;
					if (alive && !opts.lifecycle.shuttingDown) {
						probeError = `service "${task.name}" was not ready after ${task.ready?.timeoutMs ?? READY_TIMEOUT_MS}ms (${wait.describe})`;
						void opts.lifecycle.stop(proc);
					}
					return new Promise<never>(() => {});
				})
			: task.persistent
				? Promise.resolve()
				: result.then(() => {});

	return {
		unblocked,
		result,
		stop: () => opts.lifecycle.stop(proc),
	};
}
