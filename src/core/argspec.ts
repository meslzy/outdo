/**
 * Per-task flags: normalization (ArgSpec records and Standard Schemas -> ArgDef),
 * parsing (parseArgs + positionals + schema validation), and task help.
 */

import { parseArgs } from "node:util";
import { OutdoError } from "~/core/errors";
import { bold, cyan, dim } from "~/core/logger";
import type { ArgDef, ArgValues, Task } from "~/core/model";
import { didYouMean } from "~/core/util";
import type { ArgSpec, StandardSchemaV1 } from "~/types";

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
	return (
		typeof value === "object"
		&& value !== null
		&& "~standard" in value
		&& typeof (value as StandardSchemaV1)["~standard"]?.validate === "function"
	);
}

/** A schema's JSON Schema (input side), via Standard JSON Schema when the library offers it. */
export function jsonSchemaOf(schema: StandardSchemaV1): Record<string, unknown> | undefined {
	const props = schema["~standard"] as {
		jsonSchema?: {
			input?: (options: { target: string }) => unknown;
		};
	};
	try {
		const out = props.jsonSchema?.input?.({
			target: "draft-2020-12",
		});
		if (typeof out === "object" && out !== null) {
			const { $schema: _drop, ...rest } = out as Record<string, unknown>;
			return rest;
		}
	} catch {
		// transforms etc. have no JSON Schema — fall back to string handling
	}
	return undefined;
}

function jsonTypes(js: Record<string, unknown>): string[] {
	const out: string[] = [];
	const visit = (node: unknown): void => {
		if (typeof node !== "object" || node === null) {
			return;
		}
		const record = node as Record<string, unknown>;
		const type = record.type;
		if (typeof type === "string") {
			out.push(type);
		} else if (Array.isArray(type)) {
			out.push(...type.filter((t): t is string => typeof t === "string"));
		}
		for (const key of [
			"anyOf",
			"oneOf",
		]) {
			const list = record[key];
			if (Array.isArray(list)) {
				for (const item of list) {
					visit(item);
				}
			}
		}
	};
	visit(js);
	return out.filter((t) => t !== "null");
}

function jsonChoices(js: Record<string, unknown>): string[] | undefined {
	const values = Array.isArray(js.enum) ? js.enum : undefined;
	if (values !== undefined && values.length > 0 && values.every((v) => typeof v === "string")) {
		return values as string[];
	}
	for (const key of [
		"anyOf",
		"oneOf",
	]) {
		const list = js[key];
		if (Array.isArray(list) && list.length > 0) {
			const consts = list.map((item) => (item as Record<string, unknown> | null)?.const);
			if (consts.every((v) => typeof v === "string")) {
				return consts as string[];
			}
		}
	}
	return undefined;
}

function schemaArg(schema: StandardSchemaV1): ArgDef {
	const js = jsonSchemaOf(schema);
	const types = js === undefined ? [] : jsonTypes(js);
	const type: ArgDef["type"] = types.includes("boolean")
		? "boolean"
		: types.includes("array")
			? "array"
			: types.includes("number") || types.includes("integer")
				? "number"
				: "string";
	let required = false;
	if (js?.default === undefined) {
		try {
			const probe = schema["~standard"].validate(type === "boolean" ? false : undefined);
			required = !(probe instanceof Promise) && probe.issues !== undefined;
		} catch {
			required = true;
		}
	}
	const short = typeof js?.short === "string" && js.short.length === 1 ? js.short : undefined;
	return {
		type,
		short,
		description: typeof js?.description === "string" ? js.description : undefined,
		default: js?.default,
		required,
		choices: js === undefined ? undefined : jsonChoices(js),
		schema,
		jsonSchema: js,
	};
}

export function normalizeArgs(value: unknown, task: string): Record<string, ArgDef> {
	if (value === undefined) {
		return {};
	}
	if (typeof value !== "object" || value === null) {
		throw new OutdoError("config-invalid", `Task "${task}": "args" must be a record of flag specs or schemas.`);
	}
	const out: Record<string, ArgDef> = {};
	for (const [flag, spec] of Object.entries(value as Record<string, unknown>)) {
		if (isStandardSchema(spec)) {
			out[flag] = schemaArg(spec);
			continue;
		}
		if (typeof spec !== "object" || spec === null || !("type" in spec)) {
			throw new OutdoError(
				"config-invalid",
				`Task "${task}": arg "${flag}" must be { type: "string" | "boolean", ... } or a schema (zod, valibot, ...).`,
			);
		}
		const s = spec as ArgSpec;
		if (s.type !== "string" && s.type !== "boolean") {
			throw new OutdoError("config-invalid", `Task "${task}": arg "${flag}" has invalid type "${String(s.type)}".`);
		}
		if (s.short !== undefined && s.short.length !== 1) {
			throw new OutdoError("config-invalid", `Task "${task}": arg "${flag}" short alias must be a single character.`);
		}
		if (s.choices !== undefined && (!Array.isArray(s.choices) || !s.choices.every((c) => typeof c === "string"))) {
			throw new OutdoError("config-invalid", `Task "${task}": arg "${flag}" choices must be an array of strings.`);
		}
		out[flag] = {
			type: s.type,
			short: s.short,
			description: s.description,
			default: s.default,
			required: s.type === "string" && s.required === true,
			choices: s.choices,
			schema: undefined,
			jsonSchema: undefined,
		};
	}
	return out;
}

