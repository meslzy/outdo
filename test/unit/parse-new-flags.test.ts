import { describe, expect, test } from "bun:test";
import { parseCli } from "~/cli/parse";

describe("--affected parsing", () => {
	test("bare --affected: auto base, does not swallow the task name", () => {
		const { command, flags } = parseCli([
			"--affected",
			"build",
		]);
		expect(flags.affected).toEqual({
			base: undefined,
		});
		expect(command).toEqual({
			kind: "run",
			tasks: [
				"build",
			],
			taskArgv: [],
			rest: [],
		});
	});

	test("--affected=<rev> sets the base", () => {
		const { flags } = parseCli([
			"--affected=origin/main",
			"build",
		]);
		expect(flags.affected).toEqual({
			base: "origin/main",
		});
	});

	test("absent by default", () => {
		const { flags } = parseCli([
			"build",
		]);
		expect(flags.affected).toBe(false);
	});
});

describe("--profile parsing", () => {
	test("bare --profile defaults the trace path", () => {
		const { flags } = parseCli([
			"--profile",
			"build",
		]);
		expect(flags.profile).toBe(".bundo/trace.json");
	});

	test("--profile=<file> sets the path", () => {
		const { flags } = parseCli([
			"--profile=perf/trace.json",
			"build",
		]);
		expect(flags.profile).toBe("perf/trace.json");
	});

	test("absent by default", () => {
		const { flags } = parseCli([
			"build",
		]);
		expect(flags.profile).toBe(false);
	});
});

describe("explain parsing", () => {
	test("explain <task>", () => {
		const { command } = parseCli([
			"explain",
			"build",
		]);
		expect(command).toEqual({
			kind: "explain",
			task: "build",
		});
	});

	test("explain with no task is a usage error", () => {
		expect(() =>
			parseCli([
				"explain",
			]),
		).toThrow("explain requires exactly one task name");
	});

	test("explain with two tasks is a usage error", () => {
		expect(() =>
			parseCli([
				"explain",
				"a",
				"b",
			]),
		).toThrow("explain requires exactly one task name");
	});
});
