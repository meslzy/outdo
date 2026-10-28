import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FingerprintInputs } from "~/core/cache";
import { cacheable, checkCache, diagnoseCache, writeCache } from "~/core/cache";
import type { Task } from "~/core/model";
import { TASK_EXTRAS } from "./task-extras";

let dir: string;

/** Remove the stored-outputs copies (keep the manifests). */
function dropStore(root: string): void {
	const cache = join(root, ".outdo", "cache");
	for (const entry of readdirSync(cache)) {
		if (!entry.endsWith(".json")) {
			rmSync(join(cache, entry), {
				recursive: true,
				force: true,
			});
		}
	}
}

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		name: "build",
		desc: undefined,
		group: undefined,
		...TASK_EXTRAS,
		deps: [],
		depEdges: [],
		env: undefined,
		args: {},
		inputs: [
			"src/**/*.txt",
		],
		outputs: [],
		watch: [],
		persistent: false,
		ready: undefined,
		retry: undefined,
		timeoutMs: undefined,
		cwd: dir,
		run: () => {},
		sourceConfig: join(dir, "do.ts"),
		localName: "build",
		...overrides,
	};
}

const baseInputs = (): FingerprintInputs => ({
	envOutput: null,
	args: {},
	rest: [],
	depFingerprints: [],
	depOutputs: [],
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "outdo-cache-unit-"));
	mkdirSync(join(dir, "src"), {
		recursive: true,
	});
	writeFileSync(join(dir, "src", "a.txt"), "alpha");
});

describe("cacheable", () => {
	test("requires inputs, a run body, and non-persistence", () => {
		expect(cacheable(makeTask())).toBe(true);
		expect(
			cacheable(
				makeTask({
					inputs: [],
				}),
			),
		).toBe(false);
		expect(
			cacheable(
				makeTask({
					run: undefined,
				}),
			),
		).toBe(false);
		expect(
			cacheable(
				makeTask({
					persistent: true,
				}),
			),
		).toBe(false);
	});
});

describe("checkCache", () => {
	test("miss -> write -> hit -> invalidate on edit", async () => {
		const task = makeTask();
		const cold = await checkCache(dir, task, baseInputs(), false);
		expect(cold.hit).toBe(false);

		await writeCache(dir, task, cold, {
			answer: 42,
		});
		const warm = await checkCache(dir, task, baseInputs(), false);
		expect(warm.hit).toBe(true);
		expect(warm.previousOutput).toEqual({
			answer: 42,
		});

		writeFileSync(join(dir, "src", "a.txt"), "alpha-changed");
		const stale = await checkCache(dir, task, baseInputs(), false);
		expect(stale.hit).toBe(false);
		expect(stale.fingerprint).not.toBe(warm.fingerprint);
	});

	test("--force is always a miss but still computes a fresh fingerprint", async () => {
		const task = makeTask();
		const cold = await checkCache(dir, task, baseInputs(), false);
		await writeCache(dir, task, cold);
		const forced = await checkCache(dir, task, baseInputs(), true);
		expect(forced.hit).toBe(false);
		expect(forced.fingerprint).toBe(cold.fingerprint);
	});

	test("missing declared outputs are restored from the store on a fingerprint match", async () => {
		const task = makeTask({
			outputs: [
				"out/**",
			],
		});
		mkdirSync(join(dir, "out"));
		writeFileSync(join(dir, "out", "bundle.js"), "bundled");
		const cold = await checkCache(dir, task, baseInputs(), false);
		await writeCache(dir, task, cold);
		expect((await checkCache(dir, task, baseInputs(), false)).hit).toBe(true);

		rmSync(join(dir, "out"), {
			recursive: true,
		});
		const preview = await checkCache(dir, task, baseInputs(), false, false);
		expect(preview.hit).toBe(true);
		expect(existsSync(join(dir, "out", "bundle.js"))).toBe(false); // previews never write

		const restored = await checkCache(dir, task, baseInputs(), false);
		expect(restored.hit).toBe(true);
		expect(restored.restored).toBe(true);
		expect(readFileSync(join(dir, "out", "bundle.js"), "utf8")).toBe("bundled");
	});

	test("missing outputs with no stored copy turn a fingerprint match into a miss", async () => {
		const task = makeTask({
			outputs: [
				"out/**",
			],
		});
		mkdirSync(join(dir, "out"));
		writeFileSync(join(dir, "out", "bundle.js"), "x");
		const cold = await checkCache(dir, task, baseInputs(), false);
		await writeCache(dir, task, cold);
		dropStore(dir);
		rmSync(join(dir, "out"), {
			recursive: true,
		});
		expect((await checkCache(dir, task, baseInputs(), false)).hit).toBe(false);
	});

	test("every fingerprint input component invalidates independently", async () => {
		const task = makeTask();
		const base = await checkCache(dir, task, baseInputs(), false);
		const variants: FingerprintInputs[] = [
			{
				...baseInputs(),
				envOutput: {
					KEY: "v",
				},
			},
			{
				...baseInputs(),
				args: {
					mode: "prod",
				},
			},
			{
				...baseInputs(),
				rest: [
					"--bail",
				],
			},
			{
				...baseInputs(),
				depFingerprints: [
					"abc",
				],
			},
			{
				...baseInputs(),
				depOutputs: [
					'{"v":1}',
				],
			},
		];
		for (const inputs of variants) {
			expect((await checkCache(dir, task, inputs, false)).fingerprint).not.toBe(base.fingerprint);
		}
	});

	test("writeCache never throws, even with an unwritable cache dir", async () => {
		const task = makeTask();
		const decision = await checkCache(dir, task, baseInputs(), false);
		// rootDir points at a FILE — .outdo/cache creation must fail internally.
		const bogusRoot = join(dir, "src", "a.txt");
		await expect(writeCache(bogusRoot, task, decision)).resolves.toBeUndefined();
	});
});

