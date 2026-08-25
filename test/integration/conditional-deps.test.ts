import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli } from "./helpers";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "conditional-deps");
const CYCLE_FIXTURE = join(import.meta.dir, "..", "fixtures", "conditional-cycle");

describe("conditional deps", () => {
	test("string condition: edge inactive when env var unset", async () => {
		const result = await runCli(FIXTURE, [
			"gated",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("GATED RAN");
		expect(result.stdout).not.toContain("BASE RAN");
	});

	test("string condition: edge active when env var truthy", async () => {
		const result = await runCli(
			FIXTURE,
			[
				"gated",
			],
			{
				RUN_BASE: "1",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("BASE RAN");
		expect(result.stdout).toContain("GATED RAN");
		expect(result.stdout.indexOf("BASE RAN")).toBeLessThan(result.stdout.indexOf("GATED RAN"));
	});

	test('string condition: "0" and "false" are falsy', async () => {
		for (const value of [
			"0",
			"false",
			"",
		]) {
			const result = await runCli(
				FIXTURE,
				[
					"gated",
				],
				{
					RUN_BASE: value,
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("BASE RAN");
		}
	});

	test("predicate condition sees the resolved env", async () => {
		const off = await runCli(FIXTURE, [
			"pred",
		]);
		expect(off.stdout).not.toContain("BASE RAN");

		const on = await runCli(
			FIXTURE,
			[
				"pred",
			],
			{
				PRED_ON: "yes",
			},
		);
		expect(on.stdout).toContain("BASE RAN");
		expect(on.stdout).toContain("PRED RAN");
	});

	test("optional dep on a missing task is silently pruned", async () => {
		const result = await runCli(FIXTURE, [
			"soft",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("BASE RAN");
		expect(result.stdout).toContain("SOFT RAN");
	});

	test("--dry=json reports inactive deps", async () => {
		const result = await runCli(FIXTURE, [
			"--dry=json",
			"gated",
		]);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout) as {
			plan: {
				name: string;
				deps: string[];
				inactiveDeps?: string[];
			}[];
		};
		const gated = parsed.plan.find((t) => t.name === "gated");
		expect(gated?.deps).toEqual([]);
		expect(gated?.inactiveDeps).toEqual([
			"base",
		]);
	});

	test("graph --json carries edge metadata", async () => {
		const result = await runCli(FIXTURE, [
			"graph",
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout) as {
			edges: {
				from: string;
				to: string;
				if?: string;
				optional?: boolean;
			}[];
		};
		const gatedEdge = parsed.edges.find((e) => e.to === "gated");
		expect(gatedEdge).toEqual({
			from: "base",
			to: "gated",
			if: "RUN_BASE",
		});
		const predEdge = parsed.edges.find((e) => e.to === "pred");
		expect(predEdge?.if).toBe("<fn>");
	});

	test("graph mermaid renders conditional edges dashed", async () => {
		const result = await runCli(FIXTURE, [
			"graph",
		]);
		expect(result.stdout).toContain("-.->|if RUN_BASE|");
	});

	test("a cycle through an inactive conditional edge is still an error", async () => {
		const result = await runCli(CYCLE_FIXTURE, [
			"y",
		]);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("cycle");
	});
});
