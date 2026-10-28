import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { HookSpec } from "~/core/model";
import type { UsageEnd, UsageStart } from "~/core/usage";
import type { PackageScripts, UsageInput } from "~/core/usage-report";
import { analyzeUsage, findDuplicates, normalizeCommand, usageScore, YOUNG_MS } from "~/core/usage-report";
import { doTask, project, ROOT, scriptTask } from "./usage-helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

let ids = 0;
function run(tasks: string[], extra: Partial<UsageStart> = {}): UsageStart {
	ids++;
	return {
		id: `r${ids}`,
		t: NOW - DAY,
		via: "cli",
		tasks,
		ran: tasks,
		...extra,
	};
}

function pkg(scripts: Record<string, string>, visible = Object.keys(scripts)): PackageScripts {
	return {
		dir: ROOT,
		pkg: "",
		scripts,
		visible: new Set(visible),
	};
}

const tasks = [
	doTask("build", "echo build"),
	doTask("test", {
		deps: [
			"build",
		],
		run: "echo test",
	}),
	doTask("feed", {
		args: {
			source: {
				type: "string",
				choices: [
					"eco",
					"all",
					"none",
				],
				default: "all",
			},
			verbose: {
				type: "boolean",
			},
			id: {
				type: "string",
				required: true,
			},
			late: {
				type: "boolean",
			},
		},
		run: "echo feed",
	}),
	doTask("deploy", "echo deploy"),
	doTask("certs", "echo certs"),
	doTask("dev", {
		deps: [
			"certs",
		],
		persistent: true,
		run: "echo dev",
	}),
	doTask("old", {
		deps: [
			"older",
		],
		run: "echo old",
	}),
	doTask("older", "echo older"),
	doTask("hooks:pre-commit", {
		steps: [
			"lintfix",
		],
	}),
	doTask("lintfix", "echo fix"),
	doTask("typed", "echo typed"),
];
tasks[8] = {
	...(tasks[8] as (typeof tasks)[number]),
	kind: "hook",
};

function input(over: Partial<UsageInput> = {}): UsageInput {
	return {
		project: project(tasks, {
			modes: [
				"dev",
				"prod",
			],
			hooks: new Map<string, HookSpec>([
				[
					"pre-commit",
					{
						task: "hooks:pre-commit",
						restage: false,
					},
				],
			]),
		}),
		starts: [],
		ends: new Map(),
		seen: {},
		typed: [],
		typedScripts: [],
		mentions: [],
		packages: [
			pkg({}),
		],
		now: NOW,
		...over,
	};
}

