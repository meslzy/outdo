import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callsIn, historyFiles, parseHistory, readShellHistory, splitCommand } from "~/core/history";

describe("parseHistory", () => {
	test("zsh extended history, with a multi-line command", () => {
		const entries = parseHistory(
			[
				": 1787472697:0;outdo dev",
				": 1787472700:3;outdo feed \\",
				"--source eco",
				"plain line",
				"",
			].join("\n"),
			"/home/me/.zsh_history",
		);
		expect(entries).toEqual([
			{
				t: 1_787_472_697_000,
				command: "outdo dev",
			},
			{
				t: 1_787_472_700_000,
				command: "outdo feed \n--source eco",
			},
			{
				t: undefined,
				command: "plain line",
			},
		]);
	});

	test("bash with HISTTIMEFORMAT stamps", () => {
		expect(
			parseHistory(
				[
					"#1787472697",
					"outdo test",
					"ls",
				].join("\n"),
				"/home/me/.bash_history",
			),
		).toEqual([
			{
				t: 1_787_472_697_000,
				command: "outdo test",
			},
			{
				t: undefined,
				command: "ls",
			},
		]);
	});

	test("fish", () => {
		expect(
			parseHistory(
				[
					"- cmd: outdo up --mode prod",
					"  when: 1787472697",
					"  paths:",
					"    - x",
					"- cmd: echo a\\nb",
				].join("\n"),
				"/home/me/.local/share/fish/fish_history",
			),
		).toEqual([
			{
				t: 1_787_472_697_000,
				command: "outdo up --mode prod",
			},
			{
				t: undefined,
				command: "echo a\nb",
			},
		]);
	});

	test("PowerShell backtick continuation", () => {
		expect(
			parseHistory("bunx outdo build `\r\n--force\r\nls\r\n", "ConsoleHost_history.txt").map((e) => e.command),
		).toEqual([
			"bunx outdo build \n--force",
			"ls",
		]);
	});
});

describe("splitCommand", () => {
	test("operators split commands; quotes group words", () => {
		expect(splitCommand(`cd x && outdo "db reset" --yes; bun run 'a b' | tee log || (outdo fix)`)).toEqual([
			[
				"cd",
				"x",
			],
			[
				"outdo",
				"db reset",
				"--yes",
			],
			[
				"bun",
				"run",
				"a b",
			],
			[
				"tee",
				"log",
			],
			[
				"outdo",
				"fix",
			],
		]);
		expect(splitCommand(`outdo ""`)).toEqual([
			[
				"outdo",
				"",
			],
		]);
	});
});

describe("callsIn", () => {
	test("every way of calling outdo", () => {
		const argvs = [
			"outdo gate",
			"bunx outdo gate",
			"bunx --bun outdo@0.2.0 gate",
			"bun x @meslzy/outdo gate",
			"OUTDO_NO_LOCAL=1 time ./node_modules/.bin/outdo gate",
			"sudo outdo gate",
		].map((c) => callsIn(c));
		for (const calls of argvs) {
			expect(calls).toEqual([
				{
					kind: "outdo",
					argv: [
						"gate",
					],
				},
			]);
		}
	});

	test("bun scripts, but not bun's own commands or files", () => {
		expect(
			callsIn("bun run dev && bun lint && bun i && bun test && bun src/cli.ts && bun run --filter '*' build"),
		).toEqual([
			{
				kind: "script",
				script: "dev",
			},
			{
				kind: "script",
				script: "lint",
			},
		]);
		expect(callsIn("bunx tsc --noEmit")).toEqual([]);
		expect(callsIn("bun run test")).toEqual([
			{
				kind: "script",
				script: "test",
			},
		]);
		expect(callsIn("echo outdo")).toEqual([]);
	});
});

describe("history files", () => {
	test("HISTFILE and each shell's default location, when present", () => {
		const home = mkdtempSync(join(tmpdir(), "outdo-home-"));
		writeFileSync(join(home, ".zsh_history"), ": 1787472697:0;outdo dev\n");
		mkdirSync(join(home, ".local", "share", "fish"), {
			recursive: true,
		});
		writeFileSync(join(home, ".local", "share", "fish", "fish_history"), "- cmd: outdo up\n  when: 1787472697\n");
		const custom = join(home, "hist");
		writeFileSync(custom, "outdo test\n");
		const files = historyFiles(
			{
				HISTFILE: custom,
			},
			home,
		);
		expect(files).toEqual([
			custom,
			join(home, ".zsh_history"),
			join(home, ".local", "share", "fish", "fish_history"),
		]);
		const read = readShellHistory([
			...files,
			join(home, "missing"),
		]);
		expect(read.files).toEqual(files);
		expect(read.entries.map((e) => e.command)).toEqual([
			"outdo test",
			"outdo dev",
			"outdo up",
		]);
	});

	test("APPDATA's PSReadLine history on Windows", () => {
		const home = mkdtempSync(join(tmpdir(), "outdo-home-"));
		const dir = join(home, "AppData", "Microsoft", "Windows", "PowerShell", "PSReadLine");
		mkdirSync(dir, {
			recursive: true,
		});
		writeFileSync(join(dir, "ConsoleHost_history.txt"), "outdo dev\n");
		expect(
			historyFiles(
				{
					APPDATA: join(home, "AppData"),
				},
				home,
			),
		).toEqual([
			join(dir, "ConsoleHost_history.txt"),
		]);
	});
});
