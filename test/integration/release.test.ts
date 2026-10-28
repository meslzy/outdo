/**
 * End-to-end coverage for the big-release authoring surface, driven through
 * the real CLI against test/fixtures/release.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, copyFixture, gitAvailable, initGit, runCli } from "./helpers";

const RELEASE = join(import.meta.dir, "..", "fixtures", "release");

/** Run the CLI with text on stdin (for confirmation prompts). */
async function runWithInput(
	cwd: string,
	args: string[],
	input: string,
	env: Record<string, string> = {},
): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	const proc = Bun.spawn(
		[
			process.execPath,
			CLI,
			"--color=never",
			...args,
		],
		{
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
				...env,
			},
		},
	);
	proc.stdin.write(input);
	await proc.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		exitCode,
		stdout,
		stderr,
	};
}

describe("one-line tasks", () => {
	test("a string is a command", async () => {
		const r = await runCli(RELEASE, [
			"hello",
		]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("hello-from-command");
	});

	test("a list runs in order", async () => {
		const r = await runCli(RELEASE, [
			"pair",
		]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.indexOf("first-command")).toBeLessThan(r.stdout.indexOf("second-command"));
	});

	test("args after -- are appended to the command", async () => {
		const r = await runCli(RELEASE, [
			"echoargs",
			"--",
			"one",
			"two words",
		]);
		expect(r.stdout).toContain("got one two words");
	});

	test("the child backend runs commands too (no do.ts import needed)", async () => {
		const r = await runCli(RELEASE, [
			"--isolate",
			"hello",
		]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("hello | hello-from-command");
	});
});

describe("steps", () => {
	test("run in order, each with its deps", async () => {
		const r = await runCli(RELEASE, [
			"gate",
		]);
		expect(r.exitCode).toBe(0);
		const order = [
			"STEP fix",
			"STEP typegen",
			"STEP tsc",
			"STEP test",
		].map((line) => r.stdout.indexOf(line));
		expect(order.every((at) => at >= 0)).toBe(true);
		expect(
			[
				...order,
			].sort((a, b) => a - b),
		).toEqual(order);
	});

	test("--from and --until (after the task name) pick a range", async () => {
		const from = await runCli(RELEASE, [
			"gate",
			"--from",
			"tsc",
		]);
		expect(from.stdout).not.toContain("STEP fix");
		expect(from.stdout).toContain("STEP tsc");
		expect(from.stdout).toContain("STEP test");
		const until = await runCli(RELEASE, [
			"gate",
			"--until=fix",
		]);
		expect(until.stdout).toContain("STEP fix");
		expect(until.stdout).not.toContain("STEP tsc");
	});

	test("--dry shows the step order", async () => {
		const r = await runCli(RELEASE, [
			"--dry=json",
			"gate",
		]);
		const plan = JSON.parse(r.stdout).plan as {
			name: string;
			after?: string[];
		}[];
		expect(plan.find((t) => t.name === "test")?.after).toEqual([
			"tsc",
		]);
	});
});

describe("finally", () => {
	test("cleanup runs after a failure and the run still fails", async () => {
		const r = await runCli(RELEASE, [
			"guarded",
		]);
		expect(r.exitCode).toBe(1);
		expect(r.stdout).toContain("CLEANUP RAN");
		expect(r.stderr).toContain("boom failed");
		expect(r.stderr).toContain("finally: cleanup");
	});
});

describe("flags", () => {
	test("schema flags are validated and typed", async () => {
		const ok = await runCli(RELEASE, [
			"feed",
			"--source",
			"eco",
			"--runs",
			"3",
			"--id",
			"C-0001",
		]);
		expect(ok.stdout).toContain("FEED eco x3 id=C-0001");
		const defaults = await runCli(RELEASE, [
			"feed",
		]);
		expect(defaults.stdout).toContain("FEED all x1 id=-");
		const bad = await runCli(RELEASE, [
			"feed",
			"--id",
			"X",
		]);
		expect(bad.exitCode).toBe(2);
		expect(bad.stderr).toContain("--id");
	});

	test("positional values", async () => {
		const r = await runCli(RELEASE, [
			"logs",
			"web",
			"-f",
		]);
		expect(r.stdout).toContain("LOGS web follow=true");
		const bad = await runCli(RELEASE, [
			"logs",
			"db",
		]);
		expect(bad.exitCode).toBe(2);
		expect(bad.stderr).toContain("Expected one of: api, web");
	});

	test("task help shows usage, choices and steps", async () => {
		const logs = await runCli(RELEASE, [
			"logs",
			"--help",
		]);
		expect(logs.stdout).toContain("Usage: outdo logs <svc> [flags]");
		expect(logs.stdout).toContain("api | web");
		const gate = await runCli(RELEASE, [
			"gate",
			"--help",
		]);
		expect(gate.stdout).toContain("Steps: fix → tsc → test");
	});
});

describe("namespaces", () => {
	test("outdo db reset == outdo db:reset; siblings resolve first", async () => {
		const spaced = await runCli(RELEASE, [
			"db",
			"reset",
		]);
		expect(spaced.exitCode).toBe(0);
		expect(spaced.stdout).toContain("DB BACKUP");
		expect(spaced.stdout).toContain("DB RESET in dev");
		const joined = await runCli(RELEASE, [
			"db:reset",
		]);
		expect(joined.stdout).toContain("DB RESET in dev");
	});

	test("outdo db lists the namespace", async () => {
		const r = await runCli(RELEASE, [
			"db",
		]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("db:reset");
		expect(r.stdout).not.toContain("hello");
	});

	test("a typo inside a namespace suggests the right name", async () => {
		const r = await runCli(RELEASE, [
			"db",
			"rest",
		]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain('Did you mean "db:reset"?');
	});
});

describe("modes and env files", () => {
	test("the first mode is the default; --mode switches env files", async () => {
		const dev = await runCli(RELEASE, [
			"whereami",
		]);
		expect(dev.stdout).toContain("MODE=dev PLATFORM=base ROOTOK=true");
		const prod = await runCli(RELEASE, [
			"whereami",
			"--mode",
			"prod",
		]);
		expect(prod.stdout).toContain("MODE=prod PLATFORM=production");
	});

	test("an undeclared mode is a usage error", async () => {
		const r = await runCli(RELEASE, [
			"--mode",
			"staging",
			"hello",
		]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("Modes: dev, prod");
	});

	test("--print-env shows the task's env files for the mode", async () => {
		const r = await runCli(RELEASE, [
			"--mode",
			"prod",
			"--print-env",
			"whereami",
		]);
		expect(r.stdout).toContain(".env.platform.prod");
		expect(r.stdout).toContain("production");
	});
});

describe("protect / confirm", () => {
	test("without a terminal, a protected task is refused", async () => {
		const r = await runCli(RELEASE, [
			"db",
			"reset",
			"--mode",
			"prod",
		]);
		expect(r.exitCode).toBe(2);
		expect(r.stdout).not.toContain("DB BACKUP"); // asked before any dep started
		expect(r.stderr).toContain("--yes");
	});

	test("--yes confirms", async () => {
		const r = await runCli(RELEASE, [
			"--mode",
			"prod",
			"--yes",
			"db:reset",
		]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("DB RESET in prod");
	});

	test("protect only applies in its modes", async () => {
		const r = await runCli(RELEASE, [
			"db:reset",
		]);
		expect(r.exitCode).toBe(0);
	});

	test("confirm asks every time; y runs, anything else does not", async () => {
		const yes = await runWithInput(
			RELEASE,
			[
				"nuke",
			],
			"y\n",
			{
				OUTDO_ASSUME_TTY: "1",
			},
		);
		expect(yes.exitCode).toBe(0);
		expect(yes.stdout).toContain("Really nuke everything?");
		expect(yes.stdout).toContain("NUKED");
		const no = await runWithInput(
			RELEASE,
			[
				"nuke",
			],
			"n\n",
			{
				OUTDO_ASSUME_TTY: "1",
			},
		);
		expect(no.exitCode).toBe(2);
		expect(no.stdout).not.toContain("NUKED");
	});
});

describe("readonly guard", () => {
	test("OUTDO_READONLY=1 refuses tasks not marked readonly", async () => {
		const refused = await runCli(
			RELEASE,
			[
				"hello",
			],
			{
				OUTDO_READONLY: "1",
			},
		);
		expect(refused.exitCode).toBe(2);
		expect(refused.stderr).toContain("OUTDO_READONLY");
		const allowed = await runCli(
			RELEASE,
			[
				"audit",
			],
			{
				OUTDO_READONLY: "1",
			},
		);
		expect(allowed.exitCode).toBe(0);
		expect(allowed.stdout).toContain("AUDIT OK");
	});

	test("ls --json exposes the tags", async () => {
		const r = await runCli(RELEASE, [
			"ls",
			"--json",
		]);
		const tasks = JSON.parse(r.stdout).tasks as {
			name: string;
			readonly: boolean;
			destructive: boolean;
		}[];
		expect(tasks.find((t) => t.name === "audit")?.readonly).toBe(true);
		expect(tasks.find((t) => t.name === "nuke")?.destructive).toBe(true);
	});
});

describe("requires and doctor", () => {
	test("unmet requirements fail the task with the hint", async () => {
		const r = await runCli(RELEASE, [
			"needs",
		]);
		expect(r.exitCode).toBe(1);
		expect(r.stdout).not.toContain("NEEDS RAN");
		expect(r.stderr).toContain("bin definitely-not-a-real-binary-xyz");
		expect(r.stderr).toContain("install the thing first");
	});

	test("doctor checks everything at once", async () => {
		const r = await runCli(RELEASE, [
			"doctor",
			"--json",
		]);
		expect(r.exitCode).toBe(1);
		const report = JSON.parse(r.stdout);
		expect(report.ok).toBe(false);
		expect(report.tasks[0].task).toBe("needs");
	});
});

describe("ctx.ssh", () => {
	test("runs the remote command with escaped values and a label", async () => {
		const r = await runCli(
			RELEASE,
			[
				"remote",
			],
			{
				OUTDO_SSH: JSON.stringify([
					process.execPath,
					"fake-ssh.ts",
				]),
			},
		);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("vps | target=me@vps.example");
		expect(r.stdout).toContain(`vps | command=cd "$HOME"/app && echo 'it'\\''s' 'a b' c`);
		expect(r.stdout).toContain("REMOTE exit=0");
	});
});

describe("outdo ci", () => {
	test("GitHub Actions: folded groups, failure recap, annotation, step summary", async () => {
		const dir = copyFixture("release");
		const summary = join(dir, "summary.md");
		const r = await runCli(
			dir,
			[
				"ci",
				"gate",
				"guarded",
				"--all",
			],
			{
				GITHUB_ACTIONS: "true",
				GITHUB_STEP_SUMMARY: summary,
			},
		);
		expect(r.exitCode).toBe(1);
		expect(r.stdout).toContain("::group::fix");
		expect(r.stdout).toContain("::endgroup::");
		expect(r.stdout).toContain("✗ boom");
		expect(r.stdout).toContain("::error title=outdo%3A boom failed::");
		expect(r.stdout).toContain("CLEANUP RAN");
		const md = readFileSync(summary, "utf8");
		expect(md).toContain("outdo ci gate guarded");
		expect(md).toContain("`boom` | failed");
	});

	test("ci init writes a workflow and refuses to overwrite", async () => {
		const dir = copyFixture("release");
		const first = await runCli(dir, [
			"ci",
			"init",
		]);
		expect(first.exitCode).toBe(0);
		const yaml = readFileSync(join(dir, ".github", "workflows", "ci.yml"), "utf8");
		expect(yaml).toContain("bunx outdo ci");
		const again = await runCli(dir, [
			"ci",
			"init",
		]);
		expect(again.exitCode).toBe(2);
	});
});

describe("mcp", () => {
	test("lists tasks as tools and runs one", async () => {
		const proc = Bun.spawn(
			[
				process.execPath,
				CLI,
				"mcp",
			],
			{
				cwd: RELEASE,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					NO_COLOR: "1",
				},
			},
		);
		const send = (message: unknown): void => {
			proc.stdin.write(`${JSON.stringify(message)}\n`);
		};
		const responses = new Map<number, Record<string, unknown>>();
		const reader = (async () => {
			let buffer = "";
			for await (const chunk of proc.stdout) {
				buffer += new TextDecoder().decode(chunk);
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.trim() !== "") {
						const message = JSON.parse(line) as Record<string, unknown>;
						responses.set(message.id as number, message);
					}
				}
			}
		})();
		const waitFor = async (id: number): Promise<Record<string, unknown>> => {
			const deadline = Date.now() + 20_000;
			while (!responses.has(id)) {
				if (Date.now() > deadline) {
					throw new Error(`no response ${id}`);
				}
				await Bun.sleep(25);
			}
			return responses.get(id) as Record<string, unknown>;
		};
		try {
			send({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: {
						name: "test",
						version: "1",
					},
				},
			});
			const init = await waitFor(1);
			expect(
				(
					init.result as {
						serverInfo: {
							name: string;
						};
					}
				).serverInfo.name,
			).toBe("outdo");
			send({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
			});
			const tools = (
				(await waitFor(2)).result as {
					tools: Record<string, unknown>[];
				}
			).tools;
			const names = tools.map((t) => t.name);
			expect(names).toContain("db_reset");
			expect(names).not.toContain("server"); // services never finish
			const feed = tools.find((t) => t.name === "feed") as {
				inputSchema: {
					properties: Record<
						string,
						{
							enum?: string[];
						}
					>;
				};
			};
			expect(feed.inputSchema.properties.source?.enum).toEqual([
				"eco",
				"metal",
				"all",
			]);
			const reset = tools.find((t) => t.name === "db_reset") as {
				annotations: {
					destructiveHint: boolean;
				};
			};
			expect(reset.annotations.destructiveHint).toBe(true);
			send({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: {
					name: "feed",
					arguments: {
						source: "metal",
						runs: 2,
					},
				},
			});
			const call = (await waitFor(3)).result as {
				content: {
					text: string;
				}[];
				isError: boolean;
			};
			expect(call.isError).toBe(false);
			expect(call.content[0]?.text).toContain("FEED metal x2");
		} finally {
			proc.stdin.end();
			await reader.catch(() => {});
			proc.kill();
		}
	}, 30_000);
});

describe("completion", () => {
	const complete = async (cwd: string, words: string[]): Promise<string[]> => {
		const proc = Bun.spawn(
			[
				process.execPath,
				CLI,
				"__complete",
				"--",
				...words,
			],
			{
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		return out
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => l.split("\t")[0] as string);
	};

	test("flag values, positional values, namespaces, steps and modes", async () => {
		const dir = copyFixture("release");
		expect(
			await complete(dir, [
				"logs",
				"",
			]),
		).toEqual([
			"api",
			"web",
		]);
		expect(
			await complete(dir, [
				"feed",
				"--source",
				"",
			]),
		).toEqual([
			"eco",
			"metal",
			"all",
		]);
		expect(
			await complete(dir, [
				"db",
				"",
			]),
		).toEqual([
			"backup",
			"reset",
		]);
		expect(
			await complete(dir, [
				"gate",
				"--from",
				"",
			]),
		).toEqual([
			"fix",
			"tsc",
			"test",
		]);
		expect(
			await complete(dir, [
				"--mode",
				"",
			]),
		).toEqual([
			"dev",
			"prod",
		]);
	});

	test("the task list is cached and refreshed when do.ts changes", async () => {
		const dir = copyFixture("release");
		expect(
			await complete(dir, [
				"hel",
			]),
		).toEqual([
			"hello",
		]);
		expect(existsSync(join(dir, ".outdo", "complete.json"))).toBe(true);
		const doTs = join(dir, "do.ts");
		writeFileSync(
			doTs,
			readFileSync(doTs, "utf8").replace('hello: "echo hello-from-command"', 'helloworld: "echo hi"'),
		);
		expect(
			await complete(dir, [
				"hel",
			]),
		).toEqual([
			"helloworld",
		]);
	});
});

describe.skipIf(!(await gitAvailable()))("git: affected, hooks", () => {
	test("affected answers per task and writes $GITHUB_OUTPUT", async () => {
		const dir = copyFixture("release");
		expect(await initGit(dir)).toBe(true);
		const output = join(dir, "gh-output.txt");
		writeFileSync(output, "");
		const r = await runCli(
			dir,
			[
				"affected",
				"gate",
				"db:reset",
				"--github-output",
			],
			{
				GITHUB_OUTPUT: output,
				// Under GitHub Actions the base would be the PR base, which this
				// throwaway repo does not have.
				GITHUB_BASE_REF: "",
				GITHUB_EVENT_NAME: "",
			},
		);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("gate=true");
		expect(readFileSync(output, "utf8")).toContain("db_reset=true");
	});

	test("hooks install, list, run (with restage)", async () => {
		const dir = copyFixture("release");
		expect(await initGit(dir)).toBe(true);
		const install = await runCli(dir, [
			"hooks",
			"install",
		]);
		expect(install.exitCode).toBe(0);
		const hookFile = join(dir, ".git", "hooks", "pre-commit");
		expect(readFileSync(hookFile, "utf8")).toContain("outdo hooks run pre-commit");
		const list = await runCli(dir, [
			"hooks",
			"list",
		]);
		expect(list.stdout).toContain("installed");
		const run = await runCli(dir, [
			"hooks",
			"run",
			"pre-commit",
		]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("STEP fix");
		expect(run.stdout).toContain("STEP test");
		const uninstall = await runCli(dir, [
			"hooks",
			"uninstall",
		]);
		expect(uninstall.stdout).toContain("removed pre-commit");
		expect(existsSync(hookFile)).toBe(false);
	});
});

describe("prune --docker", () => {
	test("copies package.json files and the lockfile", async () => {
		const dir = copyFixture("scripts-ws");
		writeFileSync(join(dir, "bun.lock"), "{}\n");
		const r = await runCli(dir, [
			"prune",
			"--docker",
		]);
		expect(r.exitCode).toBe(0);
		for (const rel of [
			"package.json",
			"bun.lock",
			"packages/app/package.json",
			"packages/lib/package.json",
		]) {
			expect(existsSync(join(dir, "out", "json", rel))).toBe(true);
		}
		expect(existsSync(join(dir, "out", "json", "do.ts"))).toBe(false);
	});
});