describe("analyzeUsage counts", () => {
	const starts = [
		run(
			[
				"test",
			],
			{
				ran: [
					"build",
					"test",
				],
				mode: "dev",
			},
		),
		run(
			[
				"test",
			],
			{
				ran: [
					"build",
					"test",
				],
				agent: "claude-code",
				mode: "dev",
				t: NOW - 2 * DAY,
			},
		),
		run(
			[
				"hooks:pre-commit",
			],
			{
				via: "hook",
				hook: "pre-commit",
				ran: [
					"lintfix",
					"hooks:pre-commit",
				],
			},
		),
		run(
			[
				"build",
			],
			{
				via: "nested",
			},
		),
		run(
			[
				"dev",
			],
			{
				ran: [
					"certs",
					"dev",
				],
				mode: "prod",
			},
		),
	];
	const ends = new Map<string, UsageEnd>([
		[
			starts[0]?.id as string,
			{
				end: starts[0]?.id as string,
				t: NOW,
				ok: false,
				ms: {
					build: 100,
					test: 300,
				},
				failed: [
					"test",
				],
			},
		],
		[
			starts[1]?.id as string,
			{
				end: starts[1]?.id as string,
				t: NOW,
				ok: true,
				ms: {
					test: 100,
				},
				cached: [
					"build",
				],
			},
		],
	]);
	const report = analyzeUsage(
		input({
			starts,
			ends,
			typed: [
				{
					t: NOW - 50 * DAY,
					task: "typed",
					flags: [],
				},
				{
					t: undefined,
					task: "typed",
					flags: [],
				},
			],
			mentions: [
				{
					task: "deploy",
					from: ".github/workflows/deploy.yml",
				},
			],
		}),
	);
	const byName = (name: string) => report.tasks.find((t) => t.name === name);

	test("you, agent, as a dependency, hooks and shell history are counted apart", () => {
		expect(byName("test")).toMatchObject({
			you: 1,
			agent: 1,
			deps: 0,
			avgMs: 200,
			fails: 1,
			last: NOW - DAY,
		});
		expect(byName("build")).toMatchObject({
			you: 0,
			deps: 3,
			avgMs: 100,
		});
		expect(byName("lintfix")?.deps).toBe(1);
		expect(byName("typed")).toMatchObject({
			typed: 2,
			last: NOW - 50 * DAY,
		});
		expect(byName("dev")?.service).toBe(true);
		expect(report.tasks.some((t) => t.name === "hooks:pre-commit")).toBe(false);
		expect(report.runs).toBe(5);
		expect(report.firstRun).toBe(NOW - 2 * DAY);
		expect(report.history).toEqual({
			calls: 2,
			from: NOW - 50 * DAY,
		});
	});

	test("modes and hooks", () => {
		expect(report.modes).toEqual([
			{
				name: "dev",
				runs: 2,
			},
			{
				name: "prod",
				runs: 1,
			},
		]);
		expect(report.hooks).toEqual([
			{
				name: "pre-commit",
				runs: 1,
			},
		]);
	});

	test("used, referenced, unused", () => {
		expect(byName("test")?.status).toBe("used");
		expect(byName("typed")?.status).toBe("used");
		expect(byName("deploy")).toMatchObject({
			status: "referenced",
			usedBy: [
				".github/workflows/deploy.yml",
			],
		});
		expect(byName("old")?.status).toBe("unused");
		expect(byName("older")).toMatchObject({
			status: "unused",
			usedBy: [
				"old",
			],
		});
		expect(byName("feed")?.status).toBe("unused");
	});

	test("hook tasks keep their steps alive and show up as `hook <name>`", () => {
		const report2 = analyzeUsage(input());
		const lintfix = report2.tasks.find((t) => t.name === "lintfix");
		expect(lintfix?.status).toBe("referenced");
		expect(lintfix?.usedBy).toEqual([
			"hook pre-commit",
		]);
	});

	test("--since drops older runs and undated history", () => {
		const recent = analyzeUsage(
			input({
				starts,
				ends,
				typed: [
					{
						t: undefined,
						task: "typed",
						flags: [],
					},
				],
				since: NOW - 1.5 * DAY,
			}),
		);
		expect(recent.runs).toBe(4);
		expect(recent.since).toBe(NOW - 1.5 * DAY);
		expect(recent.tasks.find((t) => t.name === "test")).toMatchObject({
			you: 1,
			agent: 0,
		});
		expect(recent.tasks.find((t) => t.name === "typed")?.typed).toBe(0);
	});

	test("ranking puts asked-for tasks ahead of dependency-only ones", () => {
		const build = byName("build");
		const test = byName("test");
		expect(usageScore(test as NonNullable<typeof test>)).toBeGreaterThan(
			usageScore(build as NonNullable<typeof build>),
		);
	});
});

describe("flag usage", () => {
	const feedRuns = (count: number, flags: string[][]): UsageStart[] =>
		Array.from(
			{
				length: count,
			},
			(_, i) =>
				run(
					[
						"feed",
					],
					{
						t: NOW - (i + 1) * 1000,
						flags: flags[i] ?? [
							"id",
						],
					},
				),
		);

	test("flags never passed, choices never picked (the default counts when the flag was left out)", () => {
		const report = analyzeUsage(
			input({
				starts: feedRuns(4, [
					[
						"id",
						"source=eco",
					],
					[
						"id",
						"source=eco",
					],
				]),
				seen: {
					"feed --late": NOW - 2500,
				},
			}),
		);
		const feed = report.tasks.find((t) => t.name === "feed");
		const flag = (name: string) => feed?.flags.find((f) => f.flag === name);
		expect(flag("id")).toMatchObject({
			given: 4,
			runs: 4,
			required: true,
		});
		expect(flag("verbose")).toMatchObject({
			given: 0,
			runs: 4,
		});
		// Added after two of the runs: only the later runs count.
		expect(flag("late")).toMatchObject({
			given: 0,
			runs: 2,
		});
		expect(flag("source")).toMatchObject({
			given: 2,
			values: {
				eco: 2,
			},
			unusedValues: [
				"none",
			],
		});
	});

	test("shell history counts as passing a flag", () => {
		const report = analyzeUsage(
			input({
				starts: feedRuns(3, []),
				typed: [
					{
						t: NOW,
						task: "feed",
						flags: [
							"verbose",
							"source=none",
						],
					},
				],
			}),
		);
		const feed = report.tasks.find((t) => t.name === "feed");
		expect(feed?.flags.find((f) => f.flag === "verbose")?.given).toBe(1);
		expect(feed?.flags.find((f) => f.flag === "source")).toMatchObject({
			values: {
				none: 1,
			},
			unusedValues: [
				"eco",
			],
		});
	});

	test("too few runs: no verdict on choices", () => {
		const report = analyzeUsage(
			input({
				starts: feedRuns(2, []),
			}),
		);
		expect(
			report.tasks.find((t) => t.name === "feed")?.flags.find((f) => f.flag === "source")?.unusedValues,
		).toBeUndefined();
	});

	test("tracking age comes from the oldest seen mark", () => {
		const report = analyzeUsage(
			input({
				seen: {
					build: NOW - YOUNG_MS,
					test: NOW,
				},
			}),
		);
		expect(report.trackedSince).toBe(NOW - YOUNG_MS);
		expect(report.tasks.find((t) => t.name === "test")?.firstSeen).toBe(NOW);
	});
});

