/** Locate, import, and normalize the do.ts task file. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OutdoError } from "~/core/errors";
import type { DepEdge, Project, Task } from "~/core/model";
import { didYouMean } from "~/core/util";
import { workspacePatternsOf } from "~/core/workspaces";
import { isTasks } from "~/index";
import type { ArgSpec, ReadyProbe, RetrySpec, StandardSchemaV1, TaskCtx } from "~/types";

/** setTimeout clamps larger values to ~1ms — a "30 day" timeout firing instantly. */
const MAX_TIMER_MS = 2_147_483_647;

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
				// Must agree with findWorkspaceRoot — a malformed `workspaces` key
				// (empty object, string, null) is not a workspace root and must not
				// stop the walk before an ancestor do.ts.
				if (workspacePatternsOf(pkg) !== undefined) {
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
	ready?: unknown;
	retry?: unknown;
	timeoutMs?: unknown;
}

function toStringArray(value: unknown, task: string, field: string): readonly string[] {
	if (value === undefined) {
		return [];
	}
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
		return value as string[];
	}
	throw new OutdoError("config-invalid", `Task "${task}": "${field}" must be an array of strings.`);
}

function toDepEdges(value: unknown, task: string): DepEdge[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new OutdoError("config-invalid", `Task "${task}": "deps" must be an array.`);
	}
	const edges: DepEdge[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			edges.push({
				task: entry,
				optional: false,
				condition: undefined,
			});
			continue;
		}
		if (typeof entry === "object" && entry !== null && typeof (entry as DepEdge).task === "string") {
			const ref = entry as {
				task: string;
				if?: unknown;
				optional?: unknown;
			};
			const cond = ref.if;
			if (cond !== undefined && typeof cond !== "string" && typeof cond !== "function") {
				throw new OutdoError(
					"config-invalid",
					`Task "${task}": dep "${ref.task}" has an invalid "if" — expected an env var name or a predicate.`,
				);
			}
			edges.push({
				task: ref.task,
				optional: ref.optional === true,
				condition: cond as DepEdge["condition"],
			});
			continue;
		}
		throw new OutdoError(
			"config-invalid",
			`Task "${task}": deps entries must be task names or { task, if?, optional? }.`,
		);
	}
	return edges;
}

function toReady(value: unknown, task: string): ReadyProbe | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "object" || value === null) {
		throw new OutdoError("config-invalid", `Task "${task}": "ready" must be { log | url | port, host?, timeoutMs? }.`);
	}
	const probe = value as ReadyProbe;
	const kinds = [
		probe.log !== undefined,
		probe.url !== undefined,
		probe.port !== undefined,
	].filter(Boolean).length;
	if (kinds !== 1) {
		throw new OutdoError("config-invalid", `Task "${task}": "ready" must set exactly one of "log", "url", "port".`);
	}
	if (probe.log !== undefined && (typeof probe.log !== "string" || probe.log === "")) {
		throw new OutdoError("config-invalid", `Task "${task}": "ready.log" must be a non-empty string.`);
	}
	if (probe.url !== undefined) {
		let parsed: URL | undefined;
		try {
			parsed = new URL(probe.url);
		} catch {
			// handled below
		}
		if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
			throw new OutdoError("config-invalid", `Task "${task}": "ready.url" must be a valid http(s) URL.`);
		}
	}
	if (probe.port !== undefined && (!Number.isInteger(probe.port) || probe.port < 1 || probe.port > 65_535)) {
		throw new OutdoError("config-invalid", `Task "${task}": "ready.port" must be an integer between 1 and 65535.`);
	}
	if (probe.host !== undefined && probe.port === undefined) {
		throw new OutdoError("config-invalid", `Task "${task}": "ready.host" is only valid with "ready.port".`);
	}
	if (
		probe.timeoutMs !== undefined
		&& (!Number.isFinite(probe.timeoutMs) || probe.timeoutMs <= 0 || probe.timeoutMs > MAX_TIMER_MS)
	) {
		throw new OutdoError(
			"config-invalid",
			`Task "${task}": "ready.timeoutMs" must be a positive number of ms (at most ${MAX_TIMER_MS}).`,
		);
	}
	return probe;
}

function toRetry(value: unknown, task: string): Required<RetrySpec> | undefined {
	if (value === undefined) {
		return undefined;
	}
	const spec: RetrySpec | undefined =
		typeof value === "number"
			? {
					attempts: value,
				}
			: typeof value === "object" && value !== null
				? (value as RetrySpec)
				: undefined;
	if (spec === undefined) {
		throw new OutdoError(
			"config-invalid",
			`Task "${task}": "retry" must be a number or { attempts, delayMs?, backoff? }.`,
		);
	}
	if (!Number.isInteger(spec.attempts) || spec.attempts < 1) {
		throw new OutdoError("config-invalid", `Task "${task}": "retry.attempts" must be an integer >= 1.`);
	}
	if (
		spec.delayMs !== undefined
		&& (!Number.isFinite(spec.delayMs) || spec.delayMs < 0 || spec.delayMs > MAX_TIMER_MS)
	) {
		throw new OutdoError(
			"config-invalid",
			`Task "${task}": "retry.delayMs" must be a non-negative number of ms (at most ${MAX_TIMER_MS}).`,
		);
	}
	if (spec.backoff !== undefined && spec.backoff !== "fixed" && spec.backoff !== "exponential") {
		throw new OutdoError("config-invalid", `Task "${task}": "retry.backoff" must be "fixed" or "exponential".`);
	}
	return {
		attempts: spec.attempts,
		delayMs: spec.delayMs ?? 0,
		backoff: spec.backoff ?? "fixed",
	};
}

