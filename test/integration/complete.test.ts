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

/**
 * Runs the real `outdo completion zsh` functions under zsh with the
 * completion-system builtins stubbed: `_describe` prints the candidate array
 * it was handed, so we see exactly what the menu would offer.
 */
const ZSH_HARNESS = `
outdo() { "$OUTDO_BUN" "$OUTDO_CLI" "$@"; }
compdef() { :; }
_default() { print -r -- "<default>"; }
_describe() { [[ $1 == -t ]] && shift 2; print -rl -- "\${(@P)2}"; }
eval "$(outdo completion zsh)"
words=("\${(@)argv[2,-1]}")
CURRENT=\${#words}
"$1"
`;

async function zshComplete(fn: string, words: string[]): Promise<string[]> {
	const proc = Bun.spawn(
		[
			"zsh",
			"-fc",
			ZSH_HARNESS,
			"zsh",
			fn,
			...words,
		],
		{
			cwd: FIXTURE,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
				OUTDO_BUN: process.execPath,
				OUTDO_CLI: CLI,
			},
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(stderr).toBe(""); // e.g. `_outdo:2: unrecognized modifier 'C'`
	expect(exitCode).toBe(0);
	return stdout.split("\n").filter((line) => line !== "");
}

describe.skipIf(Bun.which("zsh") === null)("zsh completion script", () => {
	test("first word: tasks with descriptions, colons escaped for _describe", async () => {
		const offered = await zshComplete("_outdo", [
			"outdo",
			"",
		]);
		expect(offered).toContain("build:Build all packages");
		expect(offered).toContain("docker\\:up:Start local containers");
	});

	test("per-task flags after a task name", async () => {
		const offered = await zshComplete("_outdo", [
			"outdo",
			"greet",
			"--n",
		]);
		expect(offered.some((line) => line.startsWith("--name:"))).toBe(true);
	});

	test("`bunx outdo` completes like `outdo`", async () => {
		const offered = await zshComplete("_outdo_bunx", [
			"bunx",
			"outdo",
			"",
		]);
		expect(offered).toContain("build:Build all packages");
	});

	test("other `bunx` packages fall back to default completion", async () => {
		const offered = await zshComplete("_outdo_bunx", [
			"bunx",
			"",
		]);
		expect(offered).toEqual([
			"<default>",
		]);
	});
});

/**
 * Runs the real `outdo completion bash` functions under bash: COMP_WORDS and
 * COMP_CWORD are set as bash would, `complete` is stubbed, COMPREPLY printed.
 */
const BASH_HARNESS = `
outdo() { "$OUTDO_BUN" "$OUTDO_CLI" "$@"; }
complete() { :; }
eval "$(outdo completion bash)"
fn=$1
shift
COMP_WORDS=("$@")
COMP_CWORD=$(( \${#COMP_WORDS[@]} - 1 ))
COMPREPLY=()
"$fn"
printf '%s\n' "\${COMPREPLY[@]}"
`;

async function bashComplete(fn: string, words: string[]): Promise<string[]> {
	const proc = Bun.spawn(
		[
			"bash",
			"--norc",
			"--noprofile",
			"-c",
			BASH_HARNESS,
			"bash",
			fn,
			...words,
		],
		{
			cwd: FIXTURE,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
				OUTDO_BUN: process.execPath,
				OUTDO_CLI: CLI,
			},
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	return stdout.split("\n").filter((line) => line !== "");
}

describe.skipIf(Bun.which("bash") === null)("bash completion script", () => {
	test("first word: task names", async () => {
		const offered = await bashComplete("_outdo", [
			"outdo",
			"gr",
		]);
		expect(offered).toEqual([
			"greet",
			"graph",
		]);
	});

	test("`bunx outdo` completes like `outdo`", async () => {
		const offered = await bashComplete("_outdo_bunx", [
			"bunx",
			"outdo",
			"gr",
		]);
		expect(offered).toEqual([
			"greet",
			"graph",
		]);
	});

	test("other `bunx` packages are left alone", async () => {
		const offered = await bashComplete("_outdo_bunx", [
			"bunx",
			"vite",
			"",
		]);
		expect(offered).toEqual([]);
	});
});

describe("__complete: outdo usage", () => {
	test("a task name, the command's own flags, --since spans", async () => {
		expect(
			await complete([
				"--",
				"",
			]),
		).toContain("usage");
		expect(
			await complete([
				"--",
				"usage",
				"",
			]),
		).toContain("build");
		const flags = await complete([
			"--",
			"usage",
			"--",
		]);
		expect(flags).toEqual([
			"--since",
			"--all",
			"--no-history",
			"--json",
		]);
		expect(
			await complete([
				"--",
				"usage",
				"--since",
				"",
			]),
		).toEqual([
			"7d",
			"30d",
			"90d",
		]);
		expect(
			await complete([
				"--",
				"usage",
				"build",
				"",
			]),
		).toEqual([]);
	});
});
