import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli } from "./helpers";

const WS = join(import.meta.dir, "..", "fixtures", "workspaces");

function planNames(stdout: string): string[] {
	return JSON.parse(stdout).plan.map((p: { name: string }) => p.name);
}

describe("workspaces", () => {
	test("ls at the root shows root and qualified member tasks", async () => {
		const { exitCode, stdout } = await runCli(WS, [
			"ls",
			"--json",
		]);
		expect(exitCode).toBe(0);
		const names = JSON.parse(stdout).tasks.map((t: { name: string }) => t.name);
		expect(names).toContain("root-only");
		expect(names).toContain("build");
		expect(names).toContain("api#build");
		expect(names).toContain("lib#build");
		expect(names).toContain("web#build");
		expect(names).toContain("api#api-only");
	});

	test("bare task name fans out to root + all members", async () => {
		const { exitCode, stdout } = await runCli(WS, [
			"--dry=json",
			"build",
		]);
		expect(exitCode).toBe(0);
		expect(planNames(stdout).toSorted()).toEqual([
			"api#build",
			"build",
			"lib#build",
			"web#build",
		]);
	});

	test("fan-out actually executes each member in its own cwd", async () => {
		const { exitCode, stdout } = await runCli(WS, [
			"build",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("BUILD in root");
		expect(stdout).toContain("BUILD in api");
		expect(stdout).toContain("BUILD in lib");
		expect(stdout).toContain("BUILD in web");
	});

	test("qualified name targets one member; member deps stay local", async () => {
		const { exitCode, stdout } = await runCli(WS, [
			"--dry=json",
			"api#api-only",
		]);
		expect(exitCode).toBe(0);
		expect(planNames(stdout)).toEqual([
			"api#build",
			"api#api-only",
		]);
	});

	test("--filter exact name", async () => {
		const { stdout } = await runCli(WS, [
			"-F",
			"api",
			"--dry=json",
			"build",
		]);
		expect(planNames(stdout)).toEqual([
			"api#build",
		]);
	});

	test("--filter ...name includes workspace dependencies", async () => {
		const { stdout } = await runCli(WS, [
			"-F",
			"...api",
			"--dry=json",
			"build",
		]);
		expect(planNames(stdout).toSorted()).toEqual([
			"api#build",
			"lib#build",
		]);
	});

	test("--filter name... includes dependents", async () => {
		const { stdout } = await runCli(WS, [
			"-F",
			"lib...",
			"--dry=json",
			"build",
		]);
		expect(planNames(stdout).toSorted()).toEqual([
			"api#build",
			"lib#build",
			"web#build",
		]);
	});

	test("--filter ./dir path prefix", async () => {
		const { stdout } = await runCli(WS, [
			"-F",
			"./packages/api",
			"--dry=json",
			"build",
		]);
		expect(planNames(stdout)).toEqual([
			"api#build",
		]);
	});

	test("--filter glob on names", async () => {
		const { stdout } = await runCli(WS, [
			"-F",
			"we*",
			"--dry=json",
			"build",
		]);
		expect(planNames(stdout)).toEqual([
			"web#build",
		]);
	});

	test("--filter with no match is a usage error", async () => {
		const { exitCode, stderr } = await runCli(WS, [
			"-F",
			"nope",
			"--dry=json",
			"build",
		]);
		expect(exitCode).toBe(2);
		expect(stderr).toContain("matched no workspace packages");
	});

	test("running from inside a member stays member-local", async () => {
		const { exitCode, stdout } = await runCli(join(WS, "packages", "api"), [
			"--dry=json",
			"build",
		]);
		expect(exitCode).toBe(0);
		expect(planNames(stdout)).toEqual([
			"build",
		]);
	});
});
