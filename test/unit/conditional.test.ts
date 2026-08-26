import { describe, expect, test } from "bun:test";
import { OutdoError } from "~/core/errors";
import { applyConditions, edgeActive } from "~/core/graph";
import type { DepEdge, Task } from "~/core/model";

function makeTask(name: string, depEdges: DepEdge[]): Task {
	return {
		name,
		desc: undefined,
		group: undefined,
		deps: depEdges.map((edge) => edge.task),
		depEdges,
		env: undefined,
		args: {},
		inputs: [],
		outputs: [],
		watch: [],
		persistent: false,
		ready: undefined,
		retry: undefined,
		timeoutMs: undefined,
		cwd: process.cwd(),
		run: undefined,
		sourceConfig: "do.ts",
		localName: name,
	};
}

const edge = (task: string, condition?: DepEdge["condition"]): DepEdge => ({
	task,
	optional: false,
	condition,
});

describe("edgeActive", () => {
	test("unconditional edges are always active", () => {
		expect(edgeActive(edge("a"), {})).toBe(true);
	});

	test("string condition truthiness table", () => {
		const e = edge("a", "FLAG");
		expect(edgeActive(e, {})).toBe(false);
		expect(
			edgeActive(e, {
				FLAG: "",
			}),
		).toBe(false);
		expect(
			edgeActive(e, {
				FLAG: "0",
			}),
		).toBe(false);
		expect(
			edgeActive(e, {
				FLAG: "false",
			}),
		).toBe(false);
		expect(
			edgeActive(e, {
				FLAG: "FALSE",
			}),
		).toBe(false);
		expect(
			edgeActive(e, {
				FLAG: "1",
			}),
		).toBe(true);
		expect(
			edgeActive(e, {
				FLAG: "yes",
			}),
		).toBe(true);
		expect(
			edgeActive(e, {
				FLAG: "true",
			}),
		).toBe(true);
	});

	test("predicate condition receives the env", () => {
		const e = edge("a", (env) => env.MODE === "ci");
		expect(
			edgeActive(e, {
				MODE: "ci",
			}),
		).toBe(true);
		expect(
			edgeActive(e, {
				MODE: "dev",
			}),
		).toBe(false);
	});
});

describe("applyConditions", () => {
	test("filters deps to active edges, preserves depEdges", () => {
		const tasks = new Map<string, Task>([
			[
				"base",
				makeTask("base", []),
			],
			[
				"gated",
				makeTask("gated", [
					edge("base", "GO"),
				]),
			],
		]);
		const off = applyConditions(tasks, {});
		expect(off.get("gated")?.deps).toEqual([]);
		expect(off.get("gated")?.depEdges).toHaveLength(1);

		const on = applyConditions(tasks, {
			GO: "1",
		});
		expect(on.get("gated")?.deps).toEqual([
			"base",
		]);
	});

	test("tasks without conditions are passed through unchanged", () => {
		const plain = makeTask("plain", [
			edge("base"),
		]);
		const tasks = new Map<string, Task>([
			[
				"base",
				makeTask("base", []),
			],
			[
				"plain",
				plain,
			],
		]);
		const applied = applyConditions(tasks, {});
		expect(applied.get("plain")).toBe(plain);
	});

	test("a throwing predicate becomes a config error", () => {
		const tasks = new Map<string, Task>([
			[
				"base",
				makeTask("base", []),
			],
			[
				"boom",
				makeTask("boom", [
					edge("base", () => {
						throw new Error("nope");
					}),
				]),
			],
		]);
		expect(() => applyConditions(tasks, {})).toThrow(OutdoError);
	});
});
