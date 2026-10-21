import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { applyDefaults, parseTaskArgs, renderTaskHelp, usageLine } from "~/core/argspec";
import { normalizeEntry } from "~/core/config";
import { OutdoError } from "~/core/errors";
import type { Task } from "~/core/model";

function makeTask(raw: Record<string, unknown>): Task {
	return normalizeEntry("t", raw, {
		configPath: "do.ts",
		baseDir: process.cwd(),
		kind: "task",
	});
}

async function usageError(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(OutdoError);
		return (error as Error).message;
	}
	throw new Error("expected a usage error");
}

describe("schema flags", () => {
	const task = makeTask({
		args: {
			source: z
				.enum([
					"eco",
					"all",
				])
				.default("all")
				.describe("which feed"),
			runs: z.coerce.number().int().min(1).default(1),
			count: z.number().optional(),
			id: z.string().regex(/^C-\d{4}$/),
			dry: z.boolean(),
			tags: z.array(z.string()).optional(),
		},
	});

	test("normalization reads type, choices, defaults and required from the schema", () => {
		expect(task.args.source?.type).toBe("string");
		expect(task.args.source?.choices).toEqual([
			"eco",
			"all",
		]);
		expect(task.args.source?.description).toBe("which feed");
		expect(task.args.source?.required).toBe(false);
		expect(task.args.runs?.type).toBe("number");
		expect(task.args.id?.required).toBe(true);
		expect(task.args.dry?.type).toBe("boolean");
		expect(task.args.tags?.type).toBe("array");
	});

	test("values are validated and typed by the schema", async () => {
		const args = await parseTaskArgs(task, [
			"--id",
			"C-0007",
			"--runs",
			"3",
			"--count",
			"2.5",
			"--tags",
			"a",
			"--tags",
			"b",
		]);
		expect(args).toEqual({
			source: "all",
			runs: 3,
			count: 2.5,
			id: "C-0007",
			dry: false,
			tags: [
				"a",
				"b",
			],
		});
	});

	test("a bad value fails before anything runs, naming the choices", async () => {
		const message = await usageError(
			parseTaskArgs(task, [
				"--id",
				"C-0007",
				"--source",
				"nope",
			]),
		);
		expect(message).toContain("--source");
		expect(message).toContain('"eco"');
	});

	test("a missing required schema flag says so", async () => {
		expect(await usageError(parseTaskArgs(task, []))).toContain("requires --id");
	});

	test("defaults for non-target tasks come from the schema; required stays undefined", async () => {
		expect(await applyDefaults(task)).toEqual({
			source: "all",
			runs: 1,
			count: undefined,
			id: undefined,
			dry: false,
			tags: undefined,
		});
	});
});

describe("ArgSpec choices and positional values", () => {
	const task = makeTask({
		args: {
			svc: {
				type: "string",
				choices: [
					"api",
					"web",
				],
				required: true,
			},
			to: {
				type: "string",
			},
			follow: {
				type: "boolean",
				short: "f",
			},
		},
		positional: [
			"svc",
			"to",
		],
	});

	test("bare words fill positional flags in order", async () => {
		expect(
			await parseTaskArgs(task, [
				"web",
				"accepted",
				"-f",
			]),
		).toEqual({
			svc: "web",
			to: "accepted",
			follow: true,
		});
	});

	test("choices are enforced", async () => {
		expect(
			await usageError(
				parseTaskArgs(task, [
					"db",
				]),
			),
		).toContain("Expected one of: api, web");
	});

	test("extra bare words are rejected", async () => {
		expect(
			await usageError(
				parseTaskArgs(task, [
					"api",
					"x",
					"y",
				]),
			),
		).toContain('unexpected argument "y"');
	});

	test("a flag given twice (bare and named) is ambiguous", async () => {
		expect(
			await usageError(
				parseTaskArgs(task, [
					"api",
					"--svc",
					"web",
				]),
			),
		).toContain("both as a flag and as a bare word");
	});

	test("usage and help show positional values", () => {
		expect(usageLine(task)).toBe("outdo t <svc> [to] [flags] [-- args]");
		expect(renderTaskHelp(task)).toContain("api | web");
	});

	test("a task without positionals rejects bare words", async () => {
		const plain = makeTask({
			args: {
				x: {
					type: "string",
				},
			},
		});
		expect(
			await usageError(
				parseTaskArgs(plain, [
					"oops",
				]),
			),
		).toContain("Unexpected argument 'oops'");
	});
});

describe("config validation of the new fields", () => {
	test("positional must name a declared, non-boolean flag", () => {
		expect(() =>
			makeTask({
				positional: [
					"nope",
				],
			}),
		).toThrow(OutdoError);
		expect(() =>
			makeTask({
				args: {
					b: {
						type: "boolean",
					},
				},
				positional: [
					"b",
				],
			}),
		).toThrow(OutdoError);
	});

	test("unknown fields are rejected", () => {
		expect(() =>
			makeTask({
				bogus: true,
			}),
		).toThrow('unknown field "bogus"');
	});

	test("commands normalize to a list and default the description", () => {
		const one = normalizeEntry("fix", "bunx biome check", {
			configPath: "do.ts",
			baseDir: process.cwd(),
			kind: "task",
		});
		expect(one.command).toEqual([
			"bunx biome check",
		]);
		expect(one.desc).toBe("bunx biome check");
		const many = normalizeEntry(
			"sync",
			[
				"a",
				"b",
			],
			{
				configPath: "do.ts",
				baseDir: process.cwd(),
				kind: "task",
			},
		);
		expect(many.command).toEqual([
			"a",
			"b",
		]);
	});

	test("protect normalizes to a mode list", () => {
		expect(
			makeTask({
				protect: true,
			}).protect,
		).toEqual([
			"*",
		]);
		expect(
			makeTask({
				protect: "prod",
			}).protect,
		).toEqual([
			"prod",
		]);
	});
});
