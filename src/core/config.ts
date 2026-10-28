/** Locate, import, and normalize one do.ts task file. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isStandardSchema, normalizeArgs } from "~/core/argspec";
import { OutdoError } from "~/core/errors";
import type { DepEdge, HookSpec, Task } from "~/core/model";
import { workspacePatternsOf } from "~/core/workspaces";
import { isNamespace, isTasks, optionsOf } from "~/index";
import type { DefineOptions, ReadyProbe, Requires, RetrySpec, TaskCtx } from "~/types";

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
	steps?: unknown;
	finally?: unknown;
	positional?: unknown;
	envFiles?: unknown;
	protect?: unknown;
	confirm?: unknown;
	requires?: unknown;
	readonly?: unknown;
	destructive?: unknown;
	restage?: unknown;
}

const KNOWN_KEYS = new Set([
	"desc",
	"group",
	"deps",
	"env",
	"args",
	"inputs",
	"outputs",
	"watch",
	"persistent",
	"cwd",
	"run",
	"ready",
	"retry",
	"timeoutMs",
	"steps",
	"finally",
	"positional",
	"envFiles",
	"protect",
	"confirm",
	"requires",
	"readonly",
	"destructive",
]);

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
	if (probe.url !== undefined && !isHttpUrl(probe.url)) {
		throw new OutdoError("config-invalid", `Task "${task}": "ready.url" must be a valid http(s) URL.`);
	}
	if (probe.port !== undefined && !isPort(probe.port)) {
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

function isHttpUrl(value: unknown): boolean {
	if (typeof value !== "string") {
		return false;
	}
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isPort(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
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

function toCommand(value: unknown, task: string): readonly string[] | undefined {
	if (typeof value === "string") {
		return [
			value,
		];
	}
	if (Array.isArray(value)) {
		if (value.length === 0 || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
			throw new OutdoError("config-invalid", `Task "${task}": a command list must be non-empty strings.`);
		}
		return value as string[];
	}
	return undefined;
}

function toProtect(value: unknown, task: string): readonly string[] {
	if (value === undefined || value === false) {
		return [];
	}
	if (value === true) {
		return [
			"*",
		];
	}
	if (typeof value === "string") {
		return [
			value,
		];
	}
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
		return value as string[];
	}
	throw new OutdoError("config-invalid", `Task "${task}": "protect" must be true, a mode, or a list of modes.`);
}

function toRequires(value: unknown, task: string): Requires | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "object" || value === null) {
		throw new OutdoError(
			"config-invalid",
			`Task "${task}": "requires" must be { bin?, env?, file?, url?, port?, hint? }.`,
		);
	}
	const req = value as Requires;
	for (const field of [
		"bin",
		"env",
		"file",
	] as const) {
		toStringArray(req[field], task, `requires.${field}`);
	}
	if (req.url !== undefined && !isHttpUrl(req.url)) {
		throw new OutdoError("config-invalid", `Task "${task}": "requires.url" must be a valid http(s) URL.`);
	}
	if (req.port !== undefined && !isPort(req.port)) {
		throw new OutdoError("config-invalid", `Task "${task}": "requires.port" must be an integer between 1 and 65535.`);
	}
	return req;
}

export interface FileTaskContext {
	/** Absolute config file the task came from. */
	configPath: string;
	/** Directory relative paths resolve against. */
	baseDir: string;
	kind: Task["kind"];
}

/** Normalize one raw entry (command string/list or task object) into the internal model. */
export function normalizeEntry(name: string, raw: unknown, ctx: FileTaskContext): Task {
	const command = toCommand(raw, name);
	const entry: RawEntry =
		command !== undefined
			? {}
			: typeof raw === "object" && raw !== null && !Array.isArray(raw)
				? (raw as RawEntry)
				: invalidEntry(name);
	if (command === undefined) {
		for (const key of Object.keys(entry)) {
			if (!KNOWN_KEYS.has(key) && !(ctx.kind === "hook" && key === "restage")) {
				throw new OutdoError("config-invalid", `Task "${name}": unknown field "${key}".`);
			}
		}
	}
	const cwd = typeof entry.cwd === "string" ? entry.cwd : ".";
	const runCommand = command ?? toCommand(entry.run, name);
	const task: Task = {
		name,
		desc: typeof entry.desc === "string" ? entry.desc : command !== undefined ? command.join(" && ") : undefined,
		group: typeof entry.group === "string" ? entry.group : undefined,
		kind: ctx.kind,
		deps: [],
		depEdges: toDepEdges(entry.deps, name),
		after: [],
		steps: toStringArray(entry.steps, name, "steps"),
		finally: toStringArray(entry.finally, name, "finally"),
		env: isStandardSchema(entry.env) ? entry.env : undefined,
		args: normalizeArgs(entry.args, name),
		positional: toStringArray(entry.positional, name, "positional"),
		inputs: toStringArray(entry.inputs, name, "inputs"),
		outputs: toStringArray(entry.outputs, name, "outputs"),
		watch: toStringArray(entry.watch, name, "watch"),
		persistent: entry.persistent === true,
		ready: toReady(entry.ready, name),
		retry: toRetry(entry.retry, name),
		timeoutMs: toTimeout(entry.timeoutMs, name),
		cwd: isAbsolute(cwd) ? cwd : resolve(ctx.baseDir, cwd),
		run:
			typeof entry.run === "function"
				? (entry.run as (ctx: TaskCtx<unknown, unknown, Readonly<Record<string, unknown>>>) => unknown)
				: undefined,
		command: runCommand,
		script: undefined,
		envFiles: toStringArray(entry.envFiles, name, "envFiles").map((file) => resolve(ctx.baseDir, file)),
		protect: toProtect(entry.protect, name),
		confirm: typeof entry.confirm === "string" ? entry.confirm : undefined,
		requires: toRequires(entry.requires, name),
		readonly: entry.readonly === true,
		destructive: entry.destructive === true,
		sourceConfig: ctx.configPath,
		localName: name,
	};
	if (entry.run !== undefined && typeof entry.run !== "function" && runCommand === undefined) {
		throw new OutdoError(
			"config-invalid",
			`Task "${name}": "run" must be a function, a command, or a list of commands.`,
		);
	}
	if (entry.env !== undefined && task.env === undefined) {
		throw new OutdoError("config-invalid", `Task "${name}": "env" must be a Standard Schema (zod, valibot, ...).`);
	}
	validateTask(task);
	return task;
}

