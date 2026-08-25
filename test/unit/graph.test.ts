import { describe, expect, test } from "bun:test";
import { BundoError } from "~/core/errors";
import { assertAcyclic, dependents, subgraphFor, topoOrder } from "~/core/graph";
import type { Task } from "~/core/model";

function makeTasks(defs: Record<string, string[]>): Map<string, Task> {
	const map = new Map<string, Task>();
	for (const [name, deps] of Object.entries(defs)) {
		map.set(name, {
			name,
			desc: undefined,
			group: undefined,
			deps,
			env: undefined,
			args: {},
			inputs: [],
			outputs: [],
			watch: [],
			persistent: false,
			cwd: process.cwd(),
			run: undefined,
			built: false,
			sourceConfig: "do.ts",
			localName: name,
		});
	}
	return map;
}

describe("assertAcyclic", () => {
	test("accepts a DAG", () => {
		const tasks = makeTasks({
			a: [],
			b: [
				"a",
			],
			c: [
				"a",
				"b",
			],
		});
		expect(() => assertAcyclic(tasks)).not.toThrow();
	});

	test("throws with the cycle path", () => {
		const tasks = makeTasks({
			a: [
				"b",
			],
			b: [
				"c",
			],
			c: [
				"a",
			],
		});
		try {
			assertAcyclic(tasks);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(BundoError);
			expect((error as BundoError).code).toBe("cycle");
			expect((error as BundoError).message).toContain("a -> b -> c -> a");
		}
	});

	test("throws on a self-dependency", () => {
		const tasks = makeTasks({
			solo: [
				"solo",
			],
		});
		expect(() => assertAcyclic(tasks)).toThrow("solo -> solo");
	});
});

describe("subgraphFor", () => {
	test("collects the transitive closure", () => {
		const tasks = makeTasks({
			a: [],
			b: [
				"a",
			],
			c: [
				"b",
			],
			d: [],
		});
		expect(
			[
				...subgraphFor(tasks, [
					"c",
				]),
			].toSorted(),
		).toEqual([
			"a",
			"b",
			"c",
		]);
	});
});

describe("topoOrder", () => {
	test("puts dependencies first", () => {
		const tasks = makeTasks({
			a: [],
			b: [
				"a",
			],
			c: [
				"b",
				"a",
			],
		});
		const subset = subgraphFor(tasks, [
			"c",
		]);
		const order = topoOrder(tasks, subset);
		expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
		expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
	});
});

describe("dependents", () => {
	test("reverses edges", () => {
		const tasks = makeTasks({
			a: [],
			b: [
				"a",
			],
			c: [
				"a",
			],
		});
		const rev = dependents(tasks);
		expect(
			[
				...(rev.get("a") ?? []),
			].toSorted(),
		).toEqual([
			"b",
			"c",
		]);
	});
});