/** The value a flag takes when it is not given on the command line (before schema validation). */
function absentValue(def: ArgDef): unknown {
	if (def.schema === undefined) {
		return def.default ?? (def.type === "boolean" ? false : undefined);
	}
	// A bare schema boolean is simply off; a defaulted one keeps its default.
	return def.type === "boolean" && def.default === undefined ? false : undefined;
}

function coerce(def: ArgDef, raw: unknown): unknown {
	const toNumber = (v: unknown): unknown => {
		if (typeof v !== "string" || v.trim() === "") {
			return v;
		}
		const n = Number(v);
		return Number.isNaN(n) ? v : n;
	};
	if (def.type === "number") {
		return toNumber(raw);
	}
	if (def.type === "array" && Array.isArray(raw)) {
		const items = (def.jsonSchema?.items ?? {}) as Record<string, unknown>;
		const numeric = items.type === "number" || items.type === "integer";
		return numeric ? raw.map(toNumber) : raw;
	}
	return raw;
}

async function validateArg(task: Task, flag: string, def: ArgDef, value: unknown): Promise<unknown> {
	if (def.schema === undefined) {
		if (def.choices !== undefined && typeof value === "string" && !def.choices.includes(value)) {
			throw new OutdoError(
				"usage",
				`Task "${task.name}": invalid value "${value}" for --${flag}. Expected one of: ${def.choices.join(", ")}.`,
				{
					task: task.name,
					flag,
				},
			);
		}
		return value;
	}
	const result = await def.schema["~standard"].validate(value);
	if (result.issues === undefined) {
		return result.value;
	}
	const message = result.issues.map((issue) => issue.message).join("; ");
	throw new OutdoError(
		"usage",
		value === undefined
			? `Task "${task.name}" requires --${flag} (${message}). See "outdo ${task.name} --help".`
			: `Task "${task.name}": invalid value ${JSON.stringify(value)} for --${flag}: ${message}`,
		{
			task: task.name,
			flag,
			issues: result.issues.map((issue) => issue.message),
		},
	);
}

export async function parseTaskArgs(task: Task, argv: readonly string[]): Promise<ArgValues> {
	const options: Record<
		string,
		{
			type: "string" | "boolean";
			short?: string;
			multiple?: boolean;
		}
	> = {};
	for (const [flag, def] of Object.entries(task.args)) {
		options[flag] = {
			type: def.type === "boolean" ? "boolean" : "string",
			...(def.short !== undefined
				? {
						short: def.short,
					}
				: {}),
			...(def.type === "array"
				? {
						multiple: true,
					}
				: {}),
		};
	}

	let values: Record<string, unknown>;
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args: [
				...argv,
			],
			options: options as NonNullable<Parameters<typeof parseArgs>[0]>["options"],
			strict: true,
			allowPositionals: task.positional.length > 0,
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
		const unknown = /'--?([^']+)'/.exec(String(message))?.[1];
		let hint = "";
		if (unknown !== undefined) {
			const close = didYouMean(unknown.replace(/^-+/, ""), Object.keys(task.args));
			if (close !== undefined) {
				hint = ` Did you mean "--${close}"?`;
			} else {
				hint = ` Global flags go before the task name; see "outdo --help".`;
			}
		}
		throw new OutdoError("usage", `Task "${task.name}": ${message}${hint}`, {
			task: task.name,
		});
	}

	// Bare words fill the declared positional flags in order; an array flag in
	// last position swallows the rest. A flag given both ways is ambiguous.
	for (let i = 0; i < task.positional.length && positionals.length > 0; i++) {
		const flag = task.positional[i] as string;
		const def = task.args[flag] as ArgDef;
		const isLast = i === task.positional.length - 1;
		const taken = def.type === "array" && isLast ? positionals.splice(0) : positionals.splice(0, 1);
		if (values[flag] !== undefined && def.type !== "boolean") {
			throw new OutdoError("usage", `Task "${task.name}": --${flag} was given both as a flag and as a bare word.`, {
				task: task.name,
			});
		}
		values[flag] =
			def.type === "array"
				? [
						...((values[flag] as string[] | undefined) ?? []),
						...taken,
					]
				: taken[0];
	}
	if (positionals.length > 0) {
		throw new OutdoError(
			"usage",
			`Task "${task.name}": unexpected argument "${positionals[0]}". It takes ${task.positional.length === 0 ? "no bare words" : `at most ${task.positional.map((p) => `<${p}>`).join(" ")}`}.`,
			{
				task: task.name,
			},
		);
	}

	const out: ArgValues = {};
	const missing: string[] = [];
	for (const [flag, def] of Object.entries(task.args)) {
		const given = values[flag];
		if (given === undefined && def.schema === undefined && def.required) {
			missing.push(flag);
			continue;
		}
		const value = given === undefined ? absentValue(def) : coerce(def, given);
		out[flag] = await validateArg(task, flag, def, value);
	}
	if (missing.length > 0) {
		throw new OutdoError(
			"usage",
			`Task "${task.name}" requires ${missing.map((f) => `--${f}`).join(", ")}. See "outdo ${task.name} --help".`,
			{
				task: task.name,
				missing,
			},
		);
	}
	return out;
}