function invalidEntry(name: string): never {
	throw new OutdoError(
		"config-invalid",
		`Task "${name}" must be a command string, a list of commands, a task object, or ns({ ... }).`,
	);
}

/** Per-task invariants (cross-task checks happen once the whole project is assembled). */
function validateTask(task: Task): void {
	const shorts = new Map<string, string>();
	for (const [flag, def] of Object.entries(task.args)) {
		if (def.short !== undefined) {
			const existing = shorts.get(def.short);
			if (existing !== undefined) {
				throw new OutdoError(
					"config-invalid",
					`Task "${task.name}": flags "${existing}" and "${flag}" share the short alias "-${def.short}".`,
				);
			}
			shorts.set(def.short, flag);
		}
	}
	for (const [i, flag] of task.positional.entries()) {
		const def = task.args[flag];
		if (def === undefined) {
			throw new OutdoError("config-invalid", `Task "${task.name}": positional "${flag}" is not one of its args.`);
		}
		if (def.type === "boolean") {
			throw new OutdoError("config-invalid", `Task "${task.name}": positional "${flag}" cannot be a boolean flag.`);
		}
		if (def.type === "array" && i !== task.positional.length - 1) {
			throw new OutdoError("config-invalid", `Task "${task.name}": only the last positional may take several values.`);
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
	if (task.steps.length > 0 && task.persistent) {
		throw new OutdoError("config-invalid", `Task "${task.name}" is persistent and cannot declare "steps".`);
	}
}

export interface LoadedFile {
	configPath: string;
	/** Directory containing the file. */
	dir: string;
	/** Tasks by local (flattened) name. Dep/step names are not validated yet. */
	tasks: Map<string, Task>;
	options: DefineOptions | undefined;
	hooks: Map<string, HookSpec>;
}

/** Resolve a name used inside namespace `prefix`: a sibling wins over a top-level task. */
function inNamespace(ref: string, prefix: string | undefined, names: ReadonlySet<string>): string {
	if (prefix === undefined || ref.startsWith("^") || ref.includes("#")) {
		return ref;
	}
	const sibling = `${prefix}:${ref}`;
	return names.has(sibling) ? sibling : ref;
}

/** Import a do.ts and normalize its default export. */
export async function loadConfigFile(configPath: string): Promise<LoadedFile> {
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

	const dir = dirname(absPath);
	const fileCtx: FileTaskContext = {
		configPath: absPath,
		baseDir: dir,
		kind: "task",
	};
	const tasks = new Map<string, Task>();
	const prefixes = new Map<string, string>();
	for (const [name, raw] of Object.entries(exported as Record<string, unknown>)) {
		if (isNamespace(raw)) {
			for (const [local, inner] of Object.entries(raw["~ns"])) {
				if (isNamespace(inner)) {
					throw new OutdoError("config-invalid", `Namespace "${name}": namespaces cannot be nested ("${local}").`);
				}
				const full = `${name}:${local}`;
				const task = normalizeEntry(full, inner, fileCtx);
				task.group ??= name;
				tasks.set(full, task);
				prefixes.set(full, name);
			}
			continue;
		}
		tasks.set(name, normalizeEntry(name, raw, fileCtx));
	}

	const options = optionsOf(exported);
	const hooks = new Map<string, HookSpec>();
	for (const [hook, raw] of Object.entries(options?.hooks ?? {})) {
		if (raw === undefined) {
			continue;
		}
		const name = `hooks:${hook}`;
		const task = normalizeEntry(name, raw, {
			...fileCtx,
			kind: "hook",
		});
		task.desc ??= `git ${hook} hook`;
		tasks.set(name, task);
		hooks.set(hook, {
			task: name,
			restage: typeof raw === "object" && raw !== null && (raw as RawEntry).restage === true,
		});
	}

	// Namespace-local names resolve to siblings now; everything else is
	// validated once scripts and workspace members are merged in.
	const names = new Set(tasks.keys());
	for (const [name, task] of tasks) {
		const prefix = prefixes.get(name);
		if (prefix === undefined) {
			continue;
		}
		task.depEdges = task.depEdges.map((edge) => ({
			...edge,
			task: inNamespace(edge.task, prefix, names),
		}));
		task.steps = task.steps.map((step) => inNamespace(step, prefix, names));
		task.finally = task.finally.map((step) => inNamespace(step, prefix, names));
	}

	return {
		configPath: absPath,
		dir,
		tasks,
		options,
		hooks,
	};
}

/** Every step becomes a dep edge (so the steps run as part of the task); order is applied per run. */
export function withStepEdges(task: Task): void {
	const declared = task.depEdges.filter((edge) => edge.step !== true);
	const stepEdges: DepEdge[] = task.steps.map((step) => ({
		task: step,
		optional: false,
		condition: undefined,
		step: true,
	}));
	task.depEdges = [
		...declared,
		...stepEdges,
	];
	task.deps = [
		...new Set(task.depEdges.map((edge) => edge.task)),
	];
}
