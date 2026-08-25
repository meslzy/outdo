import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyFixture, runCli } from "./helpers";

interface ExplainJson {
	task: string;
	backend: {
		kind: string;
		concurrency: number;
	};
	plan: string[];
	tasks: {
		name: string;
		verdict: string;
		reasons?: {
			kind: string;
			modified?: string[];
			added?: string[];
		}[];
	}[];
}

let dir: string;

beforeEach(() => {
	dir = copyFixture("cache");
});

const explainJson = async (cwd: string, task: string, env?: Record<string, string>): Promise<ExplainJson> => {
	const result = await runCli(
		cwd,
		[
			"--json",
			"explain",
			task,
		],
		env,
	);
	expect(result.exitCode).toBe(0);
	return JSON.parse(result.stdout) as ExplainJson;
};

describe("bundo explain", () => {
	test("cold cache: would-run with no-manifest; runs nothing", async () => {
		const parsed = await explainJson(dir, "compile");
		const compile = parsed.tasks.find((t) => t.name === "compile");
		expect(compile?.verdict).toBe("would-run");
		expect(compile?.reasons?.some((r) => r.kind === "no-manifest")).toBe(true);
		// Read-only: nothing executed, nothing cached.
		expect(existsSync(join(dir, "out"))).toBe(false);
		expect(existsSync(join(dir, ".bundo"))).toBe(false);
	});

	test("warm cache: would-skip; input edit names the changed file", async () => {
		await runCli(dir, [
			"compile",
		]);
		const warm = await explainJson(dir, "compile");
		expect(warm.tasks.find((t) => t.name === "compile")?.verdict).toBe("would-skip");

		const human = await runCli(dir, [
			"explain",
			"compile",
		]);
		expect(human.exitCode).toBe(0);
		expect(human.stdout).toContain("would skip");

		writeFileSync(join(dir, "src", "a.txt"), "alpha-changed\n");
		const stale = await explainJson(dir, "compile");
		const compile = stale.tasks.find((t) => t.name === "compile");
		expect(compile?.verdict).toBe("would-run");
		const inputsChanged = compile?.reasons?.find((r) => r.kind === "inputs-changed");
		expect(inputsChanged?.modified).toContain("src/a.txt");
	});

	test("env schema output change is diagnosed as env-changed", async () => {
		await runCli(dir, [
			"enved",
		]);
		const changed = await explainJson(dir, "enved", {
			CACHE_SALT: "different",
		});
		const enved = changed.tasks.find((t) => t.name === "enved");
		expect(enved?.verdict).toBe("would-run");
		expect(enved?.reasons?.some((r) => r.kind === "env-changed")).toBe(true);
	});

	test("explain shows the whole dep subgraph", async () => {
		const parsed = await explainJson(dir, "bundle");
		expect(parsed.plan).toEqual([
			"compile",
			"bundle",
		]);
	});

	test("backend detection matches the real run for the same flags", async () => {
		// Human explain of a chain: a plain `bundo bundle` runs in-process.
		const human = await runCli(dir, [
			"explain",
			"bundle",
		]);
		expect(human.stdout).toContain("sequential (in-process)");

		// With --json the prediction reflects that `bundo --json bundle` itself
		// uses the child backend (the report needs a clean stdout) — the
		// prediction must never diverge from a run with identical flags.
		const chainJson = await explainJson(dir, "bundle");
		expect(chainJson.backend.kind).toBe("parallel");

		const diamondDir = copyFixture("diamond");
		const diamond = await explainJson(diamondDir, "d");
		expect(diamond.backend.kind).toBe("parallel");
	});

	test("unknown task: exit 2 with a suggestion", async () => {
		const result = await runCli(dir, [
			"explain",
			"compil",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("Did you mean");
	});

	test("explain requires exactly one task", async () => {
		const result = await runCli(dir, [
			"explain",
		]);
		expect(result.exitCode).toBe(2);
	});
});
