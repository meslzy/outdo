import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allPatternsMatchSomething, compile, expand, matches, staticRoots } from "~/core/globs";

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "bundo-globs-"));
	mkdirSync(join(dir, "src", "sub"), {
		recursive: true,
	});
	writeFileSync(join(dir, "src", "a.txt"), "a");
	writeFileSync(join(dir, "src", "sub", "b.txt"), "b");
	writeFileSync(join(dir, "src", "skip.txt"), "s");
	writeFileSync(join(dir, ".env"), "X=1");
	writeFileSync(join(dir, "src", ".hidden.txt"), "h");
});

describe("compile + matches", () => {
	test("positive and negative patterns partition", () => {
		const set = compile([
			"src/**/*.txt",
			"!src/skip.txt",
		]);
		expect(matches(set, "src/a.txt")).toBe(true);
		expect(matches(set, "src/sub/b.txt")).toBe(true);
		expect(matches(set, "src/skip.txt")).toBe(false);
		expect(matches(set, "other/a.txt")).toBe(false);
	});

	test("backslashes normalize before matching", () => {
		const set = compile([
			"src/**/*.txt",
		]);
		expect(matches(set, "src\\sub\\b.txt")).toBe(true);
	});

	test("dotfiles are excluded unless a pattern names a dot segment", () => {
		// Aligned with expand()'s dot:false — a wildcard must not match what the
		// fingerprint would never hash.
		const wild = compile([
			"src/**",
		]);
		expect(matches(wild, "src/.hidden.txt")).toBe(false);
		expect(matches(wild, "src/.cache/x.txt")).toBe(false);

		const explicit = compile([
			".env",
		]);
		expect(explicit.allowDot).toBe(true);
		expect(matches(explicit, ".env")).toBe(true);
	});
});

describe("expand", () => {
	test("returns sorted relative paths, honoring negation and dot:false", async () => {
		const files = await expand(
			[
				"src/**/*.txt",
				"!src/skip.txt",
			],
			dir,
		);
		expect(files).toEqual([
			"src/a.txt",
			"src/sub/b.txt",
		]);
	});
});

describe("allPatternsMatchSomething", () => {
	test("true when every positive pattern hits at least one file", async () => {
		expect(
			await allPatternsMatchSomething(
				[
					"src/**/*.txt",
					"!ignored/**",
				],
				dir,
			),
		).toBe(true);
	});

	test("false when any positive pattern is empty", async () => {
		expect(
			await allPatternsMatchSomething(
				[
					"src/**/*.txt",
					"missing/**",
				],
				dir,
			),
		).toBe(false);
	});
});

describe("staticRoots", () => {
	test("takes the static prefix of each pattern", () => {
		expect(
			staticRoots([
				"src/**/*.ts",
				"!dist/**",
			]),
		).toEqual([
			"src",
		]);
	});

	test("drops a trailing filename component", () => {
		expect(
			staticRoots([
				"a/b/file.txt",
			]),
		).toEqual([
			"a/b",
		]);
	});

	test("deduplicates nested roots, keeping the outermost", () => {
		expect(
			staticRoots([
				"src/**",
				"src/sub/**",
			]),
		).toEqual([
			"src",
		]);
	});

	test("fully-dynamic patterns watch the cwd", () => {
		expect(
			staticRoots([
				"*.ts",
			]),
		).toEqual([
			".",
		]);
	});
});
