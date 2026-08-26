import { describe, expect, test } from "bun:test";
import { parseCli } from "~/cli/parse";
import { OutdoError } from "~/core/errors";

describe("parseCli", () => {
	test("no args -> list", () => {
		expect(parseCli([]).command).toEqual({
			kind: "list",
		});
	});

	test("ls --json", () => {
		const { command, flags } = parseCli([
			"ls",
			"--json",
		]);
		expect(command.kind).toBe("list");
		expect(flags.json).toBe(true);
	});

	test("single task run", () => {
		const { command } = parseCli([
			"build",
		]);
		expect(command).toEqual({
			kind: "run",
			tasks: [
				"build",
			],
			taskArgv: [],
			rest: [],
		});
	});

	test("multiple tasks", () => {
		const { command } = parseCli([
			"build",
			"test",
		]);
		expect(command).toEqual({
			kind: "run",
			tasks: [
				"build",
				"test",
			],
			taskArgv: [],
			rest: [],
		});
	});

	test("task flags stay unparsed for the task", () => {
		const { command } = parseCli([
			"deploy",
			"--dry-run",
			"-v",
			"value",
		]);
		expect(command).toEqual({
			kind: "run",
			tasks: [
				"deploy",
			],
			taskArgv: [
				"--dry-run",
				"-v",
				"value",
			],
			rest: [],
		});
	});

	test("rest after -- is captured verbatim", () => {
		const { command } = parseCli([
			"exec",
			"--",
			"--raw",
			"-x",
			"pos",
		]);
		expect(command).toEqual({
			kind: "run",
			tasks: [
				"exec",
			],
			taskArgv: [],
			rest: [
				"--raw",
				"-x",
				"pos",
			],
		});
	});

	test("global flags before the task", () => {
		const { command, flags } = parseCli([
			"--watch",
			"-j",
			"4",
			"--continue",
			"dev",
		]);
		expect(command.kind).toBe("run");
		expect(flags.watch).toBe(true);
		expect(flags.concurrency).toBe(4);
		expect(flags.continueOnError).toBe(true);
	});

	test("--dry and --dry=json", () => {
		expect(
			parseCli([
				"--dry",
				"build",
			]).flags.dry,
		).toBe("text");
		expect(
			parseCli([
				"--dry=json",
				"build",
			]).flags.dry,
		).toBe("json");
	});

	test("--no-color maps to color=never", () => {
		expect(
			parseCli([
				"--no-color",
			]).flags.color,
		).toBe("never");
	});

	test("--print-env <task>", () => {
		const { command } = parseCli([
			"--print-env",
			"deploy",
		]);
		expect(command).toEqual({
			kind: "print-env",
			task: "deploy",
		});
	});

	test("graph --dot", () => {
		expect(
			parseCli([
				"graph",
				"--dot",
			]).command,
		).toEqual({
			kind: "graph",
			dot: true,
		});
	});

	test("completion shell positional", () => {
		expect(
			parseCli([
				"completion",
				"zsh",
			]).command,
		).toEqual({
			kind: "completion",
			shell: "zsh",
		});
	});

	test("__complete words pass through raw", () => {
		const { command } = parseCli([
			"__complete",
			"outdo",
			"de",
			"--flag",
		]);
		expect(command).toEqual({
			kind: "complete",
			words: [
				"outdo",
				"de",
				"--flag",
			],
		});
	});

	test("unknown global flag before task is a usage error", () => {
		expect(() =>
			parseCli([
				"--nope",
				"build",
			]),
		).toThrow(OutdoError);
	});

	test("invalid concurrency is a usage error", () => {
		expect(() =>
			parseCli([
				"-j",
				"zero",
				"build",
			]),
		).toThrow("--concurrency");
	});

	test("filter is repeatable", () => {
		expect(
			parseCli([
				"-F",
				"api",
				"--filter",
				"web",
				"build",
			]).flags.filter,
		).toEqual([
			"api",
			"web",
		]);
	});
});
