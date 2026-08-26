/**
 * DAG scheduler: indegree-driven ready queue with a concurrency cap,
 * fail-fast (default) or --continue, and persistent-task semantics
 * (services unblock dependents on spawn and do not hold a slot).
 */

import type { Task } from "~/core/model";

export interface TaskResult {
	name: string;
	status: "ok" | "failed" | "aborted" | "skipped";
	durationMs: number;
	/** Monotonic (performance.now) run-relative timestamps; absent when never started. */
	startedAt?: number;
	endedAt?: number;
	/** Present for failed tasks. */
	error?: string;
	/** True when a cache hit skipped execution (M5). */
	cached?: boolean;
	/** Total attempts made (present when a retry policy kicked in, i.e. > 1). */
	attempts?: number;
	/** JSON data output of the task's run() (replayed from cache on hits). */
	output?: unknown;
}

export interface StartedTask {
	/** Resolves when dependents may start (readiness for services, completion otherwise). */
	unblocked: Promise<void>;
	/** Final outcome. For services this resolves only when the service exits. */
	result: Promise<TaskResult>;
	/** Cooperative stop (services) — used by watch mode to restart them. */
	stop?: () => Promise<void>;
}

export interface ServiceHandle {
	result: Promise<TaskResult>;
	stop: () => Promise<void>;
}

export interface ScheduleOptions {
	tasks: ReadonlyMap<string, Task>;
	/** Topologically-ordered plan (dependencies first). */
	planned: readonly string[];
	concurrency: number;
	continueOnError: boolean;
	/** Launch one task. Never rejects — failures land in the TaskResult. */
	start: (task: Task) => StartedTask;
	/** Called when a failure triggers fail-fast, to abort running tasks. */
	onAbort: () => Promise<void>;
}

export interface ScheduleOutcome {
	results: Map<string, TaskResult>;
	failed: boolean;
	/** Persistent tasks still running when the DAG drained. */
	services: Map<string, ServiceHandle>;
}

export async function schedule(opts: ScheduleOptions): Promise<ScheduleOutcome> {
	const subset = new Set(opts.planned);
	const indegree = new Map<string, number>();
	const dependentsOf = new Map<string, string[]>();
	for (const name of opts.planned) {
		const task = opts.tasks.get(name) as Task;
		const deps = task.deps.filter((dep) => subset.has(dep));
		indegree.set(name, deps.length);
		for (const dep of deps) {
			let list = dependentsOf.get(dep);
			if (!list) {
				list = [];
				dependentsOf.set(dep, list);
			}
			list.push(name);
		}
	}

	const results = new Map<string, TaskResult>();
	const services = new Map<string, ServiceHandle>();
	const running = new Set<Promise<void>>();
	const ready: string[] = opts.planned.filter((name) => indegree.get(name) === 0);
	let slots = 0;
	let aborting = false;

	const failedDownstream = (name: string): void => {
		// Everything depending (transitively) on a failed task is skipped.
		for (const dependent of dependentsOf.get(name) ?? []) {
			if (!results.has(dependent)) {
				results.set(dependent, {
					name: dependent,
					status: "skipped",
					durationMs: 0,
				});
				failedDownstream(dependent);
			}
		}
	};

	const launch = (name: string): void => {
		const task = opts.tasks.get(name) as Task;
		const holdsSlot = !task.persistent;
		if (holdsSlot) {
			slots++;
		}
		const started = opts.start(task);

		const tracked = (async () => {
			if (task.persistent) {
				// Readiness races the service exiting: a service that dies (or
				// times out its probe) before becoming ready fails its dependents.
				const startedAt = performance.now();
				const winner = await Promise.race([
					started.unblocked.then(() => "ready" as const),
					started.result,
				]);
				if (winner === "ready") {
					services.set(name, {
						result: started.result,
						stop: started.stop ?? (async () => {}),
					});
					results.set(name, {
						name,
						status: "ok",
						durationMs: Math.round(performance.now() - startedAt),
						startedAt,
					});
					onSettled(name, true);
				} else {
					const failed: TaskResult =
						winner.status === "ok"
							? {
									...winner,
									status: "failed",
									error: `service "${name}" exited before becoming ready`,
								}
							: winner;
					results.set(name, failed);
					onSettled(name, false);
				}
			} else {
				const result = await started.result;
				results.set(name, result);
				if (holdsSlot) {
					slots--;
				}
				onSettled(name, result.status === "ok");
			}
		})();
		running.add(tracked);
		tracked.finally(() => running.delete(tracked));
	};

	const onSettled = (name: string, ok: boolean): void => {
		if (ok) {
			for (const dependent of dependentsOf.get(name) ?? []) {
				const remaining = (indegree.get(dependent) as number) - 1;
				indegree.set(dependent, remaining);
				if (remaining === 0 && !aborting) {
					ready.push(dependent);
				}
			}
		} else {
			failedDownstream(name);
			if (!opts.continueOnError && !aborting) {
				aborting = true;
				void opts.onAbort();
			}
		}
		pump();
	};

	const pump = (): void => {
		while (!aborting && ready.length > 0 && slots < opts.concurrency) {
			launch(ready.shift() as string);
		}
	};

	// Drain: race the running set; awaiting lets finished tasks remove
	// themselves (their .finally is queued ahead of our continuation).
	pump();
	for (;;) {
		if (running.size === 0) {
			if (aborting || ready.length === 0) {
				break;
			}
			pump();
			if (running.size === 0) {
				break;
			}
		}
		await Promise.race(running);
	}

	// Tasks never reached (fail-fast) are marked aborted.
	for (const name of opts.planned) {
		if (!results.has(name)) {
			results.set(name, {
				name,
				status: "aborted",
				durationMs: 0,
			});
		}
	}

	const failed = [
		...results.values(),
	].some((r) => r.status === "failed" || r.status === "skipped" || r.status === "aborted");
	return {
		results,
		failed,
		services,
	};
}

/** True when the plan can never run two tasks at once (pure chain). */
export function isChain(tasks: ReadonlyMap<string, Task>, planned: readonly string[]): boolean {
	const subset = new Set(planned);
	const indegree = new Map<string, number>();
	const dependentsOf = new Map<string, string[]>();
	for (const name of planned) {
		const task = tasks.get(name) as Task;
		const deps = task.deps.filter((dep) => subset.has(dep));
		indegree.set(name, deps.length);
		for (const dep of deps) {
			let list = dependentsOf.get(dep);
			if (!list) {
				list = [];
				dependentsOf.set(dep, list);
			}
			list.push(name);
		}
	}
	let ready = planned.filter((name) => indegree.get(name) === 0);
	while (ready.length > 0) {
		if (ready.length > 1) {
			return false;
		}
		const current = ready[0] as string;
		ready = [];
		for (const dependent of dependentsOf.get(current) ?? []) {
			const remaining = (indegree.get(dependent) as number) - 1;
			indegree.set(dependent, remaining);
			if (remaining === 0) {
				ready.push(dependent);
			}
		}
	}
	return true;
}
