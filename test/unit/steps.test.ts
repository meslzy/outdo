import { describe, expect, test } from "bun:test";
import { normalizeEntry, withStepEdges } from "~/core/config";
import { OutdoError } from "~/core/errors";
import { applySteps, subgraphFor, topoOrder, trimSteps } from "~/core/graph";
import type { Task } from "~/core/model";

function makeTasks(defs: Record<string, Record<string, unknown>>): Map<string, Task> {
	const map = new Map<string, Task>();
	for (const [name, raw] of Object.entries(defs)) {
		const task = normalizeEntry(name, raw, {
			configPath: "do.ts",
			baseDir: process.cwd(),
			kind: "task",
		});
		withStepEdges(task);
		map.set(name, task);
	}
	return map;
}

function plan(tasks: Map<string, Task>, requested: string[]): string[] {
	const subset = subgraphFor(tasks, requested);
	return topoOrder(applySteps(tasks, subset), subset);
}

describe("steps", () => {
	const tasks = makeTasks({
		clean: {},
		fix: {},
		typegen: {},
		tsc: {
			deps: [
				"typegen",
			],
		},
		test: {},
		gate: {
			deps: [
				"clean",
			],
			steps: [
				"fix",
				"tsc",
				"test",
			],
		},
	});

	test("steps become deps of the task", () => {
		expect(tasks.get("gate")?.deps).toEqual([
			"clean",
			"fix",
			"tsc",
			"test",
		]);
	});

	test("each step's new tasks wait for the previous step (the first waits for deps)", () => {
		const subset = subgraphFor(tasks, [
			"gate",
		]);
		const planned = applySteps(tasks, subset);
		expect(planned.get("fix")?.after).toEqual([
			"clean",
		]);
		expect(planned.get("typegen")?.after).toEqual([
			"fix",
		]);
		expect(planned.get("tsc")?.after).toEqual([]);
		expect(planned.get("test")?.after).toEqual([
			"tsc",
		]);
		expect(
			plan(tasks, [
				"gate",
			]),
		).toEqual([
			"clean",
			"fix",
			"typegen",
			"tsc",
			"test",
			"gate",
		]);
	});

	test("ordering edges are per run: a step alone has no extra predecessors", () => {
		expect(
			plan(tasks, [
				"tsc",
			]),
		).toEqual([
			"typegen",
			"tsc",
		]);
		expect(tasks.get("typegen")?.after).toEqual([]);
	});

	test("--from / --until keep a range of steps", () => {
		const gate = tasks.get("gate") as Task;
		expect(trimSteps(gate, "tsc", undefined).steps).toEqual([
			"tsc",
			"test",
		]);
		expect(trimSteps(gate, undefined, "fix").steps).toEqual([
			"fix",
		]);
		const trimmed = trimSteps(gate, "tsc", "tsc");
		expect(trimmed.deps).toEqual([
			"clean",
			"tsc",
		]);
	});

	test("unknown or inverted ranges are usage errors", () => {
		const gate = tasks.get("gate") as Task;
		expect(() => trimSteps(gate, "nope", undefined)).toThrow(OutdoError);
		expect(() => trimSteps(gate, "test", "fix")).toThrow("comes after");
		expect(() => trimSteps(tasks.get("fix") as Task, "x", undefined)).toThrow("has none");
	});
});
