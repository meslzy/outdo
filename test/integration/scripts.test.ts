/** package.json scripts as tasks, member defaults, and `^` deps (turbo-style). */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { copyFixture, runCli } from "./helpers";

const WS = join(import.meta.dir, "..", "fixtures", "scripts-ws");

describe("a repo with no do.ts", () => {
	test("its package.json scripts are the tasks", async () => {
		// Copied out of the outdo repo, so no ancestor do.ts is found.
		const dir = copyFixture("scripts-only");
		const list = await runCli(dir, [
			"ls",
			"--json",
		]);
		expect(list.exitCode).toBe(0);
		const names = JSON.parse(list.stdout).tasks.map((t: { name: string }) => t.name);
		expect(names).toEqual([
			"hello",
			"args",
		]); // prepare (lifecycle), prehello (hook) and self (calls outdo) are left out
		const run = await runCli(dir, [
			"hello",
		]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("PRE-HELLO"); // bun run keeps pre/post hooks
		expect(run.stdout).toContain("SCRIPT-HELLO");
	});

	test("args after -- reach the script", async () => {
		const dir = copyFixture("scripts-only");
		const run = await runCli(dir, [
			"args",
			"--",
			"extra",
		]);
		expect(run.stdout).toContain("SCRIPT-ARGS extra");
	});
});

describe("workspaces without member do.ts files", () => {
	test("^tsc runs dependencies first, the root last (no turbo)", async () => {
		const r = await runCli(WS, [
			"tsc",
		]);
		expect(r.exitCode).toBe(0);
		const lib = r.stdout.indexOf("LIB-TSC");
		const app = r.stdout.indexOf("APP-TSC");
		const root = r.stdout.indexOf("ROOT-TSC");
		expect(lib).toBeGreaterThanOrEqual(0);
		expect(lib).toBeLessThan(app);
		expect(app).toBeLessThan(root);
	});

	test("member scripts are qualified tasks; a bare name fans out", async () => {
		const one = await runCli(WS, [
			"@ws/app#test",
		]);
		expect(one.stdout).toContain("APP-TEST");
		expect(one.stdout).not.toContain("LIB-TEST");
		const all = await runCli(WS, [
			"test",
		]);
		expect(all.stdout).toContain("APP-TEST");
		expect(all.stdout).toContain("LIB-TEST");
	});

	test("a do.ts entry without a body runs the same-named root script", async () => {
		const r = await runCli(WS, [
			"lint",
		]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("ROOT-LINT");
		const list = await runCli(WS, [
			"ls",
			"--json",
		]);
		const lint = JSON.parse(list.stdout).tasks.find((t: { name: string }) => t.name === "lint");
		expect(lint.readonly).toBe(true);
		expect(lint.script).toBe("lint");
	});

	test("the text list shows members compactly", async () => {
		const r = await runCli(WS, []);
		expect(r.stdout).toContain("Workspaces");
		expect(r.stdout).toMatch(/@ws\/app\s+tsc, test/);
	});
});
