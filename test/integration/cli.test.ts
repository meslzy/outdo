import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli } from "./helpers";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("outdo list", () => {
	test("renders the grouped task list", async () => {
		const { exitCode, stdout } = await runCli(join(FIXTURES, "basic"), []);
		expect(exitCode).toBe(0);
		expect(stdout).toMatchSnapshot();
	});

	test("ls --json emits the task model", async () => {
		const { exitCode, stdout } = await runCli(join(FIXTURES, "basic"), [
			"ls",
			"--json",
		]);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.tasks.map((t: { name: string }) => t.name)).toEqual([
			"docker:up",
			"db:reset",
			"build",
			"rest:dep",
			"rest:echo",
			"greet",
		]);
		const greet = parsed.tasks.find((t: { name: string }) => t.name === "greet");
		expect(greet.args.name).toEqual({
			type: "string",
			short: null,
			default: "world",
			required: false,
			description: "Who to greet",
		});
		const dbReset = parsed.tasks.find((t: { name: string }) => t.name === "db:reset");
		expect(dbReset.deps).toEqual([
			"docker:up",
		]);
	});

	test("cycle fixture exits 3 with the cycle path", async () => {
		const { exitCode, stderr } = await runCli(join(FIXTURES, "cycle"), []);
		expect(exitCode).toBe(3);
		expect(stderr).toContain("a -> b -> c -> a");
	});

	test("missing do.ts exits 3 with guidance", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const empty = mkdtempSync(join(tmpdir(), "outdo-empty-"));
		const { exitCode, stderr } = await runCli(empty, []);
		expect(exitCode).toBe(3);
		expect(stderr).toContain("No do.ts found");
	});

	test("--help prints usage", async () => {
		const { exitCode, stdout } = await runCli(join(FIXTURES, "basic"), [
			"--help",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage");
		expect(stdout).toContain("outdo <task>");
	});

	test("--version prints the package version", async () => {
		const { exitCode, stdout } = await runCli(join(FIXTURES, "basic"), [
			"--version",
		]);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
