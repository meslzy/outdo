/** Unit coverage for the core modules behind the big release. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type ComposeOptions, compose, runCompose } from "~/compose";
import { jsonSchemaOf, normalizeArgs, renderTaskHelp, wantsTaskHelp } from "~/core/argspec";
import { findConfig, loadConfigFile, normalizeEntry } from "~/core/config";
import { OutdoError } from "~/core/errors";
import { appendStepSummary, inGithubActions, summaryMarkdown, writeGithubOutputs } from "~/core/github";
import type { RunReport } from "~/core/report";
import { makeSsh } from "~/core/ssh";
import { didYouMean, levenshtein } from "~/core/util";
import { applyFilters, enumerateMembers, findWorkspaceRoot, workspacePatternsOf } from "~/core/workspaces";
import { defineTasks, from, isNamespace, isTasks, ns, optional, optionsOf, task } from "~/index";

const INDEX = join(import.meta.dir, "..", "..", "src", "index.ts").replaceAll("\\", "/");
const scratch = mkdtempSync(join(tmpdir(), "outdo-core-"));
afterAll(() => {
	rmSync(scratch, {
		recursive: true,
		force: true,
	});
});

function dir(name: string): string {
	const path = join(scratch, name);
	mkdirSync(path, {
		recursive: true,
	});
	return path;
}

describe("util", () => {
	test("levenshtein and did-you-mean", () => {
		expect(levenshtein("build", "build")).toBe(0);
		expect(levenshtein("", "abc")).toBe(3);
		expect(levenshtein("abc", "")).toBe(3);
		expect(levenshtein("biuld", "build")).toBe(2);
		expect(
			didYouMean("biuld", [
				"build",
				"test",
			]),
		).toBe("build");
		expect(
			didYouMean("zzzzzz", [
				"build",
			]),
		).toBeUndefined();
	});
});

describe("library entry", () => {
	test("task() brands, optional/from build refs, ns wraps, defineTasks keeps options", () => {
		const built = task({
			run: () => 1,
		});
		expect((built as unknown as Record<string, unknown>)["~built"]).toBe(true);
		expect(Object.keys(built)).toEqual([
			"run",
		]);
		expect(optional("x")).toEqual({
			task: "x",
			optional: true,
		});
		expect(from("built", built)).toEqual({
			task: "built",
		});
		const group = ns({
			a: "echo a",
		});
		expect(isNamespace(group)).toBe(true);
		expect(isNamespace({})).toBe(false);
		const tasks = defineTasks(
			{
				group,
				b: "echo b",
			},
			{
				modes: [
					"dev",
				],
			},
		);
		expect(isTasks(tasks)).toBe(true);
		expect(isTasks({})).toBe(false);
		expect(optionsOf(tasks)?.modes).toEqual([
			"dev",
		]);
		expect(
			optionsOf(
				defineTasks({
					c: "x",
				}),
			),
		).toBeUndefined();
	});
});

describe("workspaces", () => {
	const root = dir("ws");
	const write = (rel: string, data: unknown): void => {
		mkdirSync(join(root, rel, ".."), {
			recursive: true,
		});
		writeFileSync(join(root, rel), JSON.stringify(data));
	};
	write("package.json", {
		name: "root",
		workspaces: [
			"packages/*",
			"!packages/ignored",
		],
	});
	write("packages/a/package.json", {
		name: "@x/a",
	});
	write("packages/b/package.json", {
		name: "@x/b",
		dependencies: {
			"@x/a": "workspace:*",
			react: "^19",
		},
	});
	write("packages/c/package.json", {
		name: "@x/c",
		devDependencies: {
			"@x/b": "workspace:*",
		},
	});
	write("packages/ignored/package.json", {
		name: "@x/ignored",
	});
	mkdirSync(join(root, "packages", "noname"), {
		recursive: true,
	});
	writeFileSync(join(root, "packages", "noname", "package.json"), "{}");

	test("patterns, root detection and members", async () => {
		expect(
			workspacePatternsOf({
				workspaces: {
					packages: [
						"apps/*",
					],
				},
			}),
		).toEqual([
			"apps/*",
		]);
		expect(
			workspacePatternsOf({
				workspaces: "nope",
			}),
		).toBeUndefined();
		const ws = findWorkspaceRoot(join(root, "packages", "a"));
		expect(ws?.rootDir).toBe(root);
		const members = await enumerateMembers(ws as NonNullable<typeof ws>);
		expect(members.map((m) => m.name)).toEqual([
			"@x/a",
			"@x/b",
			"@x/c",
		]);
		expect(members.find((m) => m.name === "@x/b")?.deps).toEqual([
			"@x/a",
		]);
	});

	test("filters: name, glob, path, dependencies, dependents", async () => {
		const ws = findWorkspaceRoot(root) as NonNullable<ReturnType<typeof findWorkspaceRoot>>;
		const members = await enumerateMembers(ws);
		const names = (filters: string[]): string[] => applyFilters(members, filters, root).map((m) => m.name);
		expect(
			names([
				"@x/a",
			]),
		).toEqual([
			"@x/a",
		]);
		expect(
			names([
				"@x/*",
			]),
		).toHaveLength(3);
		expect(
			names([
				"./packages/c",
			]),
		).toEqual([
			"@x/c",
		]);
		expect(
			names([
				"...@x/c",
			]),
		).toEqual([
			"@x/a",
			"@x/b",
			"@x/c",
		]);
		expect(
			names([
				"@x/a...",
			]),
		).toEqual([
			"@x/a",
			"@x/b",
			"@x/c",
		]);
		expect(names([])).toHaveLength(3);
		expect(() =>
			names([
				"nothing",
			]),
		).toThrow(OutdoError);
	});
});

describe("loading a do.ts", () => {
	test("commands, namespaces (siblings first), hooks and options", async () => {
		const project = dir("load");
		writeFileSync(
			join(project, "do.ts"),
			`import { defineTasks, ns } from "${INDEX}";
export default defineTasks({
	stop: "echo stop",
	db: ns({
		backup: "echo backup",
		reset: { deps: ["backup", "stop"], steps: ["backup"], finally: ["stop"], run: "echo reset" },
	}),
}, {
	modes: ["dev", "prod"],
	hooks: { "pre-commit": { steps: ["stop"], restage: true }, "pre-push": "echo push" },
});
`,
		);
		expect(findConfig(join(project))).toBe(join(project, "do.ts"));
		const file = await loadConfigFile(join(project, "do.ts"));
		expect([
			...file.tasks.keys(),
		]).toEqual([
			"stop",
			"db:backup",
			"db:reset",
			"hooks:pre-commit",
			"hooks:pre-push",
		]);
		const reset = file.tasks.get("db:reset");
		expect(reset?.group).toBe("db");
		expect(reset?.depEdges.map((e) => e.task)).toEqual([
			"db:backup",
			"stop",
		]);
		expect(reset?.steps).toEqual([
			"db:backup",
		]);
		expect(reset?.finally).toEqual([
			"stop",
		]);
		expect(file.tasks.get("hooks:pre-push")?.command).toEqual([
			"echo push",
		]);
		expect(file.hooks.get("pre-commit")).toEqual({
			task: "hooks:pre-commit",
			restage: true,
		});
		expect(file.options?.modes).toEqual([
			"dev",
			"prod",
		]);
	});

	test("bad files are config errors", async () => {
		const project = dir("bad");
		writeFileSync(join(project, "plain.ts"), "export default { a: {} };\n");
		await expect(loadConfigFile(join(project, "plain.ts"))).rejects.toThrow("must default-export defineTasks");
		writeFileSync(join(project, "broken.ts"), "export default ;\n");
		await expect(loadConfigFile(join(project, "broken.ts"))).rejects.toThrow("Failed to load");
		writeFileSync(
			join(project, "nested.ts"),
			`import { defineTasks, ns } from "${INDEX}";
export default defineTasks({ a: ns({ b: ns({ c: "x" }) }) } as never);
`,
		);
		await expect(loadConfigFile(join(project, "nested.ts"))).rejects.toThrow("cannot be nested");
	});

	test("entry validation", () => {
		const ctx = {
			configPath: "do.ts",
			baseDir: scratch,
			kind: "task" as const,
		};
		const bad = (raw: unknown): void => {
			expect(() => normalizeEntry("t", raw, ctx)).toThrow(OutdoError);
		};
		bad(42);
		bad([]);
		bad({
			run: 42,
		});
		bad({
			env: "nope",
		});
		bad({
			protect: 1,
		});
		bad({
			requires: "x",
		});
		bad({
			requires: {
				url: "ftp://x",
			},
		});
		bad({
			requires: {
				port: 99_999,
			},
		});
		bad({
			persistent: true,
			steps: [
				"x",
			],
		});
		bad({
			args: {
				a: {
					type: "string",
					short: "x",
				},
				b: {
					type: "string",
					short: "x",
				},
			},
		});
		bad({
			args: {
				a: z.array(z.string()),
				b: {
					type: "string",
				},
			},
			positional: [
				"a",
				"b",
			],
		});
		const ok = normalizeEntry(
			"t",
			{
				envFiles: [
					".env.platform",
				],
				requires: {
					bin: [
						"docker",
					],
					url: "http://localhost/health",
					port: 5432,
				},
				readonly: true,
				destructive: true,
				confirm: "sure?",
			},
			ctx,
		);
		expect(ok.envFiles).toEqual([
			join(scratch, ".env.platform"),
		]);
		expect(ok.readonly && ok.destructive).toBe(true);
		expect(ok.confirm).toBe("sure?");
	});
});

describe("task field validators", () => {
	const ctx = {
		configPath: "do.ts",
		baseDir: scratch,
		kind: "task" as const,
	};
	const bad = (raw: Record<string, unknown>, message: string): void => {
		expect(() => normalizeEntry("t", raw, ctx)).toThrow(message);
	};

	test("deps entries", () => {
		const t = normalizeEntry(
			"t",
			{
				deps: [
					"a",
					{
						task: "b",
						if: "CI",
					},
					{
						task: "c",
						optional: true,
						if: () => true,
					},
				],
			},
			ctx,
		);
		expect(
			t.depEdges.map((e) => [
				e.task,
				e.optional,
				typeof e.condition,
			]),
		).toEqual([
			[
				"a",
				false,
				"undefined",
			],
			[
				"b",
				false,
				"string",
			],
			[
				"c",
				true,
				"function",
			],
		]);
		bad(
			{
				deps: "a",
			},
			'"deps" must be an array',
		);
		bad(
			{
				deps: [
					{
						task: "a",
						if: 1,
					},
				],
			},
			'invalid "if"',
		);
		bad(
			{
				deps: [
					1,
				],
			},
			"deps entries must be",
		);
		bad(
			{
				inputs: "src/**",
			},
			'"inputs" must be an array of strings',
		);
	});

	test("ready probes", () => {
		const svc = (ready: unknown): Record<string, unknown> => ({
			persistent: true,
			ready,
		});
		expect(
			normalizeEntry(
				"t",
				svc({
					port: 80,
					host: "localhost",
					timeoutMs: 5,
				}),
				ctx,
			).ready?.port,
		).toBe(80);
		bad(svc("x"), '"ready" must be');
		bad(svc({}), "exactly one of");
		bad(
			svc({
				log: "",
			}),
			"non-empty string",
		);
		bad(
			svc({
				url: "nope",
			}),
			"valid http(s) URL",
		);
		bad(
			svc({
				port: 0,
			}),
			"between 1 and 65535",
		);
		bad(
			svc({
				log: "x",
				host: "h",
			}),
			"only valid with",
		);
		bad(
			svc({
				log: "x",
				timeoutMs: -1,
			}),
			"positive number",
		);
		bad(
			{
				ready: {
					log: "x",
				},
			},
			'requires "persistent: true"',
		);
	});

	test("retry and timeouts", () => {
		expect(
			normalizeEntry(
				"t",
				{
					retry: 3,
				},
				ctx,
			).retry,
		).toEqual({
			attempts: 3,
			delayMs: 0,
			backoff: "fixed",
		});
		expect(
			normalizeEntry(
				"t",
				{
					retry: {
						attempts: 2,
						delayMs: 10,
						backoff: "exponential",
					},
					timeoutMs: 100,
				},
				ctx,
			).retry?.backoff,
		).toBe("exponential");
		bad(
			{
				retry: "x",
			},
			'"retry" must be',
		);
		bad(
			{
				retry: 0,
			},
			"integer >= 1",
		);
		bad(
			{
				retry: {
					attempts: 1,
					delayMs: -1,
				},
			},
			"non-negative",
		);
		bad(
			{
				retry: {
					attempts: 1,
					backoff: "linear",
				},
			},
			'"fixed" or "exponential"',
		);
		bad(
			{
				timeoutMs: 0,
			},
			"positive number of ms",
		);
		bad(
			{
				persistent: true,
				retry: 2,
			},
			'cannot declare "retry"',
		);
		bad(
			{
				persistent: true,
				timeoutMs: 5,
			},
			'cannot declare "timeoutMs"',
		);
		bad(
			{
				persistent: true,
				outputs: [
					"dist/**",
				],
			},
			'cannot declare "outputs"',
		);
	});

	test("findConfig walks up, but stops at a workspace root", () => {
		const top = dir("find");
		writeFileSync(join(top, "do.ts"), "");
		mkdirSync(join(top, "a", "b"), {
			recursive: true,
		});
		writeFileSync(
			join(top, "a", "package.json"),
			JSON.stringify({
				name: "a",
			}),
		);
		expect(findConfig(join(top, "a", "b"))).toBe(join(top, "do.ts"));
		writeFileSync(
			join(top, "a", "package.json"),
			JSON.stringify({
				workspaces: [
					"b",
				],
			}),
		);
		expect(findConfig(join(top, "a", "b"))).toBeUndefined();
		writeFileSync(join(top, "a", "package.json"), "{ not json");
		expect(findConfig(join(top, "a", "b"))).toBe(join(top, "do.ts"));
	});
});

describe("flag normalization edge cases", () => {
	test("schemas without JSON Schema fall back to string flags", () => {
		const transformed = z.string().transform((s) => s.length);
		expect(jsonSchemaOf(transformed)).toMatchObject({
			type: "string",
		});
		const args = normalizeArgs(
			{
				len: transformed,
				pick: z.union([
					z.literal("a"),
					z.literal("b"),
				]),
				nums: z.array(z.number()),
			},
			"t",
		);
		expect(args.pick?.choices).toEqual([
			"a",
			"b",
		]);
		expect(args.nums?.type).toBe("array");
		expect(() => normalizeArgs("x", "t")).toThrow(OutdoError);
		expect(() =>
			normalizeArgs(
				{
					a: {
						type: "number",
					},
				},
				"t",
			),
		).toThrow(OutdoError);
		expect(() =>
			normalizeArgs(
				{
					a: {
						type: "string",
						choices: [
							1,
						],
					},
				},
				"t",
			),
		).toThrow(OutdoError);
		expect(() =>
			normalizeArgs(
				{
					a: {},
				},
				"t",
			),
		).toThrow(OutdoError);
	});

	test("help notes and --help detection", () => {
		const ctx = {
			configPath: "do.ts",
			baseDir: scratch,
			kind: "task" as const,
		};
		const t = normalizeEntry(
			"deploy",
			{
				desc: "Ship",
				protect: "prod",
				readonly: true,
				destructive: true,
				finally: [
					"cleanup",
				],
				env: z.object({}),
				run: "bun deploy.ts",
				args: {
					help: {
						type: "boolean",
					},
				},
			},
			ctx,
		);
		const help = renderTaskHelp(t);
		expect(help).toContain("Runs:  bun deploy.ts");
		expect(help).toContain("asks before running in prod");
		expect(help).toContain("read-only");
		expect(help).toContain("always runs afterwards: cleanup");
		expect(help).toContain("--print-env deploy");
		expect(
			wantsTaskHelp(t, [
				"--help",
			]),
		).toBe(false);
		expect(
			wantsTaskHelp(t, [
				"-h",
			]),
		).toBe(true);
	});
});

describe("GitHub output helpers", () => {
	const report: RunReport = {
		ok: false,
		startedAt: new Date(0).toISOString(),
		tasks: [
			{
				name: "lint",
				status: "ok",
				durationMs: 1200,
				cache: "hit",
			},
			{
				name: "test",
				status: "failed",
				durationMs: 30,
				cache: "miss",
			},
		],
		summary: {
			ok: 1,
			failed: 1,
			skipped: 0,
			cached: 1,
			running: 0,
		},
		timing: {
			totalMs: 1300,
			criticalPathMs: 1200,
			criticalPath: [
				"lint",
			],
			parallelism: 1,
		},
	};

	test("summary table, step summary file, outputs file", () => {
		const md = summaryMarkdown("outdo ci check", report);
		expect(md).toContain("### ❌ outdo ci check");
		expect(md).toContain("| ✅ `lint` | ok | cached |");
		expect(md).toContain("| ❌ `test` | failed | 30ms |");
		const summary = join(scratch, "summary.md");
		appendStepSummary(md, {
			GITHUB_STEP_SUMMARY: summary,
		});
		expect(readFileSync(summary, "utf8")).toContain("outdo ci check");
		appendStepSummary(md, {}); // no-op outside Actions
		const outputs = join(scratch, "outputs.txt");
		writeFileSync(outputs, "");
		expect(
			writeGithubOutputs(
				{
					deploy: "true",
				},
				{
					GITHUB_OUTPUT: outputs,
				},
			),
		).toBe(true);
		expect(readFileSync(outputs, "utf8")).toBe("deploy=true\n");
		expect(
			writeGithubOutputs(
				{
					a: "b",
				},
				{},
			),
		).toBe(false);
		expect(
			inGithubActions({
				GITHUB_ACTIONS: "true",
			}),
		).toBe(true);
		expect(inGithubActions({})).toBe(false);
	});
});

describe("ctx.ssh", () => {
	const fake = join(scratch, "fake-ssh.ts");
	writeFileSync(
		fake,
		"console.log(process.argv.slice(2).join(' | ')); process.exit(Number(process.env.FAKE_EXIT ?? 0));\n",
	);
	const env = (exit = "0"): Record<string, string | undefined> => ({
		...process.env,
		OUTDO_SSH: JSON.stringify([
			process.execPath,
			fake,
		]),
		FAKE_EXIT: exit,
	});

	test("runs on the target, captures output, honours cwd/quiet/nothrow", async () => {
		const ssh = makeSsh(env(), new AbortController().signal);
		const vps = ssh("me@host", {
			args: [
				"-p",
				"2222",
			],
		})
			.cwd("~")
			.quiet();
		const result = await vps`ls ${"a b"}`;
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(`-p | 2222 | me@host | cd "$HOME" && ls 'a b'`);

		const failing = makeSsh(env("3"), new AbortController().signal)("me@host").quiet();
		await expect(failing`false`).rejects.toThrow("exited with code 3");
		const tolerated = await failing.nothrow()`false`;
		expect(tolerated.exitCode).toBe(3);
	});
});

describe("compose preset", () => {
	const base = dir("compose");
	writeFileSync(join(base, "docker-compose.dev.yml"), "services:\n  api:\n    image: x\n  web:\n    image: y\n");
	const log = join(base, "docker.log");
	const fakeDocker = join(base, "fake-docker.ts");
	writeFileSync(
		fakeDocker,
		`require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n"); process.exit(Number(process.env.FAKE_EXIT ?? 0));\n`,
	);

	const ctx = (args: Record<string, unknown> = {}, rest: string[] = []) =>
		({
			mode: "dev",
			cwd: base,
			// Like a real ctx.env (no schema): the whole resolved process env.
			env: {
				...process.env,
			},
			args,
			rest,
			signal: new AbortController().signal,
		}) as unknown as Parameters<typeof runCompose>[1];

	const calls = (): string[][] =>
		readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);

	test("tasks build the right docker compose commands", async () => {
		process.env.OUTDO_DOCKER = JSON.stringify([
			process.execPath,
			fakeDocker,
		]);
		try {
			const options: ComposeOptions = {
				files: (mode) => [
					`docker-compose.${mode}.yml`,
				],
				project: "stack",
				envFile: () => ".env.stack",
				wait: true,
			};
			const tasks = compose(options, base) as unknown as Record<
				string,
				{
					run: (ctx: unknown) => Promise<void>;
					args?: Record<
						string,
						{
							suggest?: readonly string[];
						}
					>;
				}
			>;
			expect(tasks.up?.args?.svc?.suggest).toEqual([
				"api",
				"web",
			]);
			writeFileSync(log, "");
			await tasks.up?.run(ctx());
			await tasks.down?.run(ctx());
			await tasks.restart?.run(ctx());
			await tasks.rebuild?.run(
				ctx({
					svc: "api",
				}),
			);
			await tasks.fresh?.run(ctx());
			await tasks.logs?.run(
				ctx({
					svc: "web",
					follow: true,
					tail: "50",
				}),
			);
			await tasks.ps?.run(ctx());
			await tasks.shell?.run(
				ctx({
					svc: "api",
				}),
			);
			await tasks.exec?.run(
				ctx(
					{
						svc: "api",
					},
					[
						"bun",
						"test",
					],
				),
			);
			const g = [
				"compose",
				"-f",
				"docker-compose.dev.yml",
				"-p",
				"stack",
				"--env-file",
				".env.stack",
			];
			expect(calls()).toEqual([
				[
					...g,
					"up",
					"-d",
					"--wait",
				],
				[
					...g,
					"down",
				],
				[
					...g,
					"down",
				],
				[
					...g,
					"up",
					"-d",
					"--wait",
				],
				[
					...g,
					"up",
					"-d",
					"--build",
					"--force-recreate",
					"--wait",
					"api",
				],
				[
					...g,
					"down",
					"-v",
					"--remove-orphans",
				],
				[
					...g,
					"up",
					"-d",
					"--build",
					"--wait",
				],
				[
					...g,
					"logs",
					"--tail=50",
					"--follow",
					"web",
				],
				[
					...g,
					"ps",
				],
				[
					...g,
					"exec",
					"api",
					"sh",
				],
				[
					...g,
					"exec",
					"api",
					"bun",
					"test",
				],
			]);
			const known = compose({
				services: [
					"db",
				],
			}) as unknown as Record<
				string,
				{
					args?: Record<
						string,
						{
							choices?: readonly string[];
						}
					>;
				}
			>;
			expect(known.logs?.args?.svc?.choices).toEqual([
				"db",
			]);
			process.env.FAKE_EXIT = "2";
			await expect(
				runCompose({}, ctx(), [
					"ps",
				]),
			).rejects.toThrow("exited with code 2");
		} finally {
			delete process.env.OUTDO_DOCKER;
			delete process.env.FAKE_EXIT;
		}
	});
});
