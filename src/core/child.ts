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
import type { StartedTask, TaskResult } from "~/core/scheduler";

export interface ChildRunnerOptions {
	configPath: string;
	shellEnv: Record<string, string | undefined>;
	envOutputs: ReadonlyMap<string, unknown>;
	argsFor: (task: Task) => Record<string, string | boolean | undefined>;
	restFor: (task: Task) => string[];
	sinkFor: (task: Task) => TaskSink;
	lifecycle: Lifecycle;
}

interface ResultMessage {
	type: "result";
	ok: boolean;
	error?: string;
}

/** The bin/entry that `bundo` itself was started with (cli.ts in dev, dist/cli.js published). */
const SELF = resolve(process.argv[1] as string);

export function startChildTask(task: Task, opts: ChildRunnerOptions): StartedTask {
	const startedAt = performance.now();
	const sink = opts.sinkFor(task);

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

	proc.send({
		type: "run",
		configPath: opts.configPath,
		taskName: task.name,
		env: opts.envOutputs.get(task.name) ?? opts.shellEnv,
		shellEnv: opts.shellEnv,
		args: opts.argsFor(task),
		rest: opts.restFor(task),
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
		await streams.catch(() => {});
		const ok = message?.ok === true && exitCode === 0;
		const aborted = opts.lifecycle.shuttingDown && !ok;
		sink.finish(ok);
		return {
			name: task.name,
			status: ok ? "ok" : aborted ? "aborted" : "failed",
			durationMs: Math.round(performance.now() - startedAt),
			...(ok || aborted
				? {}
				: {
						error: message?.error ?? `exited with code ${exitCode}`,
					}),
		};
	})();

	return {
		// v1: services unblock dependents as soon as the worker has spawned.
		unblocked: task.persistent ? Promise.resolve() : result.then(() => {}),
		result,
	};
}
