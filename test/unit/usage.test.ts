import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskResult } from "~/core/scheduler";
import {
	agentOf,
	markSeen,
	parseUsageLog,
	readUsageLog,
	recordingEnabled,
	recordRun,
	seenKeys,
	usageLogPath,
} from "~/core/usage";
import { doTask, project } from "./usage-helpers";

function tempProject() {
	const dir = mkdtempSync(join(tmpdir(), "outdo-usage-"));
	return {
		...project(
			[
				doTask("build", "echo build"),
				doTask("feed", {
					args: {
						source: {
							type: "string",
							choices: [
								"eco",
								"all",
							],
						},
					},
					run: "echo feed",
				}),
			],
			{
				modes: [
					"dev",
					"prod",
				],
			},
		),
		rootDir: dir,
	};
}

const result = (name: string, extra: Partial<TaskResult>): TaskResult => ({
	name,
	status: "ok",
	durationMs: 0,
	...extra,
});

describe("recording switches", () => {
	test("off in CI and under OUTDO_NO_USAGE", () => {
		expect(recordingEnabled({})).toBe(true);
		expect(
			recordingEnabled({
				CI: "true",
			}),
		).toBe(false);
		expect(
			recordingEnabled({
				CI: "false",
			}),
		).toBe(true);
		expect(
			recordingEnabled({
				CI: "",
			}),
		).toBe(true);
		expect(
			recordingEnabled({
				OUTDO_NO_USAGE: "1",
			}),
		).toBe(false);
		expect(
			recordingEnabled({
				OUTDO_NO_USAGE: "0",
			}),
		).toBe(true);
	});

	test("agents are told apart from people", () => {
		expect(agentOf({})).toBeUndefined();
		expect(
			agentOf({
				AI_AGENT: "claude-code_2-1-312_cli",
			}),
		).toBe("claude-code");
		expect(
			agentOf({
				AI_AGENT: "cursor",
			}),
		).toBe("cursor");
		expect(
			agentOf({
				CLAUDECODE: "1",
			}),
		).toBe("claude-code");
		expect(
			agentOf({
				CODEX_SANDBOX: "seatbelt",
			}),
		).toBe("codex");
		expect(
			agentOf({
				CURSOR_AGENT: "1",
			}),
		).toBe("cursor");
		expect(
			agentOf({
				GEMINI_CLI: "1",
			}),
		).toBe("gemini");
		expect(
			agentOf({
				CLAUDECODE: "",
			}),
		).toBeUndefined();
	});
});

