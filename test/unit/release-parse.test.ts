import { describe, expect, test } from "bun:test";
import { extractRunnerFlags, parseCli } from "~/cli/parse";
import { OutdoError } from "~/core/errors";

describe("new commands", () => {
	test("run <task> is an explicit run (for tasks named like commands)", () => {
		expect(
			parseCli([
				"run",
				"ci",
				"--fast",
			]).command,
		).toEqual({
			kind: "run",
			tasks: [
				"ci",
			],
			taskArgv: [
				"--fast",
			],
			rest: [],
		});
	});

	test("ci <task> turns on CI mode; its own flags may follow the task", () => {
		const { command, flags } = parseCli([
			"ci",
			"check",
			"--all",
			"--base",
			"origin/dev",
		]);
		expect(flags.ci).toBe(true);
		expect(command).toEqual({
			kind: "ci",
			tasks: [
				"check",
			],
			taskArgv: [],
			rest: [],
			all: true,
			base: "origin/dev",
		});
	});

	test("ci init", () => {
		expect(
			parseCli([
				"ci",
				"init",
			]).command.kind,
		).toBe("ci-init");
	});

	test("affected with --github-output", () => {
		expect(
			parseCli([
				"affected",
				"deploy",
				"api",
				"--github-output",
			]).command,
		).toEqual({
			kind: "affected",
			tasks: [
				"deploy",
				"api",
			],
			base: undefined,
			githubOutput: true,
		});
	});

	test("bg verbs", () => {
		expect(
			parseCli([
				"bg",
				"start",
				"server",
				"--port",
				"1",
			]).command,
		).toEqual({
			kind: "bg-start",
			tasks: [
				"server",
			],
			taskArgv: [
				"--port",
				"1",
			],
			rest: [],
		});
		expect(
			parseCli([
				"bg",
			]).command,
		).toEqual({
			kind: "bg-ps",
		});
		expect(
			parseCli([
				"bg",
				"logs",
				"server",
				"--follow",
			]).command,
		).toEqual({
			kind: "bg-logs",
			task: "server",
			follow: true,
		});
		expect(
			parseCli([
				"bg",
				"stop",
			]).command,
		).toEqual({
			kind: "bg-stop",
			tasks: [],
		});
	});

	test("hooks actions", () => {
		expect(
			parseCli([
				"hooks",
				"run",
				"pre-commit",
				"--",
				"msg",
			]).command,
		).toEqual({
			kind: "hooks",
			action: "run",
			hook: "pre-commit",
			rest: [
				"msg",
			],
		});
		expect(() =>
			parseCli([
				"hooks",
				"wat",
			]),
		).toThrow(OutdoError);
	});

	test("prune needs --docker", () => {
		expect(
			parseCli([
				"prune",
				"--docker",
				"--out",
				"build",
			]).command,
		).toEqual({
			kind: "prune",
			out: "build",
		});
		expect(() =>
			parseCli([
				"prune",
			]),
		).toThrow(OutdoError);
	});

	test("-i opens the picker; mcp and doctor", () => {
		expect(
			parseCli([
				"-i",
			]).command.kind,
		).toBe("pick");
		expect(
			parseCli([
				"mcp",
			]).command.kind,
		).toBe("mcp");
		expect(
			parseCli([
				"doctor",
			]).command.kind,
		).toBe("doctor");
	});

	test("global --mode/--yes/--from/--until before the task", () => {
		const { flags } = parseCli([
			"--mode",
			"prod",
			"-y",
			"--from=tsc",
			"gate",
		]);
		expect(flags.mode).toBe("prod");
		expect(flags.yes).toBe(true);
		expect(flags.from).toBe("tsc");
	});
});

describe("extractRunnerFlags", () => {
	test("pulls runner flags out of a task's argv", () => {
		expect(
			extractRunnerFlags(
				[
					"--mode",
					"prod",
					"--dry-run",
					"--yes",
					"--from=typegen",
				],
				new Set(),
			),
		).toEqual({
			argv: [
				"--dry-run",
			],
			mode: "prod",
			yes: true,
			from: "typegen",
		});
	});

	test("a task that declares the flag keeps it", () => {
		expect(
			extractRunnerFlags(
				[
					"--mode",
					"fast",
				],
				new Set([
					"mode",
				]),
			),
		).toEqual({
			argv: [
				"--mode",
				"fast",
			],
		});
	});

	test("a value-less --mode is a usage error", () => {
		expect(() =>
			extractRunnerFlags(
				[
					"--mode",
				],
				new Set(),
			),
		).toThrow(OutdoError);
	});
});

describe("short runner flags and bg logs -f", () => {
	test("-y and -m after the task name, unless the task claims the alias", () => {
		expect(
			extractRunnerFlags(
				[
					"-m",
					"prod",
					"-y",
				],
				new Set(),
			),
		).toEqual({
			argv: [],
			mode: "prod",
			yes: true,
		});
		expect(
			extractRunnerFlags(
				[
					"-y",
				],
				new Set(),
				new Set([
					"y",
				]),
			),
		).toEqual({
			argv: [
				"-y",
			],
		});
	});

	test("bg logs -f follows", () => {
		expect(
			parseCli([
				"bg",
				"logs",
				"dev",
				"-f",
			]).command,
		).toEqual({
			kind: "bg-logs",
			task: "dev",
			follow: true,
		});
	});
});
