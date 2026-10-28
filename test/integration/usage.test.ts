import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageEnd, UsageStart } from "~/core/usage";
import type { TaskUsage, UsageReport } from "~/core/usage-report";
import { copyFixture, runCli } from "./helpers";

/** A clean environment: no CI, no agent markers, not nested, recording on. */
const PERSON: Record<string, string> = {
	CI: "",
	OUTDO_NO_USAGE: "",
	OUTDO_NESTED: "",
	OUTDO_VIA: "",
	AI_AGENT: "",
	CLAUDECODE: "",
	CODEX_SANDBOX: "",
	CODEX_THREAD_ID: "",
	CURSOR_AGENT: "",
	GEMINI_CLI: "",
};

function readLog(dir: string): {
	starts: UsageStart[];
	ends: UsageEnd[];
} {
	const path = join(dir, ".outdo", "usage.jsonl");
	const records = existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as UsageStart & UsageEnd)
		: [];
	return {
		starts: records.filter((r) => r.end === undefined),
		ends: records.filter((r) => r.end !== undefined),
	};
}

async function report(dir: string, env: Record<string, string> = PERSON): Promise<UsageReport> {
	const result = await runCli(
		dir,
		[
			"usage",
			"--json",
			"--no-history",
		],
		env,
	);
	expect(result.exitCode).toBe(0);
	return JSON.parse(result.stdout) as UsageReport;
}

const find = (r: UsageReport, name: string): TaskUsage => r.tasks.find((t) => t.name === name) as TaskUsage;

