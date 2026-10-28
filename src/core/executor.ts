/** Task context construction and the in-process execution backend. */

import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { $ } from "bun";
import { OutdoError } from "~/core/errors";
import { dim, prefixColor, red, yellow } from "~/core/logger";
import type { ArgValues, Task } from "~/core/model";
import { makeSsh } from "~/core/ssh";
import type { TaskCtx, TaskLogger } from "~/types";

export interface CtxInputs {
	/** Validated schema output, or the raw merged env when no schema exists. */
	env: unknown;
	/** Full merged env map applied to spawned shells. */
	shellEnv: Record<string, string | undefined>;
	args: ArgValues;
	rest: string[];
	signal: AbortSignal;
	/** Data outputs of the task's dependencies (their run() return values). */
	depsData: Readonly<Record<string, unknown>>;
	/** Repo root (workspace root or root do.ts directory). */
	root: string;
	/** Active --mode ("" when the project declares none). */
	mode: string;
}

/**
 * `node_modules/.bin` from the task's cwd up to the filesystem root, ahead of
 * PATH — so `tsc` / `biome` work in commands the way they do in package.json
 * scripts, even when outdo itself was not started through bun/bunx.
 */
export function withBinPath(env: Record<string, string | undefined>, cwd: string): Record<string, string | undefined> {
	const bins: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		const bin = join(dir, "node_modules", ".bin");
		if (existsSync(bin)) {
			bins.push(bin);
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	if (bins.length === 0) {
		return env;
	}
	// Windows env keys are case-insensitive ("Path"); keep whatever casing exists.
	const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	const current = env[key];
	const parts = current === undefined || current === "" ? [] : current.split(delimiter);
	const fresh = bins.filter((bin) => !parts.includes(bin));
	if (fresh.length === 0) {
		return env;
	}
	return {
		...env,
		[key]: [
			...fresh,
			...parts,
		].join(delimiter),
	};
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return out;
}

/** A Bun Shell facade bound to the task's cwd and resolved env. */
export function makeTaskShell(cwd: string, env: Record<string, string | undefined>): typeof $ {
	const shellEnv = cleanEnv(withBinPath(env, cwd));
	const wrapper = ((strings: TemplateStringsArray, ...exprs: unknown[]) =>
		($ as unknown as (s: TemplateStringsArray, ...e: unknown[]) => ReturnType<typeof $>)(strings, ...exprs)
			.cwd(cwd)
			.env(shellEnv)) as typeof $;
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
		root: inputs.root,
		name: task.name,
		mode: inputs.mode,
		ssh: makeSsh(inputs.shellEnv, inputs.signal),
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

/** Run one-line command task bodies through Bun Shell; passthrough args go on the last one. */
async function runCommands(
	commands: readonly string[],
	ctx: TaskCtx<unknown, unknown, Readonly<Record<string, unknown>>>,
): Promise<void> {
	for (let i = 0; i < commands.length; i++) {
		const command = commands[i] as string;
		const rest = i === commands.length - 1 ? ctx.rest : [];
		if (ctx.signal.aborted) {
			throw new Error("aborted");
		}
		const result = await ctx.$`${{
			raw: command,
		}} ${rest}`.nothrow();
		if (result.exitCode !== 0) {
			throw new Error(`\`${command}\` exited with code ${result.exitCode}`);
		}
	}
}

/** Run a package.json script exactly as `bun run <script>` would (pre/post hooks, .bin on PATH). */
async function runScript(
	task: Task,
	script: string,
	ctx: TaskCtx<unknown, unknown, Readonly<Record<string, unknown>>>,
	shellEnv: Record<string, string | undefined>,
): Promise<void> {
	const proc = Bun.spawn(
		[
			process.execPath,
			"run",
			script,
			...ctx.rest,
		],
		{
			cwd: task.cwd,
			env: cleanEnv(withBinPath(shellEnv, task.cwd)),
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const onAbort = (): void => proc.kill();
	ctx.signal.addEventListener("abort", onAbort, {
		once: true,
	});
	const code = await proc.exited;
	ctx.signal.removeEventListener("abort", onAbort);
	if (code !== 0) {
		throw new Error(`\`bun run ${script}\` exited with code ${code}`);
	}
}

/**
 * Run one task in this process. Returns the task's JSON-normalized data
 * output. Throws OutdoError("task-failed") on failure.
 */
export async function runTaskInProcess(
	task: Task,
	ctx: TaskCtx<unknown, unknown, Readonly<Record<string, unknown>>>,
	shellEnv: Record<string, string | undefined> = {},
): Promise<unknown> {
	if (task.run === undefined && task.command === undefined && task.script === undefined) {
		return undefined; // aggregation-only task
	}
	let value: unknown;
	try {
		if (task.run !== undefined) {
			value = await task.run(ctx);
		} else if (task.command !== undefined) {
			await runCommands(task.command, ctx);
		} else if (task.script !== undefined) {
			await runScript(task, task.script, ctx, shellEnv);
		}
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

/** Whether the task has a body to execute (run, command, or script). */
export function hasBody(task: Task): boolean {
	return task.run !== undefined || task.command !== undefined || task.script !== undefined;
}
