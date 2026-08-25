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
// Dependency entries
// --------------------------------------------------------------------------

/** Object form of a dependency entry. */
export interface DepRef<Name extends string = string, Out = unknown> {
	readonly task: Name;
	/**
	 * Edge is active iff `env[name]` is truthy (unset, "", "0", "false" →
	 * inactive) or the predicate returns true. Evaluated once at plan time
	 * against the resolved dotenv cascade.
	 */
	readonly if?: string | ((env: RawEnv) => boolean);
	/** Soft-skip when the named task does not exist in this do.ts. */
	readonly optional?: boolean;
	/** Phantom output type carried by `from()`; never present at runtime. */
	readonly "~out"?: Out;
}

export type DepEntry<Name extends string = string> = Name | DepRef<Name, unknown>;

/** The awaited return type of a task's `run()` — its data output. */
export type OutputOf<T> = T extends {
	run?: infer F;
}
	? [
			NonNullable<F>,
		] extends [
			never,
		]
		? undefined
		: NonNullable<F> extends (...args: never) => infer R
			? Awaited<R>
			: undefined
	: undefined;

type DepEntryName<E> = E extends string
	? E
	: E extends {
				readonly task: infer N extends string;
			}
		? N
		: never;

type DepEntryOut<E> = [
	E,
] extends [
	DepRef<string, infer O>,
]
	? E extends
			| {
					readonly if: unknown;
			  }
			| {
					readonly optional: true;
			  }
		? O | undefined
		: O
	: unknown;

/** `ctx.deps` shape inferred from a task's dep entries. */
export type DepsDataOf<Deps extends readonly DepEntry[]> = {
	readonly [E in Deps[number] as DepEntryName<E>]: DepEntryOut<E>;
};

// --------------------------------------------------------------------------
// Task context
// --------------------------------------------------------------------------

export interface TaskLogger {
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
	debug(...args: unknown[]): void;
}

export interface TaskCtx<Env = RawEnv, Args = Record<string, never>, Deps = Readonly<Record<string, unknown>>> {
	/** Bun Shell, pre-configured with the task's cwd and resolved env. */
	$: typeof $;
	/** Validated env (output of the task's schema), or the raw resolved env map. */
	env: Env;
	/** Parsed per-task CLI flags, typed from the task's `args` declaration. */
	args: Args;
	/** Data outputs of this task's dependencies (their `run()` return values). */
	deps: Deps;
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

/** How a persistent task signals readiness. Exactly one of log/url/port. */
export interface ReadyProbe {
	/** Substring matched against the service's own output lines (stdout or stderr). */
	readonly log?: string;
	/** HTTP GET must return 2xx. */
	readonly url?: string;
	/** TCP connect must succeed. */
	readonly port?: number;
	/** Host for `port` probes. Default "127.0.0.1". */
	readonly host?: string;
	/** Total readiness budget before the service is failed. Default 30000. */
	readonly timeoutMs?: number;
}

export interface RetrySpec {
	/** Maximum total attempts (including the first). Must be >= 1. */
	readonly attempts: number;
	/** Delay before each retry. Default 0. */
	readonly delayMs?: number;
	/** "exponential" doubles delayMs per retry. Default "fixed". */
	readonly backoff?: "fixed" | "exponential";
}

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
	/** Long-running service: stays alive, dependents start once it is ready. */
	persistent?: boolean;
	/** Working directory, relative to the do.ts location. */
	cwd?: string;
	/** Readiness probe — persistent tasks only; dependents wait for it. */
	ready?: ReadyProbe;
	/** Re-run on failure — non-persistent tasks only. Number = total attempts. */
	retry?: number | RetrySpec;
	/** Per-attempt time budget (ms) — non-persistent tasks only. */
	timeoutMs?: number;
}

/**
 * A task written as a plain inline object. May declare deps but not
 * `env`/`args` — use the `task()` builder for those, which types the ctx.
 */
export interface InlineTaskDef extends TaskMeta {
	deps?: readonly DepEntry[];
	run?: (ctx: TaskCtx) => unknown;
}

/** Input to the `task()` builder. */
export interface TaskInput<
	E extends StandardSchemaV1 | undefined,
	A extends Record<string, ArgSpec> | undefined,
	Deps extends readonly DepEntry[],
	R = unknown,
> extends TaskMeta {
	deps?: Deps;
	/** Standard Schema for required env vars — validated before anything runs. */
	env?: E;
	/** Typed CLI flags: `bundo <task> --flag value`. */
	args?: A;
	run?: (ctx: TaskCtx<EnvOut<E>, ArgsOut<A>, DepsDataOf<Deps>>) => R;
}

/** Brand carried by `task()` results (set non-enumerably at runtime). */
export interface BuiltMark {
	readonly "~built": true;
}

/** A task produced by the `task()` builder, as returned to the author. */
export type BuiltTask<
	E extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
	A extends Record<string, ArgSpec> | undefined = Record<string, ArgSpec> | undefined,
	Deps extends readonly DepEntry[] = readonly DepEntry[],
	R = unknown,
> = TaskInput<E, A, Deps, R> & BuiltMark;

/**
 * What `defineTasks` accepts for a builder-made entry. Deliberately minimal:
 * omitting `env`/`args`/`run` here keeps excess-property checking strict for
 * inline literals (which must not declare `env`/`args`) and leaves
 * `InlineTaskDef` as the only source of contextual typing for inline `run`.
 * Concrete `BuiltTask` values still assign fine (extra properties are allowed
 * on non-fresh values); the required `~built` brand keeps literals out.
 */
export interface BuiltEntry extends TaskMeta, BuiltMark {
	deps?: readonly DepEntry[];
}

export type TaskEntry = InlineTaskDef | BuiltEntry;

/** Names an entry's deps must resolve; optional entries are exempt (they may be absent). */
type RequiredDepName<E> = E extends string
	? E
	: E extends {
				readonly optional: true;
			}
		? never
		: E extends {
					readonly task: infer N extends string;
				}
			? N
			: never;

/** The dep names an entry declares, as a literal union (deps may be optional). */
type DepsOf<V> = V extends {
	deps?: infer D;
}
	? D extends readonly (infer E)[]
		? RequiredDepName<E>
		: never
	: never;

/** Resolves to a no-op when every dep name is valid; otherwise forces a clear error. */
export type DepsCheck<V, Names extends string> = [
	DepsOf<V>,
] extends [
	Names,
]
	? unknown
	: [
				string,
			] extends [
				DepsOf<V>,
			]
		? unknown // deps widened to plain string — no literals to check
		: {
				deps?: readonly DepEntry<Names>[];
			};

/** A normalized task map as consumed by the runner (type-erased). */
export type Tasks = Record<string, TaskEntry>;
