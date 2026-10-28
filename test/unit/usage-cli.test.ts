import { describe, expect, test } from "bun:test";
import { parseCli } from "~/cli/parse";
import { ago, duration, parseSince, renderTaskUsage, renderUsage } from "~/cli/usage-render";
import { givenFlags } from "~/core/argspec";
import { OutdoError } from "~/core/errors";
import type { UsageReport } from "~/core/usage-report";
import { analyzeUsage } from "~/core/usage-report";
import { doTask, project, ROOT, scriptTask } from "./usage-helpers";

const DAY = 24 * 60 * 60 * 1000;

describe("givenFlags", () => {
	const base = doTask("feed", {
		args: {
			source: {
				type: "string",
				choices: [
					"eco",
					"all",
				],
			},
			id: {
				type: "string",
			},
			verbose: {
				type: "boolean",
				short: "v",
			},
		},
		positional: [
			"id",
		],
		run: "echo",
	});
	// Array flags come from schemas (z.array(z.enum(...))).
	const feed = {
		...base,
		args: {
			source: base.args.source as NonNullable<(typeof base.args)["source"]>,
			tags: {
				...(base.args.source as NonNullable<(typeof base.args)["source"]>),
				type: "array" as const,
				choices: [
					"a",
					"b",
				],
			},
			id: base.args.id as NonNullable<(typeof base.args)["id"]>,
			verbose: base.args.verbose as NonNullable<(typeof base.args)["verbose"]>,
		},
	};

	test("names only, values for choice flags; bare words fill positional flags", () => {
		expect(
			givenFlags(feed, [
				"C-0007",
				"--source",
				"eco",
				"-v",
				"--tags=a",
				"--tags",
				"b",
			]),
		).toEqual([
			"source=eco",
			"tags=a",
			"tags=b",
			"id",
			"verbose",
		]);
	});

	test("a value outside the choices keeps only the name; bad argv gives nothing", () => {
		expect(
			givenFlags(feed, [
				"--source=wat",
			]),
		).toEqual([
			"source",
		]);
		expect(
			givenFlags(feed, [
				"--nope",
			]),
		).toEqual([]);
	});
});

describe("outdo usage parsing", () => {
	test("defaults", () => {
		expect(
			parseCli([
				"usage",
			]).command,
		).toEqual({
			kind: "usage",
			task: [],
			since: undefined,
			all: false,
			history: true,
		});
	});

	test("a task, --since, --all, --no-history, --json", () => {
		const { command, flags } = parseCli([
			"usage",
			"db",
			"reset",
			"--since",
			"30d",
			"--all",
			"--no-history",
			"--json",
		]);
		expect(command).toEqual({
			kind: "usage",
			task: [
				"db",
				"reset",
			],
			since: "30d",
			all: true,
			history: false,
		});
		expect(flags.json).toBe(true);
	});
});

describe("--since", () => {
	const now = Date.UTC(2026, 9, 28);
	test("spans and dates", () => {
		expect(parseSince("12h", now)).toBe(now - 12 * 60 * 60 * 1000);
		expect(parseSince("30d", now)).toBe(now - 30 * DAY);
		expect(parseSince("2w", now)).toBe(now - 14 * DAY);
		expect(parseSince("2026-10-01", now)).toBe(Date.UTC(2026, 9, 1));
	});

	test("anything else is a usage error", () => {
		expect(() => parseSince("soon", now)).toThrow(OutdoError);
		expect(() => parseSince("30", now)).toThrow(OutdoError);
	});
});

