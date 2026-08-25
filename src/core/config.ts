/** Locate, import, and normalize the do.ts task file. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BundoError } from "~/core/errors";
import type { Project, Task } from "~/core/model";
import { didYouMean } from "~/core/util";
import { isTasks } from "~/index";
import type { ArgSpec, StandardSchemaV1, TaskCtx } from "~/types";

export const CONFIG_FILENAME = "do.ts";

/**
 * Walk upward from `startDir` looking for do.ts. Stops at the filesystem root
 * or after passing a package.json with a `workspaces` field (the repo root).
 */
export function findConfig(startDir: string): string | undefined {
	let dir = resolve(startDir);
	for (;;) {
		const candidate = join(dir, CONFIG_FILENAME);
		if (existsSync(candidate)) {
			return candidate;
		}
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
				if (pkg && typeof pkg === "object" && "workspaces" in pkg) {
					return undefined; // workspace root without do.ts — stop here
				}
			} catch {
				// unreadable package.json — keep walking
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

interface RawEntry {
	desc?: unknown;
	group?: unknown;
	deps?: unknown;
	env?: unknown;
	args?: unknown;
	inputs?: unknown;
	outputs?: unknown;
	watch?: unknown;
	persistent?: unknown;
	cwd?: unknown;
	run?: unknown;
	"~built"?: unknown;
}

function toStringArray(value: unknown, task: string, field: string): readonly string[] {
	if (value === undefined) {
		return [];
	}
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
		return value as string[];
	}
	throw new BundoError("config-invalid", `Task "${task}": "${field}" must be an array of strings.`);
}

/** Import a do.ts and normalize its default export into the internal model. */
export async function loadProject(configPath: string): Promise<Project> {
	const absPath = resolve(configPath);
	let mod: Record<string, unknown>;
	try {
		mod = (await import(pathToFileURL(absPath).href)) as Record<string, unknown>;
	} catch (error) {
		if (error instanceof BundoError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new BundoError("config-invalid", `Failed to load ${absPath}:\n${message}`);
	}
	const exported = mod.default;
	if (!isTasks(exported)) {
		throw new BundoError("config-invalid", `${absPath} must default-export defineTasks({ ... }) from "bundo".`);
	}

	const rootDir = dirname(absPath);
	const tasks = new Map<string, Task>();
	for (const [name, raw] of Object.entries(exported as Record<string, RawEntry>)) {
		if (typeof raw !== "object" || raw === null) {
			throw new BundoError("config-invalid", `Task "${name}" must be an object.`);
		}
		const entry = raw as RawEntry;
		const cwd = typeof entry.cwd === "string" ? entry.cwd : ".";
		tasks.set(name, {
			name,
			desc: typeof entry.desc === "string" ? entry.desc : undefined,
			group: typeof entry.group === "string" ? entry.group : undefined,
			deps: toStringArray(entry.deps, name, "deps"),
			env: isStandardSchema(entry.env) ? entry.env : undefined,
			args: normalizeArgs(entry.args, name),
			inputs: toStringArray(entry.inputs, name, "inputs"),
			outputs: toStringArray(entry.outputs, name, "outputs"),
			watch: toStringArray(entry.watch, name, "watch"),
			persistent: entry.persistent === true,
			cwd: isAbsolute(cwd) ? cwd : resolve(rootDir, cwd),
			run: typeof entry.run === "function" ? (entry.run as (ctx: TaskCtx<unknown, unknown>) => unknown) : undefined,
			built: entry["~built"] === true,
			sourceConfig: absPath,
			localName: name,
		});
	}

	validate(tasks, absPath);
	return {
		configPath: absPath,
		rootDir,
		tasks,
	};
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
	return (
		typeof value === "object"
		&& value !== null
		&& "~standard" in value
		&& typeof (value as StandardSchemaV1)["~standard"]?.validate === "function"
	);
}

function normalizeArgs(value: unknown, task: string): Readonly<Record<string, ArgSpec>> {
	if (value === undefined) {
		return {};
	}
	if (typeof value !== "object" || value === null) {
		throw new BundoError("config-invalid", `Task "${task}": "args" must be a record of flag specs.`);
	}
	const out: Record<string, ArgSpec> = {};
	for (const [flag, spec] of Object.entries(value as Record<string, unknown>)) {
		if (typeof spec !== "object" || spec === null || !("type" in spec)) {
			throw new BundoError(
				"config-invalid",
				`Task "${task}": arg "${flag}" must be { type: "string" | "boolean", ... }.`,
			);
		}
		const s = spec as ArgSpec;
		if (s.type !== "string" && s.type !== "boolean") {
			throw new BundoError("config-invalid", `Task "${task}": arg "${flag}" has invalid type "${String(s.type)}".`);
		}
		if (s.short !== undefined && s.short.length !== 1) {
			throw new BundoError("config-invalid", `Task "${task}": arg "${flag}" short alias must be a single character.`);
		}
		out[flag] = s;
	}
	return out;
}

function validate(tasks: ReadonlyMap<string, Task>, configPath: string): void {
	const names = [
		...tasks.keys(),
	];
	for (const task of tasks.values()) {
		for (const dep of task.deps) {
			if (!tasks.has(dep)) {
				const hint = didYouMean(dep, names);
				throw new BundoError(
					"config-invalid",
					`Task "${task.name}" depends on unknown task "${dep}".${hint ? ` Did you mean "${hint}"?` : ""}`,
					{
						task: task.name,
						dep,
						configPath,
					},
				);
			}
		}
		const shorts = new Map<string, string>();
		for (const [flag, spec] of Object.entries(task.args)) {
			if (spec.short !== undefined) {
				const existing = shorts.get(spec.short);
				if (existing !== undefined) {
					throw new BundoError(
						"config-invalid",
						`Task "${task.name}": flags "${existing}" and "${flag}" share the short alias "-${spec.short}".`,
					);
				}
				shorts.set(spec.short, flag);
			}
		}
		if (task.persistent && task.outputs.length > 0) {
			// A service never "completes", so outputs can never be fingerprinted.
			throw new BundoError("config-invalid", `Task "${task.name}" is persistent and cannot declare "outputs".`);
		}
	}
}
