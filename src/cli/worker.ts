/**
 * Hidden `outdo __worker` entry: runs exactly one task in this process,
 * driven by IPC from the parent outdo. The parent pipes our stdout/stderr
 * into the output multiplexer and coordinates abort/kill.
 */

import { loadProject } from "~/core/config";
import { buildCtx, runTaskInProcess } from "~/core/executor";

interface RunMessage {
	type: "run";
	configPath: string;
	taskName: string;
	/** Qualified name (`pkg#task`) — the local do.ts only knows `taskName`. */
	fullName: string;
	env: unknown;
	shellEnv: Record<string, string | undefined>;
	args: Record<string, string | boolean | undefined>;
	rest: string[];
	depsData: Record<string, unknown>;
}

interface AbortMessage {
	type: "abort";
}

interface ResultMessage {
	type: "result";
	ok: boolean;
	error?: string;
	output?: unknown;
}

export async function workerCommand(): Promise<number> {
	const aborter = new AbortController();
	// The parent owns Ctrl-C handling; ignore the console signal here.
	process.on("SIGINT", () => {});

	const outcome = await new Promise<{
		code: number;
		message: ResultMessage;
	}>((resolve) => {
		process.on("message", (message: RunMessage | AbortMessage) => {
			if (message.type === "abort") {
				aborter.abort();
				return;
			}
			if (message.type !== "run") {
				return;
			}
			void (async () => {
				try {
					const project = await loadProject(message.configPath);
					const task = project.tasks.get(message.taskName);
					if (task === undefined) {
						throw new Error(`worker: unknown task "${message.taskName}"`);
					}
					// Present the qualified name so logs and errors match the parent
					// (two workspace members may share a local name).
					const runTask = {
						...task,
						name: message.fullName ?? task.name,
					};
					const ctx = buildCtx(runTask, {
						env: message.env,
						shellEnv: message.shellEnv,
						args: message.args,
						rest: message.rest,
						signal: aborter.signal,
						depsData: message.depsData ?? {},
					});
					const output = await runTaskInProcess(runTask, ctx);
					resolve({
						code: 0,
						message: {
							type: "result",
							ok: true,
							...(output === undefined
								? {}
								: {
										output,
									}),
						},
					});
				} catch (error) {
					const messageText = error instanceof Error ? error.message : String(error);
					resolve({
						code: 1,
						message: {
							type: "result",
							ok: false,
							error: messageText,
						},
					});
				}
			})();
		});
	});

	// Exit only once the IPC write has completed — exiting earlier can lose the
	// result message and falsely fail a green task (the parent would see the
	// process gone before the message arrives). The clearable timer is a
	// belt-and-braces fallback in case the send callback never fires; we must
	// exit explicitly either way (the open IPC listener otherwise keeps this
	// process alive forever).
	await new Promise<void>((resolve) => {
		const fallback = setTimeout(resolve, 1000);
		try {
			process.send?.(outcome.message, undefined, undefined, () => {
				clearTimeout(fallback);
				resolve();
			});
		} catch {
			clearTimeout(fallback);
			resolve();
		}
	});
	process.exit(outcome.code);
}
