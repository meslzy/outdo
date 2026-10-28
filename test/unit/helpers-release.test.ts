/** Small pure helpers behind the big-release features. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScripts } from "~/cli/load";
import { localInstall } from "~/cli/local";
import { filterItems, scoreItem } from "~/cli/pick";
import { servicesInFile } from "~/compose";
import { annotationsFromOutput, formatAnnotation, githubBase, outputKey, workflowYaml } from "~/core/github";
import { buildRemoteCommand, shellQuote } from "~/core/ssh";

const scratch = mkdtempSync(join(tmpdir(), "outdo-helpers-"));
afterAll(() => {
	rmSync(scratch, {
		recursive: true,
		force: true,
	});
});

describe("ssh quoting", () => {
	test("safe words stay bare, others are single-quoted", () => {
		expect(shellQuote("main")).toBe("main");
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
		expect(shellQuote("")).toBe("''");
	});

	test("templates escape values, expand arrays, keep raw", () => {
		const cmd = (strings: TemplateStringsArray, ...values: unknown[]): string => buildRemoteCommand(strings, values);
		expect(
			cmd`git checkout ${"feat/x y"} ${[
				"--",
				"a b",
			]} ${{
				raw: "&& echo ok",
			}}`,
		).toBe("git checkout 'feat/x y' -- 'a b' && echo ok");
	});
});

describe("GitHub helpers", () => {
	test("annotations escape data and properties", () => {
		expect(
			formatAnnotation({
				file: "src/a,b.ts",
				line: 3,
				title: "t: x",
				message: "50%\nnext",
			}),
		).toBe("::error file=src/a%2Cb.ts,line=3,title=t%3A x::50%25%0Anext");
	});

	test("tsc, biome and bun test failures become annotations", () => {
		const notes = annotationsFromOutput("check", [
			"src/a.ts(12,5): error TS2322: Type 'x' is not assignable to type 'y'.",
			"src/b.ts:3:7 lint/style/useConst FIXABLE ━━━━━━━━━━",
			"(fail) math > adds [1.20ms]",
			"just noise",
		]);
		expect(notes).toEqual([
			{
				file: "src/a.ts",
				line: 12,
				col: 5,
				title: "check: TS2322",
				message: "Type 'x' is not assignable to type 'y'.",
			},
			{
				file: "src/b.ts",
				line: 3,
				col: 7,
				title: "check: lint/style/useConst",
				message: "lint/style/useConst",
			},
			{
				title: "check: test failed",
				message: "math > adds",
			},
		]);
	});

	test("base: PR base branch, or the previous push", () => {
		expect(
			githubBase({
				GITHUB_BASE_REF: "main",
			}),
		).toEqual({
			branch: "origin/main",
		});
		const event = join(scratch, "event.json");
		writeFileSync(
			event,
			JSON.stringify({
				before: "0123456789abcdef0123456789abcdef01234567",
			}),
		);
		expect(
			githubBase({
				GITHUB_EVENT_NAME: "push",
				GITHUB_EVENT_PATH: event,
			}),
		).toEqual({
			commit: "0123456789abcdef0123456789abcdef01234567",
		});
		writeFileSync(
			event,
			JSON.stringify({
				before: "0000000000000000000000000000000000000000",
			}),
		);
		expect(
			githubBase({
				GITHUB_EVENT_NAME: "push",
				GITHUB_EVENT_PATH: event,
			}),
		).toBeUndefined();
		expect(githubBase({})).toBeUndefined();
	});

	test("output keys and the generated workflow", () => {
		expect(outputKey("@acme/api#db:reset")).toBe("_acme_api_db_reset");
		const yaml = workflowYaml("check", "main");
		expect(yaml).toContain("fetch-depth: 0");
		expect(yaml).toContain("bunx outdo ci check");
		expect(yaml).toContain("branches: [main]");
	});
});

describe("picker filtering", () => {
	const items = [
		{
			name: "db:reset",
			desc: "Wipe the schema",
		},
		{
			name: "db:restore",
			desc: "Restore from a dump",
		},
		{
			name: "deploy",
			desc: "Ship it",
		},
	];

	test("prefix beats substring beats description beats subsequence", () => {
		expect(scoreItem(items[0] as (typeof items)[number], "db:re")).toBeGreaterThan(
			scoreItem(items[2] as (typeof items)[number], "schema"),
		);
		// Subsequence only: the shorter name ranks first.
		expect(filterItems(items, "rst").map((i) => i.name)).toEqual([
			"db:reset",
			"db:restore",
		]);
		expect(filterItems(items, "ship").map((i) => i.name)).toEqual([
			"deploy",
		]);
		expect(filterItems(items, "zzz")).toEqual([]);
		expect(filterItems(items, "").length).toBe(3);
	});
});

describe("compose service scan", () => {
	test("reads top-level service names only", () => {
		expect(
			servicesInFile(
				[
					"name: stack",
					"services:",
					"  api:",
					"    image: x",
					"    ports:",
					"      - 80:80",
					"  # comment",
					'  "web":',
					"    build: .",
					"volumes:",
					"  data:",
				].join("\n"),
			),
		).toEqual([
			"api",
			"web",
		]);
		expect(servicesInFile("version: 3\n")).toEqual([]);
	});
});

describe("package.json scripts", () => {
	test("lifecycle hooks, pre/post scripts and outdo calls are not tasks", () => {
		const pkg = join(scratch, "package.json");
		writeFileSync(
			pkg,
			JSON.stringify({
				scripts: {
					build: "tsc",
					prebuild: "rm -rf dist",
					postbuild: "echo done",
					preview: "vite preview",
					prepare: "git config core.hooksPath .githooks",
					postinstall: "patch",
					gate: "bunx outdo gate",
					check: "outdo check",
					outdo: "bun src/cli.ts",
					lint: "biome check .",
				},
			}),
		);
		expect(readScripts(pkg)).toEqual({
			build: "tsc",
			preview: "vite preview",
			lint: "biome check .",
		});
	});
});

describe("local install hand-over", () => {
	const project = join(scratch, "project");
	const local = join(project, "node_modules", "@meslzy", "outdo", "dist");
	mkdirSync(local, {
		recursive: true,
	});
	writeFileSync(join(local, "cli.js"), "// local copy\n");
	const globalBin = join(scratch, "global", "cli.js");
	mkdirSync(join(scratch, "global"), {
		recursive: true,
	});
	writeFileSync(globalBin, "// global copy\n");
	mkdirSync(join(project, "src", "deep"), {
		recursive: true,
	});

	test("a global build hands over to the project's copy (from any subdirectory)", () => {
		const found = localInstall(globalBin, join(project, "src", "deep"), {});
		expect(found?.replaceAll("\\", "/").endsWith("node_modules/@meslzy/outdo/dist/cli.js")).toBe(true);
	});

	test("never from source, from itself, or when disabled", () => {
		expect(localInstall(join(scratch, "src", "cli.ts"), project, {})).toBeUndefined();
		expect(localInstall(join(local, "cli.js"), project, {})).toBeUndefined();
		expect(
			localInstall(globalBin, project, {
				OUTDO_NO_LOCAL: "1",
			}),
		).toBeUndefined();
		expect(localInstall(globalBin, scratch, {})).toBeUndefined();
	});
});