describe("duplicates", () => {
	test("normalizeCommand: whitespace and bunx/npx prefixes", () => {
		expect(normalizeCommand("  bunx   tsc  --noEmit ")).toBe("tsc --noEmit");
		expect(normalizeCommand("bun x biome check && npx tsc")).toBe("biome check && tsc");
		expect(normalizeCommand("bun run tsc")).toBe("bun run tsc");
	});

	test("every kind", () => {
		const p = project([
			doTask("typecheck", "bun run typecheck"),
			doTask("test", "bun test"),
			doTask("fix", "bun run format"),
			doTask("again", "bunx outdo typecheck"),
			scriptTask("format", "biome check --write ."),
			scriptTask("fmt", "bunx biome check --write ."),
			doTask("tsc", "bunx tsc --noEmit"),
			doTask("types", "tsc   --noEmit"),
			doTask("gate", {
				steps: [
					"typecheck",
					"test",
				],
			}),
			doTask("check", {
				steps: [
					"typecheck",
					"test",
				],
			}),
			doTask("all", {
				deps: [
					"typecheck",
					"test",
				],
			}),
			doTask("both", {
				deps: [
					"test",
					"typecheck",
				],
			}),
		]);
		const dups = findDuplicates(
			p,
			[
				pkg(
					{
						typecheck: "tsc --noEmit",
						test: "turbo run test",
						format: "biome check --write .",
						fmt: "bunx biome check --write .",
						dev: "outdo dev",
						outdo: "bun src/cli.ts",
					},
					[
						"typecheck",
						"test",
						"format",
						"fmt",
					],
				),
			],
			[
				"test",
				"test",
			],
		);
		expect(dups).toEqual([
			{
				kind: "runs-own-script",
				task: "typecheck",
				command: "bun run typecheck",
			},
			{
				kind: "hidden-script",
				task: "test",
				pkg: "",
				script: "test",
				command: "turbo run test",
				typed: 2,
			},
			{
				kind: "alias",
				task: "fix",
				of: "format",
				command: "bun run format",
			},
			{
				kind: "alias",
				task: "again",
				of: "typecheck",
				command: "bunx outdo typecheck",
			},
			{
				kind: "same-command",
				tasks: [
					"format",
					"fmt",
				],
				command: "biome check --write .",
			},
			{
				kind: "same-command",
				tasks: [
					"tsc",
					"types",
				],
				command: "tsc --noEmit",
			},
			{
				kind: "same-steps",
				tasks: [
					"gate",
					"check",
				],
				steps: [
					"typecheck",
					"test",
				],
			},
			{
				kind: "same-steps",
				tasks: [
					"all",
					"both",
				],
				steps: [
					"test",
					"typecheck",
				],
			},
			{
				kind: "outdo-script",
				pkg: "",
				script: "dev",
				command: "outdo dev",
			},
		]);
	});

	test("same command in different packages is not a duplicate", () => {
		const a = scriptTask("build", "tsc");
		const b = {
			...scriptTask("build", "tsc"),
			name: "@x/b#build",
			sourceConfig: join(ROOT, "b", "package.json"),
		};
		expect(
			findDuplicates(
				project([
					a,
					b,
				]),
				[
					pkg({
						build: "tsc",
					}),
					{
						...pkg({
							build: "tsc",
						}),
						dir: join(ROOT, "b"),
						pkg: "@x/b",
					},
				],
				[],
			),
		).toEqual([]);
	});
});
