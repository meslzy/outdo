import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CLI } from "./helpers";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "basic");

/**
 * Shells invoke `outdo __complete ...` with no other argv — the endpoint is
 * matched at argv[0], so this helper deliberately skips runCli's
 * `--color=never` prefix.
 */
async function complete(args: string[]): Promise<string[]> {
	const proc = Bun.spawn(
		[
			process.execPath,
			CLI,
			"__complete",
			...args,
		],
		{
			cwd: FIXTURE,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
			},
		},
	);
	const [stdout, , exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(), // drain — an undrained pipe can deadlock
		proc.exited,
	]);
	expect(exitCode).toBe(0); // completions must never fail loudly
	return stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => line.split("\t")[0] as string);
}

describe("__complete endpoint", () => {
	test("first word: tasks and subcommands, hidden entries excluded", async () => {
		const values = await complete([
			"--",
		]);
		expect(values).toContain("build");
		expect(values).toContain("docker:up");
		expect(values).toContain("explain");
		expect(values).toContain("graph");
		expect(values).not.toContain("__worker");
		expect(values).not.toContain("__complete");
	});

	test("shells after `completion` — POSIX form (trailing empty word)", async () => {
		const values = await complete([
			"--",
			"completion",
			"",
		]);
		expect(values).toEqual([
			"bash",
			"zsh",
			"fish",
			"powershell",
		]);
	});

	test("shells after `completion` — PowerShell form (--empty flag)", async () => {
		// Windows PowerShell drops empty-string args to native commands, so its
		// completer signals a fresh cursor word with --empty instead.
		const values = await complete([
			"--empty",
			"--",
			"completion",
		]);
		expect(values).toEqual([
			"bash",
			"zsh",
			"fish",
			"powershell",
		]);
	});

	test("without the fresh-word signal, `completion` is treated as a partial", async () => {
		// This is the pre-fix Windows PowerShell symptom pinned as intended
		// behavior: the word is still being typed, so it completes to itself.
		const values = await complete([
			"--",
			"completion",
		]);
		expect(values).toEqual([
			"completion",
		]);
	});

	test("partial shell name filters", async () => {
		const values = await complete([
			"--",
			"completion",
			"z",
		]);
		expect(values).toEqual([
			"zsh",
		]);
	});

	test("task names after a subcommand (--empty form)", async () => {
		const values = await complete([
			"--empty",
			"--",
			"explain",
		]);
		expect(values).toContain("build");
		expect(values).toContain("greet");
	});

	test("per-task flags after a task name", async () => {
		const values = await complete([
			"--",
			"greet",
			"--n",
		]);
		expect(values).toContain("--name");
	});
});
