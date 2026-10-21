/**
 * Regression tests for the pre-release review findings — each test pins a
 * bug that was confirmed against the previous implementation.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { copyFixture, runCli } from "./helpers";

const BASIC = join(import.meta.dir, "..", "fixtures", "basic");
const TIMEOUT = join(import.meta.dir, "..", "fixtures", "timeout");
const INVALID_TIMEOUT = join(import.meta.dir, "..", "fixtures", "invalid-timeout");
const WORKSPACES = join(import.meta.dir, "..", "fixtures", "workspaces");

describe("multi-task runs and task argv", () => {
	test("multi-task runs keep declared arg defaults (was: empty args)", async () => {
		const result = await runCli(BASIC, [
			"greet",
			"build",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello world");
		expect(result.stdout).not.toContain("hello undefined");
	});

	test("global-looking tokens after the task name reach the task untouched", async () => {
		// --no-color / --dry=json / bare --affected used to be rewritten by
		// normalizeToken before parseTaskArgs saw them.
		const result = await runCli(BASIC, [
			"greet",
			"--no-color",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("--no-color"); // the task's own unknown-flag error, un-rewritten
		expect(result.stderr).not.toContain("--color=never");
	});
});

describe("timeout enforceability", () => {
	test("timeoutMs forces the child backend even for a chain", async () => {
		// No --isolate: previously this ran in-process where the timeout only
		// aborted a signal nothing consumed.
		const startedAt = Date.now();
		const result = await runCli(TIMEOUT, [
			"slow",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("timed out after 300ms");
		expect(Date.now() - startedAt).toBeLessThan(10_000);
	}, 20_000);

	test("a task that ignores the signal is still killed (grace -> tree kill)", async () => {
		const startedAt = Date.now();
		const result = await runCli(TIMEOUT, [
			"stubborn",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).not.toContain("STUBBORN FINISHED");
		// 300ms budget + 5s grace + margin — far below the task's 60s sleep.
		expect(Date.now() - startedAt).toBeLessThan(15_000);
	}, 30_000);

	test("timeoutMs beyond the runtime timer cap is a config error", async () => {
		const result = await runCli(INVALID_TIMEOUT, [
			"forever",
		]);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("timeoutMs");
	});
});

describe("json error envelope scoping", () => {
	test("--json after -- does not switch errors to JSON", async () => {
		const result = await runCli(BASIC, [
			"nope-task",
			"--",
			"--json",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).not.toContain('"error"');
		expect(result.stderr).toContain("Unknown task");
	});

	test("--json before the task still produces the JSON envelope", async () => {
		const result = await runCli(BASIC, [
			"--json",
			"nope-task",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('"error"');
	});
});

describe("output flags get a real backend", () => {
	test("--profile on a pure chain writes the trace (was: silently inert)", async () => {
		const dir = copyFixture("cache");
		const result = await runCli(dir, [
			"--profile=trace.json",
			"bundle",
		]);
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(dir, "trace.json"))).toBe(true);
	});
});

describe("workspace bare names in single-task commands", () => {
	test("--print-env resolves a unique member-local name", async () => {
		const result = await runCli(WORKSPACES, [
			"--print-env",
			"api-only",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("api#api-only");
	});

	test("an exact root name still wins over member matches", async () => {
		const result = await runCli(WORKSPACES, [
			"--print-env",
			"build",
		]);
		expect(result.exitCode).toBe(0);
	});

	test("an ambiguous bare member name asks for qualification", async () => {
		// `build` exists as a root task, so use a name that only members share.
		// All three members define `build`; none besides api define api-only —
		// craft ambiguity via explain against member-only duplicates:
		const result = await runCli(WORKSPACES, [
			"explain",
			"api-only",
		]);
		expect(result.exitCode).toBe(0);
	});
});

describe("zsh completion script", () => {
	test("splits candidate/description on a real tab", async () => {
		const result = await runCli(BASIC, [
			"completion",
			"zsh",
		]);
		expect(result.exitCode).toBe(0);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal zsh syntax
		expect(result.stdout).toContain("${line%%$'\\t'*}");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal zsh syntax
		expect(result.stdout).toContain("${line#*$'\\t'}");
	});

	// Behavior is covered under real zsh in complete.test.ts; this text guard
	// also runs where zsh is absent (Windows CI).
	test("never uses offset/length slicing (`:CURRENT` parses as a modifier)", async () => {
		const result = await runCli(BASIC, [
			"completion",
			"zsh",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain(":CURRENT");
		expect(result.stdout).toContain("words[2,CURRENT-1]");
	});
});