function toTimeout(value: unknown, task: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
		throw new OutdoError(
			"config-invalid",
			`Task "${task}": "timeoutMs" must be a positive number of ms (at most ${MAX_TIMER_MS}).`,
		);
	}
	return value;
}

/** Import a do.ts and normalize its default export into the internal model. */
export async function loadProject(configPath: string): Promise<Project> {
	const absPath = resolve(configPath);
	let mod: Record<string, unknown>;
	try {
		mod = (await import(pathToFileURL(absPath).href)) as Record<string, unknown>;
	} catch (error) {
		if (error instanceof OutdoError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new OutdoError("config-invalid", `Failed to load ${absPath}:\n${message}`);
	}
	const exported = mod.default;
	if (!isTasks(exported)) {
		throw new OutdoError("config-invalid", `${absPath} must default-export defineTasks({ ... }) from "@meslzy/outdo".`);
	}

	const rootDir = dirname(absPath);
	const tasks = new Map<string, Task>();
	for (const [name, raw] of Object.entries(exported as Record<string, RawEntry>)) {
		if (typeof raw !== "object" || raw === null) {
			throw new OutdoError("config-invalid", `Task "${name}" must be an object.`);
		}
		const entry = raw as RawEntry;
		const cwd = typeof entry.cwd === "string" ? entry.cwd : ".";
		const depEdges = toDepEdges(entry.deps, name);
		tasks.set(name, {
			name,
			desc: typeof entry.desc === "string" ? entry.desc : undefined,
			group: typeof entry.group === "string" ? entry.group : undefined,
			deps: depEdges.map((edge) => edge.task),
			depEdges,
			env: isStandardSchema(entry.env) ? entry.env : undefined,
			args: normalizeArgs(entry.args, name),
			inputs: toStringArray(entry.inputs, name, "inputs"),
			outputs: toStringArray(entry.outputs, name, "outputs"),
			watch: toStringArray(entry.watch, name, "watch"),
			persistent: entry.persistent === true,
			ready: toReady(entry.ready, name),
			retry: toRetry(entry.retry, name),
			timeoutMs: toTimeout(entry.timeoutMs, name),
			cwd: isAbsolute(cwd) ? cwd : resolve(rootDir, cwd),
			run:
				typeof entry.run === "function"
					? (entry.run as (ctx: TaskCtx<unknown, unknown, Readonly<Record<string, unknown>>>) => unknown)
					: undefined,
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
		throw new OutdoError("config-invalid", `Task "${task}": "args" must be a record of flag specs.`);
	}
	const out: Record<string, ArgSpec> = {};
	for (const [flag, spec] of Object.entries(value as Record<string, unknown>)) {
		if (typeof spec !== "object" || spec === null || !("type" in spec)) {
			throw new OutdoError(
				"config-invalid",
				`Task "${task}": arg "${flag}" must be { type: "string" | "boolean", ... }.`,
			);
		}
		const s = spec as ArgSpec;
		if (s.type !== "string" && s.type !== "boolean") {
			throw new OutdoError("config-invalid", `Task "${task}": arg "${flag}" has invalid type "${String(s.type)}".`);
		}
		if (s.short !== undefined && s.short.length !== 1) {
			throw new OutdoError("config-invalid", `Task "${task}": arg "${flag}" short alias must be a single character.`);
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
		// Optional edges to absent tasks are dropped; required ones must resolve.
		const resolved: DepEdge[] = [];
		for (const edge of task.depEdges) {
			if (tasks.has(edge.task)) {
				resolved.push(edge);
				continue;
			}
			if (edge.optional) {
				continue;
			}
			const hint = didYouMean(edge.task, names);
			throw new OutdoError(
				"config-invalid",
				`Task "${task.name}" depends on unknown task "${edge.task}".${hint ? ` Did you mean "${hint}"?` : ""}`,
				{
					task: task.name,
					dep: edge.task,
					configPath,
				},
			);
		}
		if (resolved.length !== task.depEdges.length) {
			task.depEdges = resolved;
			task.deps = resolved.map((edge) => edge.task);
		}
		const shorts = new Map<string, string>();
		for (const [flag, spec] of Object.entries(task.args)) {
			if (spec.short !== undefined) {
				const existing = shorts.get(spec.short);
				if (existing !== undefined) {
					throw new OutdoError(
						"config-invalid",
						`Task "${task.name}": flags "${existing}" and "${flag}" share the short alias "-${spec.short}".`,
					);
				}
				shorts.set(spec.short, flag);
			}
		}
		if (task.persistent && task.outputs.length > 0) {
			// A service never "completes", so outputs can never be fingerprinted.
			throw new OutdoError("config-invalid", `Task "${task.name}" is persistent and cannot declare "outputs".`);
		}
		if (task.ready !== undefined && !task.persistent) {
			throw new OutdoError("config-invalid", `Task "${task.name}": "ready" requires "persistent: true".`);
		}
		if (task.retry !== undefined && task.persistent) {
			throw new OutdoError(
				"config-invalid",
				`Task "${task.name}" is persistent and cannot declare "retry" (services restart via watch mode).`,
			);
		}
		if (task.timeoutMs !== undefined && task.persistent) {
			throw new OutdoError("config-invalid", `Task "${task.name}" is persistent and cannot declare "timeoutMs".`);
		}
	}
}
