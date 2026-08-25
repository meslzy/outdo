import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunReport } from "~/core/report";
import { copyFixture, runCli } from "./helpers";

describe("run report (--json)", () => {
	test("stdout is a single parseable report; logs stay on stderr", async () => {
		const dir = copyFixture("diamond");
		const result = await runCli(dir, [
			"--json",
			"d",
		]);
		expect(result.exitCode).toBe(0);
		// The whole stdout must parse — task logs may not leak into it.
		const report = JSON.parse(result.stdout) as RunReport;
		expect(result.stderr).toContain("start");

		expect(report.ok).toBe(true);
		expect(report.tasks).toHaveLength(4);
		expect(report.tasks[0]?.name).toBe("a");
		expect(report.tasks.at(-1)?.name).toBe("d");
		expect(report.summary).toEqual({
			ok: 4,
			failed: 0,
			skipped: 0,
			cached: 0,
			running: 0,
		});
		expect(report.timing.criticalPath[0]).toBe("a");
		expect(report.timing.criticalPath.at(-1)).toBe("d");
		expect(report.timing.criticalPathMs).toBeLessThanOrEqual(report.timing.totalMs);
		for (const task of report.tasks) {
			expect(task.status).toBe("ok");
			expect(task.startMs).toBeGreaterThanOrEqual(0);
			expect(task.endMs).toBeGreaterThanOrEqual(task.startMs as number);
		}
	});

	test("failure: report still emitted, error JSON on stderr, exit 1", async () => {
		const dir = copyFixture("fail");
		const result = await runCli(
			dir,
			[
				"--json",
				"all",
			],
			{
				BUNDO_TEST_FAST_SLOW: "1",
			},
		);
		expect(result.exitCode).toBe(1);
		const report = JSON.parse(result.stdout) as RunReport;
		expect(report.ok).toBe(false);
		const boom = report.tasks.find((t) => t.name === "boom");
		expect(boom?.status).toBe("failed");
		expect(boom?.error).toBeTruthy();
		expect(report.summary.failed).toBeGreaterThanOrEqual(1);
		expect(result.stderr).toContain('"error"');
	});

	test("cache hits are reported", async () => {
		const dir = copyFixture("cache");
		await runCli(dir, [
			"compile",
		]);
		const result = await runCli(dir, [
			"--json",
			"compile",
		]);
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout) as RunReport;
		expect(report.tasks[0]?.cache).toBe("hit");
		expect(report.summary.cached).toBe(1);
	});

	test("--profile writes a Chrome trace with parallel lanes", async () => {
		const dir = copyFixture("diamond");
		const result = await runCli(dir, [
			"--profile=trace.json",
			"d",
		]);
		expect(result.exitCode).toBe(0);
		const tracePath = join(dir, "trace.json");
		expect(existsSync(tracePath)).toBe(true);
		const events = (await Bun.file(tracePath).json()) as {
			name: string;
			ph: string;
			ts: number;
			dur: number;
			tid: number;
		}[];
		const slices = events.filter((e) => e.ph === "X");
		expect(slices).toHaveLength(4);
		// b and c overlap in the diamond — they must land on different lanes.
		const b = slices.find((e) => e.name === "b");
		const c = slices.find((e) => e.name === "c");
		expect(b).toBeDefined();
		expect(c).toBeDefined();
		const overlap =
			(b?.ts as number) < (c?.ts as number) + (c?.dur as number)
			&& (c?.ts as number) < (b?.ts as number) + (b?.dur as number);
		if (overlap) {
			expect(b?.tid).not.toBe(c?.tid);
		}
	});

	test("human summary line includes total and critical path", async () => {
		const dir = copyFixture("diamond");
		const result = await runCli(dir, [
			"d",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toMatch(/— 4 ok · \d+(\.\d+)?m?s total · critical path/);
	});

	test("--watch --json is a usage error", async () => {
		const dir = copyFixture("diamond");
		const result = await runCli(dir, [
			"--watch",
			"--json",
			"d",
		]);
		expect(result.exitCode).toBe(2);
	});

	test("--watch --profile is a usage error", async () => {
		const dir = copyFixture("diamond");
		const result = await runCli(dir, [
			"--watch",
			"--profile=t.json",
			"d",
		]);
		expect(result.exitCode).toBe(2);
	});
});
