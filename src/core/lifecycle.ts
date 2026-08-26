/**
 * Child process lifecycle: cooperative abort first (IPC), then tree kill.
 *
 * There is no cross-platform tree-kill primitive in Bun. POSIX children are
 * spawned detached (their own process group) and killed with kill(-pid);
 * Windows uses `taskkill /T /F`.
 */

import type { Subprocess } from "bun";
import { debugLog } from "~/core/logger";

export const GRACE_MS = 5000;

const IS_WINDOWS = process.platform === "win32";

export interface ManagedChild {
	name: string;
	proc: Subprocess;
}

export class Lifecycle {
	readonly #children = new Set<ManagedChild>();
	readonly #aborter = new AbortController();
	#shuttingDown = false;

	get shuttingDown(): boolean {
		return this.#shuttingDown;
	}

	/** Aborted the moment shutdown/killAll begins — cancels retry delays etc. */
	get signal(): AbortSignal {
		return this.#aborter.signal;
	}

	track(name: string, proc: Subprocess): void {
		const child: ManagedChild = {
			name,
			proc,
		};
		this.#children.add(child);
		proc.exited.finally(() => this.#children.delete(child));
	}

	/** Ask one child to abort cooperatively; escalate to a tree kill after grace. */
	async stop(proc: Subprocess, graceMs = GRACE_MS): Promise<void> {
		if (proc.exitCode !== null || proc.signalCode !== null) {
			return;
		}
		try {
			proc.send({
				type: "abort",
			});
		} catch {
			// IPC gone — go straight to the kill.
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), graceMs);
		});
		const winner = await Promise.race([
			proc.exited.then(() => "exited" as const),
			timeout,
		]);
		clearTimeout(timer);
		if (winner === "timeout") {
			await killTree(proc);
		}
	}

	/** Graceful stop of every tracked child (used on Ctrl-C / fail-fast). */
	async shutdown(graceMs = GRACE_MS): Promise<void> {
		this.#shuttingDown = true;
		this.#aborter.abort();
		await Promise.all(
			[
				...this.#children,
			].map((child) => this.stop(child.proc, graceMs)),
		);
	}

	/** Immediate, non-cooperative kill of everything (second Ctrl-C). */
	killAll(): void {
		this.#shuttingDown = true;
		this.#aborter.abort();
		for (const child of this.#children) {
			void killTree(child.proc);
		}
	}
}

export async function killTree(proc: Subprocess): Promise<void> {
	if (proc.exitCode !== null || proc.signalCode !== null) {
		return;
	}
	debugLog("killTree", proc.pid);
	if (IS_WINDOWS) {
		const killer = Bun.spawn(
			[
				"taskkill",
				"/T",
				"/F",
				"/PID",
				String(proc.pid),
			],
			{
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		await killer.exited;
		// taskkill can race with processes spawned mid-walk — retry once.
		if (proc.exitCode === null && proc.signalCode === null) {
			const retry = Bun.spawn(
				[
					"taskkill",
					"/T",
					"/F",
					"/PID",
					String(proc.pid),
				],
				{
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			await retry.exited;
		}
	} else {
		// Children are spawned detached (setsid), so -pid hits the whole group.
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, 1000);
	});
	await Promise.race([
		proc.exited.then(() => {}),
		timeout,
	]);
	clearTimeout(timer);
}

/** POSIX children get their own process group so kill(-pid) reaches the tree. */
export function spawnDetachedFlag(): boolean {
	return !IS_WINDOWS;
}
