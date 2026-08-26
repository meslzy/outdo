import { beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyFixture, runCli } from "./helpers";

let dir: string;

beforeEach(() => {
	dir = copyFixture("outputs");
});

describe("task data outputs", () => {
	test("consumer sees the producer's return value (sequential backend)", async () => {
		const result = await runCli(dir, [
			"consume",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("VERSION RAN tag=hello");
		expect(result.stdout).toContain("CONSUMED tag=hello n=42");
	});

	test("consumer sees the producer's return value (child backend, --isolate)", async () => {
		const result = await runCli(dir, [
			"--isolate",
			"consume",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("CONSUMED tag=hello n=42");
	});

	test("cached producers replay their output to consumers", async () => {
		const warm = await runCli(dir, [
			"consume",
		]);
		expect(warm.exitCode).toBe(0);

		// Invalidate only the consumer; the producer stays cached.
		writeFileSync(join(dir, "src", "note.txt"), "note-changed\n");
		const replayed = await runCli(dir, [
			"consume",
		]);
		expect(replayed.exitCode).toBe(0);
		expect(replayed.stdout).not.toContain("VERSION RAN");
		expect(replayed.stderr).toContain("version (cached)");
		expect(replayed.stdout).toContain("CONSUMED tag=hello n=42");
	});

	test("a changed dep output invalidates the consumer (dep-outputs fingerprint)", async () => {
		const first = await runCli(dir, [
			"use-stamp",
		]);
		expect(first.stdout).toContain("USED stamp=s1");

		// Second run: stamp reruns (not cacheable) but returns the same value,
		// so use-stamp is a cache hit.
		const second = await runCli(dir, [
			"use-stamp",
		]);
		expect(second.stdout).toContain("STAMP RAN");
		expect(second.stdout).not.toContain("USED");
		expect(second.stderr).toContain("use-stamp (cached)");

		// Changing the stamp changes the producer's OUTPUT (its fingerprint is
		// otherwise constant) — the consumer must rerun.
		writeFileSync(join(dir, "stamp.txt"), "s2\n");
		const third = await runCli(dir, [
			"use-stamp",
		]);
		expect(third.stdout).toContain("USED stamp=s2");
	});

	test("non-JSON output fails clearly in both backends", async () => {
		const sequential = await runCli(dir, [
			"bad",
		]);
		expect(sequential.exitCode).toBe(1);
		expect(sequential.stderr).toContain("non-JSON-serializable");

		const child = await runCli(dir, [
			"--isolate",
			"bad",
		]);
		expect(child.exitCode).toBe(1);
		expect(child.stderr).toContain("non-JSON-serializable");
	});
});
