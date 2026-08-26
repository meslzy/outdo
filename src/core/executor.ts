/** Task context construction and the in-process execution backend. */

import { $ } from "bun";
import { OutdoError } from "~/core/errors";
import { dim, prefixColor, red, yellow } from "~/core/logger";
import type { Task } from "~/core/model";
import type { TaskCtx, TaskLogger } from "~/types";

export interface CtxInputs {
	/** Validated schema output, or the raw merged env when no schema exists. */
	env: unknown;
	/** Full merged env map applied to spawned shells. */
	shellEnv: Record<string, string | undefined>;
	args: Record<string, string | boolean | undefined>;
	rest: string[];
	signal: AbortSignal;
	/** Data outputs of the task's dependencies (their run() return values). */
	depsData: Readonly<Record<string, unknown>>;
}

/** A Bun Shell facade bound to the task's cwd and resolved env. */
export function makeTaskShell(cwd: string, env: Record<string, string | undefined>): typeof $ {
	const cleanEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) {
			cleanEnv[key] = value;
		}
	}
	const wrapper = ((strings: TemplateStringsArray, ...exprs: unknown[]) =>
		($ as unknown as (s: TemplateStringsArray, ...e: unknown[]) => ReturnType<typeof $>)(strings, ...exprs)
			.cwd(cwd)
			.env(cleanEnv)) as typeof $;
	for (const key of Object.getOwnPropertyNames($)) {
		if (!(key in wrapper)) {
			try {
				(wrapper as unknown as Record<string, unknown>)[key] = ($ as unknown as Record<string, unknown>)[key];
			} catch {
				// non-writable static — ignore
			}
		}
	}
	return wrapper;
}

export function makeTaskLogger(name: string): TaskLogger {
	const color = prefixColor(name);
	const prefix = color(`[${name}]`);
	return {
		info: (...args) => console.error(prefix, ...args),
		warn: (...args) => console.error(prefix, yellow("warn"), ...args),
		error: (...args) => console.error(prefix, red("error"), ...args),
		debug: (...args) => {
			if (process.env.OUTDO_LOG === "debug") {
				console.error(prefix, dim("debug"), ...args);
			}
		},
	};
}

export function buildCtx(task: Task, inputs: CtxInputs): TaskCtx<unknown, unknown, Readonly<Record<string, unknown>>> {
	return {
		$: makeTaskShell(task.cwd, inputs.shellEnv),
		env: inputs.env,
		args: inputs.args,
		deps: inputs.depsData,
		rest: inputs.rest,
		signal: inputs.signal,
		log: makeTaskLogger(task.name),
		cwd: task.cwd,
		name: task.name,
	};
}

/**
 * Normalize a run() return value into the task's data output. JSON-only,
 * uniformly across backends: an in-process value must behave exactly like one
 * that crossed IPC or was replayed from the cache manifest.
 */
export function normalizeOutput(task: Task, value: unknown): unknown {
	if (value === undefined) {
		return undefined;
	}
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new OutdoError("task-failed", `Task "${task.name}" returned a non-JSON-serializable output: ${message}`, {
			task: task.name,
		});
	}
	// Functions and symbols stringify to undefined — treat as "no output".
	return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

/**
 * Run one task in this process. Returns the task's JSON-normalized data
 * output. Throws OutdoError("task-failed") on failure.
 */
export async function runTaskInProcess(
	task: Task,
	ctx: TaskCtx<unknown, unknown, Readonly<Record<string, unknown>>>,
): Promise<unknown> {
	if (task.run === undefined) {
		return undefined; // aggregation-only task
	}
	let value: unknown;
	try {
		value = await task.run(ctx);
	} catch (error) {
		if (error instanceof OutdoError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new OutdoError("task-failed", `Task "${task.name}" failed: ${message}`, {
			task: task.name,
			cause: message,
		});
	}
	return normalizeOutput(task, value);
}
