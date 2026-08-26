/**
 * outdo — public library entry. `do.ts` files import from here.
 */

import type {
	ArgSpec,
	BuiltTask,
	DepEntry,
	DepRef,
	DepsCheck,
	OutputOf,
	StandardSchemaV1,
	TaskEntry,
	TaskInput,
} from "./types";

export type {
	ArgSpec,
	ArgsOut,
	BuiltTask,
	DepEntry,
	DepRef,
	DepsDataOf,
	EnvOut,
	InferArgs,
	InlineTaskDef,
	OutputOf,
	RawEnv,
	ReadyProbe,
	RetrySpec,
	StandardSchemaV1,
	TaskCtx,
	TaskEntry,
	TaskInput,
	TaskLogger,
	Tasks,
} from "./types";

/** Runtime brand so the CLI can verify a do.ts default export. */
export const TASKS_BRAND: unique symbol = Symbol.for("outdo.tasks.v1");

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
	const Deps extends readonly DepEntry[] = readonly [],
	R = unknown,
>(def: TaskInput<E, A, Deps, R>): BuiltTask<E, A, Deps, R> {
	Object.defineProperty(def, "~built", {
		value: true,
		enumerable: false,
	});
	return def as BuiltTask<E, A, Deps, R>;
}

/**
 * Dependency on a task that may not exist in this do.ts — silently dropped
 * when absent (useful for shared presets across workspace members).
 */
export function optional<const N extends string>(
	task: N,
): {
	readonly task: N;
	readonly optional: true;
} {
	return {
		task,
		optional: true,
	};
}

/**
 * Typed dependency reference: carries the producer's `run()` return type into
 * the consumer's `ctx.deps`.
 *
 * ```ts
 * const version = task({ run: () => ({ tag: "1.2.3" }) });
 * const deploy = task({
 *   deps: [from("version", version)],
 *   run: ({ deps }) => console.log(deps.version.tag), // typed!
 * });
 * ```
 */
export function from<const N extends string, T>(name: N, _task: T): DepRef<N, OutputOf<T>> {
	return {
		task: name,
	} as DepRef<N, OutputOf<T>>;
}

/**
 * Define the task map for this repo — the single default export of `do.ts`.
 * Dep names are validated across entries at compile time.
 */
export function defineTasks<const T extends Record<string, TaskEntry>>(
	// `T & {mapped}` (not `T[K] & Check` inside the map): the latter makes TS
	// skip the corrective check for object dep entries with 2+ properties.
	tasks: T & { [K in keyof T]: DepsCheck<T[K], Extract<keyof T, string>> },
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
