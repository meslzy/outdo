/**
 * Hidden `bundo __worker` entry: runs exactly one task in this process,
 * driven by IPC from the parent bundo. The parent pipes our stdout/stderr
 * into the output multiplexer and coordinates abort/kill.
 */

import { loadProject } from "~/core/config";
import { buildCtx, runTaskInProcess } from "~/core/executor";

interface RunMessage {
	type: "run";
	configPath: string;
	taskName: string;
	env: unknown;
	shellEnv: Record<string, string | undefined>;
	args: Record<string, string | boolean | undefined>;
	rest: string[];
	depsData: Record<string, unknown>;
}

interface AbortMessage {
	type: "abort";
}

export async function workerCommand(): Promise<number> {
	const aborter = new AbortController();
	// The parent owns Ctrl-C handling; ignore the console signal here.
	process.on("SIGINT", () => {});

	const exit = await new Promise<number>((resolve) => {
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
					const ctx = buildCtx(task, {
						env: message.env,
						shellEnv: message.shellEnv,
						args: message.args,
						rest: message.rest,
						signal: aborter.signal,
						depsData: message.depsData ?? {},
					});
					const output = await runTaskInProcess(task, ctx);
					process.send?.({
						type: "result",
						ok: true,
						...(output === undefined
							? {}
							: {
									output,
								}),
					});
					resolve(0);
				} catch (error) {
					const messageText = error instanceof Error ? error.message : String(error);
					process.send?.({
						type: "result",
						ok: false,
						error: messageText,
					});
					resolve(1);
				}
			})();
		});
	});
	// Give the IPC channel a beat to deliver the result message, then exit
	// explicitly — the open IPC listener would otherwise keep us alive forever.
	await Bun.sleep(10);
	process.exit(exit);
}
