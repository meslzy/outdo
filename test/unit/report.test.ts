import { describe, expect, test } from "bun:test";
import type { Task } from "~/core/model";
import type { ReportTask } from "~/core/report";
import { assignLanes, buildReport, criticalPath, formatMs, toChromeTrace } from "~/core/report";
import type { TaskResult } from "~/core/scheduler";

function makeTask(name: string, deps: string[] = [], persistent = false): Task {
	return {
		name,
		desc: undefined,
		group: undefined,
		deps,
		depEdges: deps.map((dep) => ({
			task: dep,
			optional: false,
			condition: undefined,
		})),
		env: undefined,
		args: {},
		inputs: [],
		outputs: [],
		watch: [],
		persistent,
		ready: undefined,
		retry: undefined,
		timeoutMs: undefined,
		cwd: process.cwd(),
		run: () => {},
		sourceConfig: "do.ts",
		localName: name,
	};
}

describe("criticalPath", () => {
	test("diamond: picks the slower branch", () => {
		// a -> (b: 300ms, c: 100ms) -> d
		const planned = [
			makeTask("a"),
			makeTask("b", [
				"a",
			]),
			makeTask("c", [
				"a",
			]),
			makeTask("d", [
				"b",
				"c",
			]),
		];
		const durations: Record<string, number> = {
			a: 50,
			b: 300,
			c: 100,
			d: 20,
		};
		const result = criticalPath(planned, (name) => durations[name]);
		expect(result.path).toEqual([
			"a",
			"b",
			"d",
		]);
		expect(result.totalMs).toBe(370);
	});

	test("skipped tasks do not participate", () => {
		const planned = [
			makeTask("a"),
			makeTask("b", [
				"a",
			]),
		];
		const result = criticalPath(planned, (name) => (name === "a" ? 100 : undefined));
		expect(result.path).toEqual([
			"a",
		]);
		expect(result.totalMs).toBe(100);
	});
});

describe("assignLanes", () => {
	test("overlapping tasks get distinct lanes; sequential reuse lane 0", () => {
		const tasks: ReportTask[] = [
			{
				name: "a",
				status: "ok",
				durationMs: 100,
				startMs: 0,
				endMs: 100,
				cache: "disabled",
			},
			{
				name: "b",
				status: "ok",
				durationMs: 100,
				startMs: 100,
				endMs: 200,
				cache: "disabled",
			},
			{
				name: "c",
				status: "ok",
				durationMs: 150,
				startMs: 120,
				endMs: 270,
				cache: "disabled",
			},
		];
		const lanes = assignLanes(tasks);
		expect(lanes.get("a")).toBe(0);
		expect(lanes.get("b")).toBe(0);
		expect(lanes.get("c")).toBe(1);
	});
});

describe("toChromeTrace", () => {
	test("emits X slices in microseconds", () => {
		const results = new Map<string, TaskResult>([
			[
				"a",
				{
					name: "a",
					status: "ok",
					durationMs: 100,
					startedAt: 1000,
					endedAt: 1100,
				},
			],
		]);
		const report = buildReport({
			planned: [
				makeTask("a"),
			],
			results,
			services: new Set(),
			runStart: 1000,
			runEnd: 1100,
			wallStart: Date.now(),
		});
		const events = toChromeTrace(report) as {
			ph: string;
			ts?: number;
			dur?: number;
			name: string;
		}[];
		const slice = events.find((e) => e.ph === "X");
		expect(slice?.name).toBe("a");
		expect(slice?.ts).toBe(0);
		expect(slice?.dur).toBe(100_000);
	});
});

describe("buildReport", () => {
	test("services map to running; cache hits counted", () => {
		const results = new Map<string, TaskResult>([
			[
				"svc",
				{
					name: "svc",
					status: "ok",
					durationMs: 0,
					startedAt: 0,
				},
			],
			[
				"cached",
				{
					name: "cached",
					status: "ok",
					durationMs: 0,
					startedAt: 5,
					endedAt: 5,
					cached: true,
				},
			],
		]);
		const report = buildReport({
			planned: [
				makeTask("svc", [], true),
				makeTask("cached"),
			],
			results,
			services: new Set([
				"svc",
			]),
			runStart: 0,
			runEnd: 100,
			wallStart: Date.now(),
		});
		const svc = report.tasks.find((t) => t.name === "svc");
		expect(svc?.status).toBe("running");
		expect(svc?.endMs).toBeUndefined();
		const cached = report.tasks.find((t) => t.name === "cached");
		expect(cached?.cache).toBe("hit");
		expect(report.summary).toEqual({
			ok: 1,
			failed: 0,
			skipped: 0,
			cached: 1,
			running: 1,
		});
		expect(report.ok).toBe(true);
	});
});

describe("formatMs", () => {
	test("ms below a second, decimal seconds above", () => {
		expect(formatMs(412)).toBe("412ms");
		expect(formatMs(3200)).toBe("3.2s");
	});
});
