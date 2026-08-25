import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "./helpers";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BASIC = join(FIXTURES, "basic");
const ENV = join(FIXTURES, "env-cascade");

describe("bundo run (sequential)", () => {
	test("runs a task and reports success", async () => {
		const { exitCode, stdout, stderr } = await runCli(BASIC, [
			"build",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("built");
		expect(stderr).toContain("✓ build");
	});

	test("runs dependencies first", async () => {
		const { exitCode, stderr } = await runCli(BASIC, [
			"db:reset",
		]);
		expect(exitCode).toBe(0);
		const upIdx = stderr.indexOf("✓ docker:up");
		const resetIdx = stderr.indexOf("✓ db:reset");
		expect(upIdx).toBeGreaterThanOrEqual(0);
		expect(resetIdx).toBeGreaterThan(upIdx);
	});

	test("unknown task exits 2 with did-you-mean", async () => {
		const { exitCode, stderr } = await runCli(BASIC, [
			"biuld",
		]);
		expect(exitCode).toBe(2);
		expect(stderr).toContain('Did you mean "build"?');
	});

	test("typed args flow into the task", async () => {
		const { exitCode, stdout } = await runCli(BASIC, [
			"greet",
			"--name",
			"meslzy",
		]);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe("hello meslzy");
	});

	test("arg defaults apply", async () => {
		const { stdout } = await runCli(BASIC, [
			"greet",
		]);
		expect(stdout.trim()).toBe("hello world");
	});

	test("unknown task flag exits 2 with a hint", async () => {
		const { exitCode, stderr } = await runCli(BASIC, [
			"greet",
			"--nmae",
			"x",
		]);
		expect(exitCode).toBe(2);
		expect(stderr).toContain('Did you mean "--name"?');
	});

	test("per-task --help renders flags", async () => {
		const { exitCode, stdout } = await runCli(BASIC, [
			"greet",
			"--help",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("--name");
		expect(stdout).toContain("Who to greet");
	});

	test("--dry prints the plan without running", async () => {
		const { exitCode, stdout } = await runCli(BASIC, [
			"--dry",
			"db:reset",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("docker:up");
		expect(stdout).not.toContain("db reset");
	});

	test("--dry=json is machine readable", async () => {
		const { stdout } = await runCli(BASIC, [
			"--dry=json",
			"db:reset",
		]);
		const plan = JSON.parse(stdout).plan;
		expect(plan.map((p: { name: string }) => p.name)).toEqual([
			"docker:up",
			"db:reset",
		]);
		expect(plan[1].requested).toBe(true);
		expect(plan[0].requested).toBe(false);
	});
});

describe("env cascade + validation", () => {
	test("cascade precedence in development", async () => {
		const { exitCode, stdout } = await runCli(
			ENV,
			[
				"env:dump",
			],
			{
				NODE_ENV: "development",
			},
		);
		expect(exitCode).toBe(0);
		const env = JSON.parse(stdout);
		expect(env.APP_NAME).toBe("bundo-fixture");
		expect(env.DATABASE_URL).toBe("postgres://localhost/local-override"); // .env.local wins
		expect(env.LOCAL_ONLY).toBe("yes");
		expect(env.COMPOSED).toBe("bundo-fixture-suffix"); // ${APP_NAME} expanded
		expect(env.LITERAL).toBe("bundo-fixture stays literal"); // Bun expands even in single quotes
	});

	test(".env.local beats .env.{NODE_ENV}", async () => {
		const { stdout } = await runCli(
			ENV,
			[
				"env:dump",
			],
			{
				NODE_ENV: "production",
			},
		);
		const env = JSON.parse(stdout);
		expect(env.SHARED).toBe("from-production");
		expect(env.DATABASE_URL).toBe("postgres://localhost/local-override");
	});

	test("process env beats every file", async () => {
		const { stdout } = await runCli(
			ENV,
			[
				"env:dump",
			],
			{
				NODE_ENV: "development",
				DATABASE_URL: "postgres://from-process/db",
			},
		);
		expect(JSON.parse(stdout).DATABASE_URL).toBe("postgres://from-process/db");
	});

	test("schema coercion produces typed values", async () => {
		const { exitCode, stdout } = await runCli(ENV, [
			"env:typed",
		]);
		expect(exitCode).toBe(0);
		const out = JSON.parse(stdout);
		expect(out.port).toBe(3000);
		expect(out.portType).toBe("number");
	});

	test("missing required env exits 3 before any side effect", async () => {
		const marker = join(ENV, "should-not-exist.txt");
		const { exitCode, stderr } = await runCli(ENV, [
			"side-effect",
		]);
		expect(exitCode).toBe(3);
		expect(stderr).toContain("Environment validation failed");
		expect(stderr).toContain("NEVER_SET_VAR_XYZ");
		expect(existsSync(marker)).toBe(false);
	});

	test("--print-env shows provenance and validates", async () => {
		const { exitCode, stdout } = await runCli(
			ENV,
			[
				"--print-env",
				"env:typed",
			],
			{
				NODE_ENV: "development",
			},
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain(".env.local");
		expect(stdout).toContain("overrides .env");
		expect(stdout).toContain("✓ schema valid");
	});

	test("--print-env --json reports failures with exit 3", async () => {
		const { exitCode, stdout } = await runCli(
			ENV,
			[
				"--print-env",
				"env:strict",
				"--json",
			],
			{
				NODE_ENV: "development",
			},
		);
		expect(exitCode).toBe(3);
		const parsed = JSON.parse(stdout);
		expect(parsed.validation.ok).toBe(false);
		expect(parsed.env.DATABASE_URL.source).toBe(".env.local");
		expect(parsed.env.DATABASE_URL.overrides).toEqual([
			".env",
		]);
	});
});

describe("passthrough routing (M4)", () => {
	test("rest goes only to the requested task, never deps", async () => {
		const { exitCode, stdout } = await runCli(BASIC, [
			"rest:echo",
			"--",
			"--raw",
			"-x",
			"pos",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('echo-rest:["--raw","-x","pos"]');
		expect(stdout).toContain("dep-rest:[]");
	});

	test("boolean short flag with value-less syntax", async () => {
		const { exitCode, stdout } = await runCli(BASIC, [
			"greet",
			"-h",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage: bundo greet");
	});
});
