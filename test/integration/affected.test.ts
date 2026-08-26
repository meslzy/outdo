import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyFixture, gitAvailable, initGit, runCli } from "./helpers";

const hasGit = await gitAvailable();

describe.skipIf(!hasGit)("--affected", () => {
	test("no changes vs HEAD: nothing runs, exit 0", async () => {
		const dir = copyFixture("cache");
		expect(await initGit(dir)).toBe(true);
		const result = await runCli(dir, [
			"--affected=HEAD",
			"bundle",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("COMPILED");
		expect(result.stderr).toContain("running 0 of 1");
	});

	test("an input edit affects the task and its dependents", async () => {
		const dir = copyFixture("cache");
		expect(await initGit(dir)).toBe(true);
		writeFileSync(join(dir, "src", "a.txt"), "changed\n");
		const result = await runCli(dir, [
			"--affected=HEAD",
			"bundle",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("running 1 of 1");
		expect(result.stdout).toContain("COMPILED");
		expect(result.stdout).toContain("BUNDLED");
	});

	test("untracked files count as changes", async () => {
		const dir = copyFixture("cache");
		expect(await initGit(dir)).toBe(true);
		writeFileSync(join(dir, "src", "new-input.txt"), "brand new\n");
		const result = await runCli(dir, [
			"--affected=HEAD",
			"compile",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("COMPILED");
	});

	test("workspace propagation: a lib change affects dependent packages only", async () => {
		const dir = copyFixture("workspaces");
		expect(await initGit(dir)).toBe(true);

		// Change only the api package: lib and web stay unaffected.
		writeFileSync(join(dir, "packages", "api", "extra.txt"), "x\n");
		const apiOnly = await runCli(dir, [
			"--affected=HEAD",
			"-F",
			"*",
			"build",
		]);
		expect(apiOnly.exitCode).toBe(0);
		expect(apiOnly.stderr).toContain("running 1 of 3");
		expect(apiOnly.stdout).toContain("BUILD in api");
		expect(apiOnly.stdout).not.toContain("BUILD in lib");
		expect(apiOnly.stdout).not.toContain("BUILD in web");
	});

	test("workspace propagation: changing lib affects its dependents", async () => {
		const dir = copyFixture("workspaces");
		expect(await initGit(dir)).toBe(true);
		writeFileSync(join(dir, "packages", "lib", "extra.txt"), "x\n");
		const result = await runCli(dir, [
			"--affected=HEAD",
			"-F",
			"*",
			"build",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("running 3 of 3");
		expect(result.stdout).toContain("BUILD in lib");
		expect(result.stdout).toContain("BUILD in api");
		expect(result.stdout).toContain("BUILD in web");
	});

	test("--dry=json carries the affected block", async () => {
		const dir = copyFixture("cache");
		expect(await initGit(dir)).toBe(true);
		writeFileSync(join(dir, "src", "a.txt"), "changed\n");
		const result = await runCli(dir, [
			"--affected=HEAD",
			"--dry=json",
			"bundle",
			"flagged",
		]);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout) as {
			affected?: {
				base: string;
				kept: string[];
				dropped: string[];
			};
		};
		expect(parsed.affected?.base).toBe("HEAD");
		expect(parsed.affected?.kept).toContain("bundle");
	});

	test("unknown base rev is a clear error", async () => {
		const dir = copyFixture("cache");
		expect(await initGit(dir)).toBe(true);
		const result = await runCli(dir, [
			"--affected=no-such-rev",
			"compile",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("unknown revision");
	});

	test("--affected --watch is a usage error", async () => {
		const dir = copyFixture("cache");
		expect(await initGit(dir)).toBe(true);
		const result = await runCli(dir, [
			"--affected=HEAD",
			"--watch",
			"compile",
		]);
		expect(result.exitCode).toBe(2);
	});

	test("outside a git repo: clear error", async () => {
		const dir = copyFixture("cache");
		const result = await runCli(dir, [
			"--affected=HEAD",
			"compile",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toLowerCase()).toContain("git");
	});
});
