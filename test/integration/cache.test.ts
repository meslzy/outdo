import { beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.test";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "cache");

let dir: string;

const INDEX = join(import.meta.dir, "..", "..", "src", "index.ts").replaceAll("\\", "/");

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "bundo-cache-"));
	cpSync(FIXTURE, dir, {
		recursive: true,
	});
	// The fixture's relative import breaks once copied out of the repo.
	const doTs = join(dir, "do.ts");
	const text = await Bun.file(doTs).text();
	writeFileSync(doTs, text.replace("../../../src/index", INDEX));
});

describe("fingerprint cache", () => {
	test("second run skips; --force reruns; edits invalidate", async () => {
		const first = await runCli(dir, [
			"compile",
		]);
		expect(first.exitCode).toBe(0);
		expect(first.stdout).toContain("COMPILED");

		const second = await runCli(dir, [
			"compile",
		]);
		expect(second.exitCode).toBe(0);
		expect(second.stdout).not.toContain("COMPILED");
		expect(second.stderr).toContain("(cached)");

		// touch without content change -> still cached (content hash)
		const now = new Date();
		utimesSync(join(dir, "src", "a.txt"), now, now);
		const touched = await runCli(dir, [
			"compile",
		]);
		expect(touched.stderr).toContain("(cached)");

		// content edit -> rerun
		writeFileSync(join(dir, "src", "a.txt"), "alpha-changed\n");
		const edited = await runCli(dir, [
			"compile",
		]);
		expect(edited.stdout).toContain("COMPILED");

		// --force bypasses the cache
		const forced = await runCli(dir, [
			"--force",
			"compile",
		]);
		expect(forced.stdout).toContain("COMPILED");
	});

	test("deleting a declared output forces a rerun", async () => {
		await runCli(dir, [
			"compile",
		]);
		rmSync(join(dir, "out"), {
			recursive: true,
			force: true,
		});
		const rerun = await runCli(dir, [
			"compile",
		]);
		expect(rerun.stdout).toContain("COMPILED");
	});

	test("upstream fingerprint change cascades to dependents", async () => {
		await runCli(dir, [
			"bundle",
		]);
		const cachedRun = await runCli(dir, [
			"bundle",
		]);
		expect(cachedRun.stdout).not.toContain("BUNDLED");
		// change compile's input -> compile reruns -> new output -> bundle reruns
		writeFileSync(join(dir, "src", "a.txt"), "cascade\n");
		const rerun = await runCli(dir, [
			"bundle",
		]);
		expect(rerun.stdout).toContain("COMPILED");
		expect(rerun.stdout).toContain("BUNDLED");
	});

	test("changed args invalidate", async () => {
		await runCli(dir, [
			"flagged",
		]);
		const cached = await runCli(dir, [
			"flagged",
		]);
		expect(cached.stdout).not.toContain("FLAGGED");
		const changed = await runCli(dir, [
			"flagged",
			"--mode",
			"prod",
		]);
		expect(changed.stdout).toContain("FLAGGED mode=prod");
	});

	test("changed env schema output invalidates", async () => {
		await runCli(dir, [
			"enved",
		]);
		const cached = await runCli(dir, [
			"enved",
		]);
		expect(cached.stdout).not.toContain("ENVED");
		const changed = await runCli(
			dir,
			[
				"enved",
			],
			{
				CACHE_SALT: "different",
			},
		);
		expect(changed.stdout).toContain("ENVED salt=different");
	});

	test("--dry reports would-skip status", async () => {
		await runCli(dir, [
			"compile",
		]);
		const dry = await runCli(dir, [
			"--dry=json",
			"compile",
		]);
		const plan = JSON.parse(dry.stdout).plan;
		expect(plan[0].cached).toBe(true);
	});
});