describe("usage log", () => {
	let dir: string;
	beforeAll(async () => {
		dir = copyFixture("usage");
		const runs: [
			string[],
			Record<string, string>,
		][] = [
			[
				[
					"feed",
					"C-1",
					"--source",
					"eco",
					"--verbose",
					"--mode",
					"prod",
				],
				PERSON,
			],
			[
				[
					"test",
				],
				{
					...PERSON,
					AI_AGENT: "claude-code_2-1-312",
				},
			],
			[
				[
					"nest",
				],
				PERSON,
			],
			[
				[
					"hooks",
					"run",
					"pre-commit",
				],
				PERSON,
			],
		];
		for (const [args, env] of runs) {
			const result = await runCli(dir, args, env);
			expect(result.exitCode).toBe(0);
		}
	});

	test("each run: what was asked for, the flags given (choice values only), mode, who", () => {
		const { starts, ends } = readLog(dir);
		const feed = starts.find((s) => s.tasks[0] === "feed");
		expect(feed).toMatchObject({
			via: "cli",
			tasks: [
				"feed",
			],
			ran: [
				"feed",
			],
			flags: [
				"source=eco",
				"id",
				"verbose",
			],
			mode: "prod",
		});
		expect(feed?.agent).toBeUndefined();
		expect(JSON.stringify(feed)).not.toContain("C-1");
		const end = ends.find((e) => e.end === feed?.id);
		expect(end?.ok).toBe(true);
		expect(typeof end?.ms?.feed).toBe("number");
		expect(starts.find((s) => s.tasks[0] === "test")).toMatchObject({
			agent: "claude-code",
			ran: [
				"build",
				"test",
			],
			mode: "dev",
		});
	});

	test("an outdo run inside a task is nested; a hook run names its hook", () => {
		const { starts } = readLog(dir);
		expect(starts.find((s) => s.via === "nested")?.tasks).toEqual([
			"build",
		]);
		expect(starts.find((s) => s.via === "hook")).toMatchObject({
			hook: "pre-commit",
			tasks: [
				"hooks:pre-commit",
			],
		});
	});

	test("not recorded: --dry, OUTDO_NO_USAGE=1, CI", async () => {
		const before = readLog(dir).starts.length;
		for (const [args, env] of [
			[
				[
					"--dry",
					"build",
				],
				PERSON,
			],
			[
				[
					"build",
				],
				{
					...PERSON,
					OUTDO_NO_USAGE: "1",
				},
			],
			[
				[
					"build",
				],
				{
					...PERSON,
					CI: "true",
				},
			],
		] as const) {
			expect(
				(
					await runCli(
						dir,
						[
							...args,
						],
						env,
					)
				).exitCode,
			).toBe(0);
		}
		expect(readLog(dir).starts.length).toBe(before);
	});

	test("outdo usage --json: counts, statuses, flags, duplicates", async () => {
		const r = await report(dir);
		// feed, test, nest, the build nest runs, the hook
		expect(r.runs).toBe(5);
		expect(find(r, "feed")).toMatchObject({
			you: 1,
			agent: 0,
			status: "used",
		});
		expect(find(r, "test")).toMatchObject({
			you: 0,
			agent: 1,
		});
		expect(find(r, "build").deps).toBe(2);
		expect(find(r, "stale")).toMatchObject({
			status: "unused",
			usedBy: [],
		});
		expect(find(r, "deploy")).toMatchObject({
			status: "referenced",
			usedBy: [
				".github/workflows/ci.yml",
			],
		});
		expect(find(r, "feed").flags.find((f) => f.flag === "source")).toMatchObject({
			given: 1,
			values: {
				eco: 1,
			},
		});
		expect(r.modes).toEqual([
			{
				name: "dev",
				runs: 4,
			},
			{
				name: "prod",
				runs: 1,
			},
		]);
		expect(r.hooks).toEqual([
			{
				name: "pre-commit",
				runs: 1,
			},
		]);
		expect(r.duplicates).toEqual([
			{
				kind: "hidden-script",
				task: "test",
				pkg: "",
				script: "test",
				command: "echo package-test",
				typed: 0,
			},
			{
				kind: "runs-own-script",
				task: "lint",
				command: "bun run lint",
			},
		]);
	});

	test("the report, and one task's view", async () => {
		const text = await runCli(
			dir,
			[
				"usage",
				"--no-history",
			],
			PERSON,
		);
		expect(text.exitCode).toBe(0);
		expect(text.stdout).toContain("5 runs recorded since");
		expect(text.stdout).toContain("most used");
		expect(text.stdout).toContain("unused — ");
		expect(text.stdout).toContain("stale");
		expect(text.stdout).toContain('"lint" runs "bun run lint"');

		const one = await runCli(
			dir,
			[
				"usage",
				"feed",
				"--no-history",
			],
			PERSON,
		);
		expect(one.exitCode).toBe(0);
		expect(one.stdout).toContain("you 1 · agent 0");
		expect(one.stdout).toContain("--source");
		expect(one.stdout).toContain("eco 1");

		const unknown = await runCli(
			dir,
			[
				"usage",
				"nope",
			],
			PERSON,
		);
		expect(unknown.exitCode).toBe(2);
		expect(unknown.stderr).toContain('Unknown task "nope"');

		const badSince = await runCli(
			dir,
			[
				"usage",
				"--since",
				"soon",
			],
			PERSON,
		);
		expect(badSince.exitCode).toBe(2);
	});

	test("shell history keeps a typed task off the unused list", async () => {
		const home = mkdtempSync(join(tmpdir(), "outdo-usage-home-"));
		const history = join(home, "zsh_history");
		writeFileSync(history, ": 1787472697:0;cd somewhere && bunx outdo stale\n: 1787472698:0;bun run lint\n");
		const result = await runCli(
			dir,
			[
				"usage",
				"--json",
			],
			{
				...PERSON,
				HISTFILE: history,
				HOME: home,
				USERPROFILE: home,
				APPDATA: home,
				XDG_DATA_HOME: home,
			},
		);
		expect(result.exitCode).toBe(0);
		const r = JSON.parse(result.stdout) as UsageReport;
		expect(find(r, "stale")).toMatchObject({
			typed: 1,
			status: "used",
		});
		expect(r.history.calls).toBe(1);
	});
});