/**
 * Arg values for a task that was not given flags (a dependency, or a member of
 * a multi-task run): declared defaults, schema defaults. Required flags stay
 * undefined rather than failing — the task was not asked for directly.
 */
export async function applyDefaults(task: Task): Promise<ArgValues> {
	const out: ArgValues = {};
	for (const [flag, def] of Object.entries(task.args)) {
		const value = absentValue(def);
		if (def.schema === undefined) {
			out[flag] = value;
			continue;
		}
		const result = await def.schema["~standard"].validate(value);
		out[flag] = result.issues === undefined ? result.value : undefined;
	}
	return out;
}

/** True when the task itself does not claim -h/--help as a flag. */
export function wantsTaskHelp(task: Task, argv: readonly string[]): boolean {
	const claimsShortH = Object.values(task.args).some((def) => def.short === "h");
	const claimsHelp = "help" in task.args;
	return argv.some((token) => (token === "--help" && !claimsHelp) || (token === "-h" && !claimsShortH));
}

export function usageLine(task: Task): string {
	const positional = task.positional.map((flag) => {
		const def = task.args[flag];
		const name = def?.type === "array" ? `${flag}...` : flag;
		return def?.required === true ? `<${name}>` : `[${name}]`;
	});
	const hasFlags = Object.keys(task.args).some((flag) => !task.positional.includes(flag));
	return [
		`outdo ${task.name}`,
		...positional,
		...(hasFlags
			? [
					"[flags]",
				]
			: []),
		"[-- args]",
	].join(" ");
}

export function renderTaskHelp(task: Task): string {
	const lines: string[] = [];
	lines.push(`${bold(task.name)}${task.desc === undefined ? "" : ` — ${task.desc}`}`);
	lines.push("");
	lines.push(`Usage: ${usageLine(task)}`);
	if (task.steps.length > 0) {
		lines.push(`Steps: ${task.steps.join(" → ")} ${dim("(--from / --until pick a range)")}`);
	}
	const plainDeps = task.depEdges.filter((edge) => edge.step !== true).map((edge) => edge.task);
	if (plainDeps.length > 0) {
		lines.push(`Deps:  ${plainDeps.join(", ")}`);
	}
	if (task.command !== undefined) {
		lines.push(`Runs:  ${task.command.join(" && ")}`);
	} else if (task.script !== undefined) {
		lines.push(`Runs:  bun run ${task.script}`);
	}
	const entries = Object.entries(task.args);
	if (entries.length > 0) {
		lines.push("");
		lines.push("Flags");
		const width = Math.max(...entries.map(([flag]) => flag.length));
		for (const [flag, def] of entries) {
			const short = def.short === undefined ? "    " : `-${def.short}, `;
			const name = `--${flag.padEnd(width)}`;
			const meta: string[] = [];
			if (def.type !== "boolean") {
				meta.push(def.type === "array" ? "repeatable" : def.type);
			}
			if (def.choices !== undefined) {
				meta.push(def.choices.join(" | "));
			}
			if (def.required) {
				meta.push("required");
			}
			if (def.default !== undefined) {
				meta.push(`default: ${JSON.stringify(def.default)}`);
			}
			if (task.positional.includes(flag)) {
				meta.push("positional");
			}
			const suffix = meta.length > 0 ? ` ${dim(`(${meta.join(", ")})`)}` : "";
			lines.push(`  ${short}${cyan(name)}  ${def.description ?? ""}${suffix}`);
		}
	}
	const notes: string[] = [];
	if (task.protect.length > 0 || task.confirm !== undefined) {
		notes.push(
			task.confirm !== undefined
				? "asks before running (--yes skips)"
				: `asks before running in ${task.protect.includes("*") ? "every mode" : task.protect.join(", ")} (--yes skips)`,
		);
	}
	if (task.readonly) {
		notes.push("read-only");
	}
	if (task.destructive) {
		notes.push("destructive");
	}
	if (task.finally.length > 0) {
		notes.push(`always runs afterwards: ${task.finally.join(", ")}`);
	}
	if (notes.length > 0) {
		lines.push("");
		lines.push(dim(notes.join(" · ")));
	}
	if (task.env !== undefined) {
		lines.push("");
		lines.push(dim(`env: validated by schema — inspect with "outdo --print-env ${task.name}"`));
	}
	return lines.join("\n");
}
