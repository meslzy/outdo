/**
 * Structured run reports: the `--json` run document, the human summary line
 * (wall clock + critical path), and Chrome trace-event export (--profile).
 */

import { cacheable } from "~/core/cache";
import { dim, red, yellow } from "~/core/logger";
import type { Task } from "~/core/model";
import type { TaskResult } from "~/core/scheduler";

export type CacheStatus = "hit" | "miss" | "disabled";

export interface ReportTask {
	name: string;
	status: "ok" | "failed" | "skipped" | "aborted" | "running";
	durationMs: number;
	/** Run-relative ms; absent when the task never started. */
	startMs?: number;
	/** Absent for still-running services. */
	endMs?: number;
	cache: CacheStatus;
	error?: string;
	attempts?: number;
}

export interface RunReport {
	ok: boolean;
	/** Wall-clock ISO timestamp of run start. */
	startedAt: string;
	/** Planned topological order. */
	tasks: ReportTask[];
	summary: {
		ok: number;
		failed: number;
		skipped: number;
		cached: number;
		running: number;
	};
	timing: {
		totalMs: number;
		criticalPathMs: number;
		criticalPath: string[];
		/** sum(task durations) / totalMs — effective concurrency. */
		parallelism: number;
	};
}

export interface BuildReportOptions {
	/** Planned tasks in topological order. */
	planned: readonly Task[];
	results: ReadonlyMap<string, TaskResult>;
	/** Names of persistent tasks still running when the DAG drained. */
	services: ReadonlySet<string>;
	/** performance.now() at run start/end. */
	runStart: number;
	runEnd: number;
	/** Date.now() at run start. */
	wallStart: number;
}

export function buildReport(opts: BuildReportOptions): RunReport {
	const tasks: ReportTask[] = [];
	let okCount = 0;
	let failedCount = 0;
	let skippedCount = 0;
	let cachedCount = 0;
	let runningCount = 0;
	let busyMs = 0;

	for (const task of opts.planned) {
		const result = opts.results.get(task.name);
		const running = task.persistent && opts.services.has(task.name);
		const status: ReportTask["status"] = running ? "running" : (result?.status ?? "aborted");
		const cache: CacheStatus =
			result?.cached === true
				? "hit"
				: (status === "ok" || status === "failed") && cacheable(task)
					? "miss"
					: "disabled";
		switch (status) {
			case "ok":
				okCount++;
				break;
			case "failed":
				failedCount++;
				break;
			case "running":
				runningCount++;
				break;
			default:
				skippedCount++;
				break;
		}
		if (result?.cached === true) {
			cachedCount++;
		}
		if (result !== undefined && (status === "ok" || status === "failed")) {
			busyMs += result.durationMs;
		}
		tasks.push({
			name: task.name,
			status,
			durationMs: result?.durationMs ?? 0,
			...(result?.startedAt !== undefined
				? {
						startMs: Math.max(0, Math.round(result.startedAt - opts.runStart)),
					}
				: {}),
			...(result?.endedAt !== undefined && !running
				? {
						endMs: Math.max(0, Math.round(result.endedAt - opts.runStart)),
					}
				: {}),
			cache,
			...(result?.error !== undefined && !running
				? {
						error: result.error,
					}
				: {}),
			...(result?.attempts !== undefined
				? {
						attempts: result.attempts,
					}
				: {}),
		});
	}

	const totalMs = Math.max(0, Math.round(opts.runEnd - opts.runStart));
	const critical = criticalPath(opts.planned, (name) => {
		const result = opts.results.get(name);
		if (result === undefined || (result.status !== "ok" && result.status !== "failed")) {
			return;
		}
		return result.durationMs;
	});

	return {
		ok: failedCount === 0 && skippedCount === 0,
		startedAt: new Date(opts.wallStart).toISOString(),
		tasks,
		summary: {
			ok: okCount,
			failed: failedCount,
			skipped: skippedCount,
			cached: cachedCount,
			running: runningCount,
		},
		timing: {
			totalMs,
			criticalPathMs: critical.totalMs,
			criticalPath: critical.path,
			parallelism: totalMs > 0 ? Math.round((busyMs / totalMs) * 100) / 100 : 1,
		},
	};
}