describe("recordRun", () => {
	test("a start line, then an end line with times, failures and cache hits", () => {
		const p = tempProject();
		const recorder = recordRun(
			p,
			{
				via: "cli",
				tasks: [
					"feed",
				],
				ran: [
					"build",
					"feed",
				],
				flags: [
					"source=eco",
				],
				mode: "prod",
			},
			{},
			1000,
		);
		expect(recorder).toBeDefined();
		recorder?.end(
			[
				result("build", {
					cached: true,
				}),
				result("feed", {
					status: "failed",
					durationMs: 12.6,
				}),
			],
			false,
		);
		const log = readUsageLog(p.rootDir);
		expect(log.starts).toHaveLength(1);
		expect(log.starts[0]).toMatchObject({
			t: 1000,
			via: "cli",
			tasks: [
				"feed",
			],
			ran: [
				"build",
				"feed",
			],
			flags: [
				"source=eco",
			],
			mode: "prod",
		});
		expect(log.starts[0]?.agent).toBeUndefined();
		const end = log.ends.get(log.starts[0]?.id as string);
		expect(end).toMatchObject({
			ok: false,
			ms: {
				feed: 13,
			},
			failed: [
				"feed",
			],
			cached: [
				"build",
			],
		});
		expect(log.seen.feed).toBe(1000);
		expect(log.seen["feed --source"]).toBe(1000);
		expect(log.seen["mode:prod"]).toBe(1000);
	});

	test("agent and hook are kept; MCP without an agent marker counts as an agent", () => {
		const p = tempProject();
		recordRun(
			p,
			{
				via: "hook",
				hook: "pre-commit",
				tasks: [
					"build",
				],
				ran: [
					"build",
				],
				flags: [],
				mode: "",
			},
			{
				AI_AGENT: "claude-code",
			},
		);
		recordRun(
			p,
			{
				via: "mcp",
				tasks: [
					"build",
				],
				ran: [
					"build",
				],
				flags: [],
				mode: "",
			},
			{},
		);
		const [hook, mcp] = readUsageLog(p.rootDir).starts;
		expect(hook).toMatchObject({
			via: "hook",
			hook: "pre-commit",
			agent: "claude-code",
		});
		expect(hook?.flags).toBeUndefined();
		expect(hook?.mode).toBeUndefined();
		expect(mcp?.agent).toBe("mcp");
	});

	test("nothing is written when recording is off", () => {
		const p = tempProject();
		expect(
			recordRun(
				p,
				{
					via: "cli",
					tasks: [
						"build",
					],
					ran: [
						"build",
					],
					flags: [],
					mode: "",
				},
				{
					OUTDO_NO_USAGE: "1",
				},
			),
		).toBeUndefined();
		expect(existsSync(usageLogPath(p.rootDir))).toBe(false);
	});

	test("a log past 4 MB keeps its newer half", () => {
		const p = tempProject();
		const line = `${JSON.stringify({
			id: "old",
			t: 1,
			via: "cli",
			tasks: [
				"build",
			],
			ran: [
				"build",
			],
			pad: "x".repeat(1000),
		})}\n`;
		markSeen(p);
		writeFileSync(usageLogPath(p.rootDir), line.repeat(4200));
		recordRun(p, {
			via: "cli",
			tasks: [
				"feed",
			],
			ran: [
				"feed",
			],
			flags: [],
			mode: "",
		});
		expect(statSync(usageLogPath(p.rootDir)).size).toBeLessThan(3 * 1024 * 1024);
		const starts = readUsageLog(p.rootDir).starts;
		expect(starts.at(-1)?.tasks).toEqual([
			"feed",
		]);
		expect(starts.length).toBeGreaterThan(2000);
	});
});

describe("seen marks", () => {
	test("first-seen times are kept; the file is only rewritten for new names", () => {
		const p = tempProject();
		markSeen(p, 5);
		const path = join(p.rootDir, ".outdo", "usage-seen.json");
		const before = readFileSync(path, "utf8");
		markSeen(p, 99);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readUsageLog(p.rootDir).seen.build).toBe(5);
		expect(seenKeys(p)).toEqual([
			"build",
			"feed",
			"feed --source",
			"mode:dev",
			"mode:prod",
		]);
	});

	test("a corrupt seen file starts over", () => {
		const p = tempProject();
		markSeen(p, 5);
		writeFileSync(join(p.rootDir, ".outdo", "usage-seen.json"), "{nope");
		expect(readUsageLog(p.rootDir).seen).toEqual({});
		markSeen(p, 7);
		expect(readUsageLog(p.rootDir).seen.build).toBe(7);
	});
});

describe("parseUsageLog", () => {
	test("skips torn and foreign lines; ran defaults to tasks", () => {
		const parsed = parseUsageLog(
			[
				'{"id":"a","t":1,"via":"cli","tasks":["x"]}',
				'{"id":"b","t":2,"via"',
				"not json",
				'{"something":"else"}',
				'{"end":"a","t":3,"ok":true}',
				"",
			].join("\n"),
		);
		expect(parsed.starts).toHaveLength(1);
		expect(parsed.starts[0]?.ran).toEqual([
			"x",
		]);
		expect(parsed.ends.get("a")?.ok).toBe(true);
	});

	test("a missing log reads as empty", () => {
		const log = readUsageLog(join(tmpdir(), "outdo-no-such-dir-usage"));
		expect(log.starts).toEqual([]);
		expect(log.seen).toEqual({});
	});
});
