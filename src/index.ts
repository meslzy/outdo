/**
 * outdo — public library entry. `do.ts` files import from here.
 */

import type {
	ArgDecl,
	BuiltTask,
	DefinedTasks,
	DefineInput,
	DefineOptions,
	DepEntry,
	DepRef,
	FlatNames,
	Namespace,
	NsInput,
	NsShape,
	OutputOf,
	StandardSchemaV1,
	TaskInput,
} from "./types";

export type {
	ArgDecl,
	ArgSpec,
	ArgsOut,
	BuiltEntry,
	BuiltTask,
	Command,
	DefinedTasks,
	DefineOptions,
	DepEntry,
	DepRef,
	DepsDataOf,
	EnvOut,
	GitHook,
	HookDef,
	InferArgs,
	InlineTaskDef,
	MemberDefaults,
	Namespace,
	OutputOf,
	QualifiedDep,
	RawEnv,
	ReadyProbe,
	RemoteResult,
	RemoteShell,
	Requires,
	RetrySpec,
	Shell,
	Ssh,
	SshOptions,
	StandardSchemaV1,
	TaskCtx,
	TaskDef,
	TaskEntry,
	TaskInput,
	TaskLogger,
	TaskMeta,
	Tasks,
} from "./types";

/** Runtime brand so the CLI can verify a do.ts default export. */
export const TASKS_BRAND: unique symbol = Symbol.for("outdo.tasks.v1");

/** Where `defineTasks` keeps its options (non-enumerable, next to the brand). */
export const OPTIONS_KEY: unique symbol = Symbol.for("outdo.options.v1");

/**
 * Build a single task with a fully-typed context. Optional since `defineTasks`
 * types `env`/`args` itself; still handy for a task defined outside the map
 * (e.g. one consumed with `from()`).
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
	const A extends Record<string, ArgDecl> | undefined = undefined,
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
 * Group tasks under one name: `db: ns({ reset, backup })` defines `db:reset`
 * and `db:backup` (run as `outdo db reset` or `outdo db:reset`). Inside a
 * namespace, deps and steps name siblings first, then top-level tasks.
 */
export function ns<E, const A, const Dp, const St, const Fi, const D>(
	tasks: NsInput<E, A, Dp, St, Fi, D>,
): Namespace<NsShape<D, Dp, St, Fi>> {
	return {
		"~ns": tasks,
	} as unknown as Namespace<NsShape<D, Dp, St, Fi>>;
}

/**
 * Define the task map for this repo — the single default export of `do.ts`.
 * An entry is a shell command, a list of commands, a task object (its `env`
 * and `args` type `run`'s context), or an `ns()` group. Dep, step and finally
 * names are checked at compile time.
 */
export function defineTasks<
	E,
	const A,
	const Dp,
	const St,
	const Fi,
	const D,
	const N,
	const M extends readonly string[] = readonly string[],
>(
	tasks: DefineInput<E, A, Dp, St, Fi, D, N, M[number]>,
	options?: DefineOptions<NoInfer<FlatNames<D, N>>, M>,
): DefinedTasks<D> {
	Object.defineProperty(tasks, TASKS_BRAND, {
		value: 1,
		enumerable: false,
	});
	if (options !== undefined) {
		Object.defineProperty(tasks, OPTIONS_KEY, {
			value: options,
			enumerable: false,
		});
	}
	return tasks as unknown as DefinedTasks<D>;
}

export function isTasks(value: unknown): value is Record<string, object> {
	return typeof value === "object" && value !== null && (value as Record<PropertyKey, unknown>)[TASKS_BRAND] === 1;
}

export function isNamespace(value: unknown): value is Namespace<Record<string, unknown>> {
	return (
		typeof value === "object"
		&& value !== null
		&& "~ns" in value
		&& typeof (value as Record<string, unknown>)["~ns"] === "object"
	);
}

/** The options passed to `defineTasks`, if any. */
export function optionsOf(tasks: object): DefineOptions | undefined {
	return (tasks as Record<PropertyKey, unknown>)[OPTIONS_KEY] as DefineOptions | undefined;
}