/**
 * Longest-duration path through the executed subgraph. `planned` must be in
 * topological order (dependencies first); tasks without a recorded duration
 * (skipped/aborted/still-running) do not participate.
 */
export function criticalPath(
	planned: readonly Task[],
	durationOf: (name: string) => number | undefined,
): {
	totalMs: number;
	path: string[];
} {
	const finish = new Map<string, number>();
	const pred = new Map<string, string | undefined>();
	let best: string | undefined;
	let bestMs = -1;

	for (const task of planned) {
		const dur = durationOf(task.name);
		if (dur === undefined) {
			continue;
		}
		let maxDep = 0;
		let via: string | undefined;
		for (const dep of task.deps) {
			const f = finish.get(dep);
			if (f !== undefined && f > maxDep) {
				maxDep = f;
				via = dep;
			}
		}
		const total = dur + maxDep;
		finish.set(task.name, total);
		pred.set(task.name, via);
		if (total >= bestMs) {
			bestMs = total;
			best = task.name;
		}
	}

	const path: string[] = [];
	for (let current = best; current !== undefined; current = pred.get(current)) {
		path.unshift(current);
	}
	return {
		totalMs: Math.max(0, Math.round(bestMs)),
		path,
	};
}

/** Greedy interval lane assignment: lowest lane whose last endMs <= startMs. */
export function assignLanes(tasks: readonly ReportTask[]): Map<string, number> {
	const laneEnds: number[] = [];
	const lanes = new Map<string, number>();
	const timed = tasks
		.filter((t) => t.startMs !== undefined)
		.sort((a, b) => (a.startMs as number) - (b.startMs as number));
	for (const task of timed) {
		const start = task.startMs as number;
		let lane = laneEnds.findIndex((end) => end <= start);
		if (lane === -1) {
			lane = laneEnds.length;
			laneEnds.push(0);
		}
		laneEnds[lane] = task.endMs ?? Number.POSITIVE_INFINITY;
		lanes.set(task.name, lane);
	}
	return lanes;
}

/** Chrome trace-event JSON (open in chrome://tracing or Perfetto). */
export function toChromeTrace(report: RunReport): unknown[] {
	const lanes = assignLanes(report.tasks);
	const events: unknown[] = [
		{
			name: "process_name",
			ph: "M",
			pid: 1,
			args: {
				name: "bundo",
			},
		},
	];
	for (const task of report.tasks) {
		if (task.startMs === undefined) {
			continue;
		}
		const endMs = task.endMs ?? report.timing.totalMs;
		events.push({
			name: task.name,
			cat: task.status,
			ph: "X",
			ts: Math.round(task.startMs * 1000),
			dur: Math.max(1, Math.round((endMs - task.startMs) * 1000)),
			pid: 1,
			tid: lanes.get(task.name) ?? 0,
			args: {
				status: task.status,
				cache: task.cache,
				durationMs: task.durationMs,
			},
		});
	}
	return events;
}

export function formatMs(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `— 5 ok (2 cached) · 3.2s total · critical path 2.8s (a → b → d)` */
export function formatSummary(report: RunReport): string {
	const s = report.summary;
	const parts: string[] = [];
	let okPart = `${s.ok} ok`;
	if (s.cached > 0) {
		okPart += ` (${s.cached} cached)`;
	}
	parts.push(okPart);
	if (s.failed > 0) {
		parts.push(red(`${s.failed} failed`));
	}
	if (s.skipped > 0) {
		parts.push(yellow(`${s.skipped} skipped`));
	}
	if (s.running > 0) {
		parts.push(`${s.running} running`);
	}
	let line = parts.join(", ");
	line += ` · ${formatMs(report.timing.totalMs)} total`;
	const path = report.timing.criticalPath;
	if (report.tasks.length > 1 && path.length > 1) {
		line += ` · critical path ${formatMs(report.timing.criticalPathMs)} (${path.join(" → ")})`;
	}
	return dim(`— ${line}`);
}
