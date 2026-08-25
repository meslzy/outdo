/**
 * bundo — public library entry. `do.ts` files import from here.
 */

import type { ArgSpec, BuiltTask, DepsCheck, StandardSchemaV1, TaskEntry, TaskInput } from "./types";

export type {
	ArgSpec,
	ArgsOut,
	BuiltTask,
	EnvOut,
	InferArgs,
	InlineTaskDef,
	RawEnv,
	StandardSchemaV1,
	TaskCtx,
	TaskEntry,
	TaskInput,
	TaskLogger,
	Tasks,
} from "./types";

/** Runtime brand so the CLI can verify a do.ts default export. */
export const TASKS_BRAND: unique symbol = Symbol.for("bundo.tasks.v1");

/**
 * Build a single task with a fully-typed context:
 * `ctx.env` from the `env` Standard Schema, `ctx.args` from the `args` record.
 *
 * ```ts
 * deploy: task({
 *   env: z.object({ DEPLOY_URL: z.url() }),
 *   args: { dry: { type: "boolean", short: "d" } },
 *   run: async ({ $, env, args }) => { ... },
 * })
 * ```
 */
export function task<
	E extends StandardSchemaV1 | undefined = undefined,
	const A extends Record<string, ArgSpec> | undefined = undefined,
	const Deps extends readonly string[] = readonly [],
>(def: TaskInput<E, A, Deps>): BuiltTask<E, A, Deps> {
	Object.defineProperty(def, "~built", {
		value: true,
		enumerable: false,
	});
	return def as BuiltTask<E, A, Deps>;
}

/**
 * Define the task map for this repo — the single default export of `do.ts`.
 * Dep names are validated across entries at compile time.
 */
export function defineTasks<const T extends Record<string, TaskEntry>>(
	tasks: { [K in keyof T]: T[K] & DepsCheck<T[K], Extract<keyof T, string>> },
): T {
	Object.defineProperty(tasks, TASKS_BRAND, {
		value: 1,
		enumerable: false,
	});
	return tasks;
}

export function isTasks(value: unknown): value is Record<string, object> {
	return typeof value === "object" && value !== null && (value as Record<PropertyKey, unknown>)[TASKS_BRAND] === 1;
}
