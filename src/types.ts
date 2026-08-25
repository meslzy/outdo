/**
 * bundo public type surface.
 *
 * Everything here is type-only (no runtime imports) so that importing types
 * never costs startup time.
 */

import type { $ } from "bun";

// --------------------------------------------------------------------------
// Standard Schema V1 — inlined verbatim from https://standardschema.dev
// (types-only spec; zod v4 / valibot / arktype / effect schema all conform)
// --------------------------------------------------------------------------

export interface StandardSchemaV1<Input = unknown, Output = Input> {
	readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
	export interface Props<Input = unknown, Output = Input> {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
		readonly types?: Types<Input, Output> | undefined;
	}

	export type Result<Output> = SuccessResult<Output> | FailureResult;

	export interface SuccessResult<Output> {
		readonly value: Output;
		readonly issues?: undefined;
	}

	export interface FailureResult {
		readonly issues: ReadonlyArray<Issue>;
	}

	export interface Issue {
		readonly message: string;
		readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
	}

	export interface PathSegment {
		readonly key: PropertyKey;
	}

	export interface Types<Input = unknown, Output = Input> {
		readonly input: Input;
		readonly output: Output;
	}

	export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["input"];

	export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["output"];
}

// --------------------------------------------------------------------------
// Per-task CLI flags
// --------------------------------------------------------------------------

export interface ArgSpec {
	readonly type: "string" | "boolean";
	/** Single-character alias, e.g. `-m`. */
	readonly short?: string;
	readonly default?: string | boolean;
	/** Only meaningful for `type: "string"` — booleans always default to false. */
	readonly required?: boolean;
	readonly description?: string;
}

type InferArg<S extends ArgSpec> = S["type"] extends "boolean"
	? boolean
	: S extends {
				required: true;
			}
		? string
		: S extends {
					default: string;
				}
			? string
			: string | undefined;

export type InferArgs<A extends Record<string, ArgSpec>> = {
	readonly [K in keyof A]: InferArg<A[K]>;
};

/** The raw resolved env map when a task declares no schema. */
export type RawEnv = Readonly<Record<string, string | undefined>>;

export type EnvOut<E> = [
	E,
] extends [
	StandardSchemaV1,
]
	? StandardSchemaV1.InferOutput<E>
	: RawEnv;

export type ArgsOut<A> = [
	A,
] extends [
	Record<string, ArgSpec>,
]
	? InferArgs<A>
	: Record<string, never>;

// --------------------------------------------------------------------------
// Task context
// --------------------------------------------------------------------------

export interface TaskLogger {
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
	debug(...args: unknown[]): void;
}

export interface TaskCtx<Env = RawEnv, Args = Record<string, never>> {
	/** Bun Shell, pre-configured with the task's cwd and resolved env. */
	$: typeof $;
	/** Validated env (output of the task's schema), or the raw resolved env map. */
	env: Env;
	/** Parsed per-task CLI flags, typed from the task's `args` declaration. */
	args: Args;
	/** Raw arguments after `--`. Only delivered to explicitly requested tasks. */
	rest: string[];
	/** Aborted on Ctrl-C / watch supersession. Long tasks should respect it. */
	signal: AbortSignal;
	/** Prefixed logger (safe under concurrent output multiplexing). */
	log: TaskLogger;
	/** Absolute working directory of the task. */
	cwd: string;
	/** Name of the task being run. */
	name: string;
}

// --------------------------------------------------------------------------
// Task definitions
// --------------------------------------------------------------------------

interface TaskMeta {
	/** One-line description shown in the task list. */
	desc?: string;
	/** Group heading for the task list. Ungrouped tasks are listed last. */
	group?: string;
	/** Input globs for fingerprint caching (skip when unchanged). */
	inputs?: readonly string[];
	/** Output globs — must exist for a cache hit; missing outputs force a rerun. */
	outputs?: readonly string[];
	/** Globs that trigger a rerun in `--watch` mode (defaults to `inputs`). */
	watch?: readonly string[];
	/** Long-running service: stays alive, dependents start once it has spawned. */
	persistent?: boolean;
	/** Working directory, relative to the do.ts location. */
	cwd?: string;
}

/**
 * A task written as a plain inline object. May declare deps but not
 * `env`/`args` — use the `task()` builder for those, which types the ctx.
 */
export interface InlineTaskDef extends TaskMeta {
	deps?: readonly string[];
	run?: (ctx: TaskCtx) => unknown;
}

/** Input to the `task()` builder. */
export interface TaskInput<
	E extends StandardSchemaV1 | undefined,
	A extends Record<string, ArgSpec> | undefined,
	Deps extends readonly string[],
> extends TaskMeta {
	deps?: Deps;
	/** Standard Schema for required env vars — validated before anything runs. */
	env?: E;
	/** Typed CLI flags: `bundo <task> --flag value`. */
	args?: A;
	run?: (ctx: TaskCtx<EnvOut<E>, ArgsOut<A>>) => unknown;
}

/** Brand carried by `task()` results (set non-enumerably at runtime). */
export interface BuiltMark {
	readonly "~built": true;
}

/** A task produced by the `task()` builder, as returned to the author. */
export type BuiltTask<
	E extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
	A extends Record<string, ArgSpec> | undefined = Record<string, ArgSpec> | undefined,
	Deps extends readonly string[] = readonly string[],
> = TaskInput<E, A, Deps> & BuiltMark;

/**
 * What `defineTasks` accepts for a builder-made entry. Deliberately minimal:
 * omitting `env`/`args`/`run` here keeps excess-property checking strict for
 * inline literals (which must not declare `env`/`args`) and leaves
 * `InlineTaskDef` as the only source of contextual typing for inline `run`.
 * Concrete `BuiltTask` values still assign fine (extra properties are allowed
 * on non-fresh values); the required `~built` brand keeps literals out.
 */
export interface BuiltEntry extends TaskMeta, BuiltMark {
	deps?: readonly string[];
}

export type TaskEntry = InlineTaskDef | BuiltEntry;

/** The dep names an entry declares, as a literal union (deps may be optional). */
type DepsOf<V> = V extends {
	deps?: infer D;
}
	? D extends readonly (infer N extends string)[]
		? N
		: never
	: never;

/** Resolves to a no-op when every dep name is valid; otherwise forces a clear error. */
export type DepsCheck<V, Names extends string> = [
	DepsOf<V>,
] extends [
	Names,
]
	? unknown
	: {
			deps: readonly Names[];
		};

/** A normalized task map as consumed by the runner (type-erased). */
export type Tasks = Record<string, TaskEntry>;
