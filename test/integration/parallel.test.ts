import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli } from "./helpers";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const DIAMOND = join(FIXTURES, "diamond");
const FAIL = join(FIXTURES, "fail");
const SERVICES = join(FIXTURES, "services");

interface Stamp {
	task: string;
	phase: string;
	at: number;
}

function parseStamps(stdout: string): Stamp[] {
	const stamps: Stamp[] = [];
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\w+)\s*\|\s*(\w+) (start|end) (\d+)$/.exec(line);
		if (match) {
			stamps.push({
				task: match[2] as string,
				phase: match[3] as string,
				at: Number(match[4]),
			});
		}
	}
	return stamps;
}

function at(stamps: Stamp[], task: string, phase: string): number {
	const found = stamps.find((s) => s.task === task && s.phase === phase);
	if (!found) {
		throw new Error(`missing stamp ${task}/${phase}`);
	}
	return found.at;
}

describe("parallel DAG execution", () => {
	test("diamond runs deps in order and branches concurrently", async () => {
		const { exitCode, stdout, stderr } = await runCli(DIAMOND, [
			"d",
		]);
		expect(exitCode).toBe(0);
		const stamps = parseStamps(stdout);
		// topology respected
		expect(at(stamps, "a", "end")).toBeLessThanOrEqual(at(stamps, "b", "start"));
		expect(at(stamps, "a", "end")).toBeLessThanOrEqual(at(stamps, "c", "start"));
		expect(at(stamps, "b", "end")).toBeLessThanOrEqual(at(stamps, "d", "start"));
		expect(at(stamps, "c", "end")).toBeLessThanOrEqual(at(stamps, "d", "start"));
		// b and c overlapped
		expect(at(stamps, "b", "start")).toBeLessThan(at(stamps, "c", "end"));
		expect(at(stamps, "c", "start")).toBeLessThan(at(stamps, "b", "end"));
		expect(stderr).toContain("4 ok");
	});

	test("-j 1 serializes the branches", async () => {
		const { exitCode, stdout } = await runCli(DIAMOND, [
			"-j",
			"1",
			"d",
		]);
		expect(exitCode).toBe(0);
		const stamps = parseStamps(stdout);
		const bRange = [
			at(stamps, "b", "start"),
			at(stamps, "b", "end"),
		] as const;
		const cRange = [
			at(stamps, "c", "start"),
			at(stamps, "c", "end"),
		] as const;
		const disjoint = bRange[1] <= cRange[0] || cRange[1] <= bRange[0];
		expect(disjoint).toBe(true);
	});

	test("grouped log order keeps each task's lines contiguous", async () => {
		const { exitCode, stdout } = await runCli(DIAMOND, [
			"--log-order=grouped",
			"d",
		]);
		expect(exitCode).toBe(0);
		const owners = stdout
			.split("\n")
			.map((line) => /^\s*(\w+)\s*\|/.exec(line)?.[1])
			.filter((owner): owner is string => owner !== undefined);
		// once we leave a task's block we must never see it again
		const seen = new Set<string>();
		let current: string | undefined;
		for (const owner of owners) {
			if (owner !== current) {
				expect(seen.has(owner)).toBe(false);
				seen.add(owner);
				current = owner;
			}
		}
	});

	test("failure skips dependents, aborts siblings, exits 1", async () => {
		const started = performance.now();
		const { exitCode, stdout, stderr } = await runCli(FAIL, [
			"all",
		]);
		const elapsed = performance.now() - started;
		expect(exitCode).toBe(1);
		expect(stderr).toContain("kaboom");
		expect(stdout).not.toContain("downstream should never run");
		expect(stdout).toContain("slow aborted"); // cooperative abort honored
		expect(stderr).toContain("skipped");
		expect(elapsed).toBeLessThan(9000); // slow (10s) did not run to completion
	});

	test("--continue still runs independent siblings after a failure", async () => {
		const { exitCode, stdout } = await runCli(
			FAIL,
			[
				"--continue",
				"-j",
				"1",
				"boom",
				"slow",
			],
			{
				BUNDO_TEST_FAST_SLOW: "1",
			},
		);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("slow started");
	});

	test("--isolate forces the child backend for a chain", async () => {
		const { exitCode, stdout } = await runCli(FAIL, [
			"--isolate",
			"ok",
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("ok ran");
		expect(stdout).toContain("|"); // prefixed output proves child mode
	});
});

describe("services", () => {
	test("dependent starts once the service has spawned; crash fails the run", async () => {
		const { exitCode, stdout, stderr } = await runCli(SERVICES, [
			"uses:flaky",
		]);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("dependent ran while service alive");
		expect(stderr).toContain('Service "svc:flaky" exited unexpectedly');
	});
});