describe("diagnoseCache", () => {
	test("cold cache reports no-manifest", async () => {
		const diagnosis = await diagnoseCache(dir, makeTask(), baseInputs(), false);
		expect(diagnosis.hit).toBe(false);
		expect(diagnosis.reasons.map((r) => r.kind)).toContain("no-manifest");
	});

	test("names the changed component and the exact files", async () => {
		const task = makeTask();
		const cold = await checkCache(dir, task, baseInputs(), false);
		await writeCache(dir, task, cold);

		writeFileSync(join(dir, "src", "a.txt"), "modified");
		writeFileSync(join(dir, "src", "b.txt"), "added");
		const diagnosis = await diagnoseCache(dir, task, baseInputs(), false);
		const inputsChanged = diagnosis.reasons.find((r) => r.kind === "inputs-changed");
		expect(inputsChanged).toEqual({
			kind: "inputs-changed",
			added: [
				"src/b.txt",
			],
			removed: [],
			modified: [
				"src/a.txt",
			],
		});
	});

	test("env / deps / dep-outputs changes are attributed to their component", async () => {
		const task = makeTask();
		const cold = await checkCache(dir, task, baseInputs(), false);
		await writeCache(dir, task, cold);

		const env = await diagnoseCache(
			dir,
			task,
			{
				...baseInputs(),
				envOutput: {
					X: 1,
				},
			},
			false,
		);
		expect(env.reasons.map((r) => r.kind)).toEqual([
			"env-changed",
		]);

		const deps = await diagnoseCache(
			dir,
			task,
			{
				...baseInputs(),
				depFingerprints: [
					"f1",
				],
			},
			false,
		);
		expect(deps.reasons.map((r) => r.kind)).toEqual([
			"deps-changed",
		]);

		const depOutputs = await diagnoseCache(
			dir,
			task,
			{
				...baseInputs(),
				depOutputs: [
					'"new"',
				],
			},
			false,
		);
		expect(depOutputs.reasons.map((r) => r.kind)).toEqual([
			"dep-outputs-changed",
		]);
	});

	test("force is reported alongside the real state", async () => {
		const task = makeTask();
		const cold = await checkCache(dir, task, baseInputs(), false);
		await writeCache(dir, task, cold);
		const diagnosis = await diagnoseCache(dir, task, baseInputs(), true);
		expect(diagnosis.hit).toBe(false);
		expect(diagnosis.reasons).toEqual([
			{
				kind: "forced",
			},
		]);
	});

	test("outputs-missing is diagnosed on a fingerprint match", async () => {
		const task = makeTask({
			outputs: [
				"out/**",
			],
		});
		mkdirSync(join(dir, "out"));
		writeFileSync(join(dir, "out", "x"), "x");
		const cold = await checkCache(dir, task, baseInputs(), false);
		await writeCache(dir, task, cold);
		dropStore(dir);
		rmSync(join(dir, "out"), {
			recursive: true,
		});
		const diagnosis = await diagnoseCache(dir, task, baseInputs(), false);
		expect(diagnosis.reasons.map((r) => r.kind)).toEqual([
			"outputs-missing",
		]);
	});
});