describe("formatting", () => {
	const now = Date.UTC(2026, 9, 28, 12);
	test("ago", () => {
		expect(ago(now - 10_000, now)).toBe("just now");
		expect(ago(now - 5 * 60_000, now)).toBe("5m ago");
		expect(ago(now - 3 * 3_600_000, now)).toBe("3h ago");
		expect(ago(now - 2 * DAY, now)).toBe("2d ago");
		expect(ago(Date.UTC(2026, 2, 3, 12), now)).toBe("Mar 3");
		expect(ago(Date.UTC(2025, 2, 3, 12), now)).toBe("Mar 3, 2025");
	});

	test("duration", () => {
		expect(duration(850)).toBe("850ms");
		expect(duration(12_340)).toBe("12.3s");
		expect(duration(134_000)).toBe("2m 14s");
		expect(duration(3_900_000)).toBe("1h 5m");
	});
});

describe("rendering", () => {
	const now = 100 * DAY;
	const tasks = [
		doTask("gate", {
			steps: [
				"fix",
			],
			args: {
				fast: {
					type: "boolean",
				},
			},
		}),
		doTask("fix", "bun run format"),
		scriptTask("format", "biome check --write ."),
		doTask("dead", "echo dead"),
		{
			...doTask("lint", "echo lint"),
			name: "@x/web#lint",
		},
	];
	const p = project(tasks, {
		modes: [
			"dev",
		],
	});
	const runs = Array.from(
		{
			length: 3,
		},
		(_, i) => ({
			id: `g${i}`,
			t: now - (i + 1) * 3_600_000,
			via: "cli" as const,
			agent: i === 0 ? "claude-code" : undefined,
			tasks: [
				"gate",
			],
			ran: [
				"fix",
				"gate",
			],
			mode: "dev",
		}),
	);
	const report: UsageReport = analyzeUsage({
		project: p,
		starts: runs,
		ends: new Map([
			[
				"g0",
				{
					end: "g0",
					t: now,
					ok: false,
					ms: {
						gate: 134_000,
					},
					failed: [
						"gate",
					],
				},
			],
		]),
		seen: {
			gate: now - DAY,
		},
		typed: [],
		typedScripts: [],
		// What the CLI finds in fix's command (bun run format).
		mentions: [
			{
				task: "format",
				from: "task:fix",
			},
		],
		packages: [
			{
				dir: ROOT,
				pkg: "",
				scripts: {
					format: "biome check --write .",
				},
				visible: new Set([
					"format",
				]),
			},
		],
		now,
	});

	test("the whole report", () => {
		const text = renderUsage(report, false);
		expect(text).toContain("3 runs recorded since");
		expect(text).toContain("most used");
		expect(text).toMatch(/gate\s+2\s+1\s+-\s+-\s+1h ago\s+2m 14s\s+1/);
		expect(text).toContain("unused — 1 task");
		expect(text).toContain("dead");
		expect(text).toContain("workspace scripts that never ran through outdo — 1");
		expect(text).toContain("@x/web: lint");
		expect(text).toContain("flags never passed");
		expect(text).toContain("--fast");
		expect(text).toContain("modes  dev 3");
		expect(text).toContain('"fix" only runs "format"');
		expect(text).toContain("tracking started 1d ago");
	});

	test("--all lists every task; an empty log says so", () => {
		expect(renderUsage(report, true)).toContain("every task");
		const empty = analyzeUsage({
			project: p,
			starts: [],
			ends: new Map(),
			seen: {},
			typed: [],
			typedScripts: [],
			mentions: [],
			packages: [],
			now,
		});
		expect(renderUsage(empty, false)).toContain("no runs recorded yet");
	});

	test("one task", () => {
		const gate = report.tasks.find((t) => t.name === "gate");
		const text = renderTaskUsage(report, gate as NonNullable<typeof gate>);
		expect(text).toContain("you 2 · agent 1");
		expect(text).toContain("avg 2m 14s · 1 failed");
		expect(text).toContain("--fast");
		expect(text).toContain("never passed");
		const fix = report.tasks.find((t) => t.name === "fix");
		const fixText = renderTaskUsage(report, fix as NonNullable<typeof fix>);
		expect(fixText).toContain("used by");
		expect(fixText).toContain("duplicates");
	});
});
