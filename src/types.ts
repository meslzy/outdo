/**
 * outdo public type surface.
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
// Shell commands
// --------------------------------------------------------------------------

/** Bun Shell, as handed to tasks (`ctx.$`). */
export type Shell = typeof $;

/** A shell command, or several that run one after another (Bun Shell syntax). */
export type Command = string | readonly string[];

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
	/** Allowed values (string flags). Shown in help and offered by Tab completion. */
	readonly choices?: readonly string[];
}

/** A flag declaration: an `ArgSpec`, or any Standard Schema (zod, valibot, ...). */
export type ArgDecl = ArgSpec | StandardSchemaV1;

type InferSpec<S> = S extends {
	type: "boolean";
}
	? boolean
	:
			| (S extends {
					choices: readonly (infer C)[];
			  }
					? C
					: string)
			| (S extends {
					required: true;
			  }
					? never
					: S extends {
								default: string;
							}
						? never
						: undefined);

type InferArg<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : InferSpec<S>;

export type InferArgs<A> = {
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
	Record<string, ArgDecl>,
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

/**
 * Dep names that are never checked at compile time: `^build` (the task in
 * every workspace dependency) and `pkg#build` (a workspace member's task).
 */
export type QualifiedDep = `^${string}` | `${string}#${string}`;

type RunFn<F> = Extract<NonNullable<F>, (...args: never) => unknown>;

/** The awaited return type of a task's `run()` — its data output (commands have none). */
export type OutputOf<T> = T extends {
	run?: infer F;
}
	? [
			RunFn<F>,
		] extends [
			never,
		]
		? undefined
		: RunFn<F> extends (...args: never) => infer R
			? Awaited<R>
			: undefined
	: undefined;

/** A dep that may name an absent task (`optional("x")`) — exempt from name checks. */
export interface OptionalDep {
	readonly task: string;
	readonly optional: true;
	readonly if?: string | ((env: RawEnv) => boolean);
}

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
export type DepsDataOf<Deps extends readonly unknown[]> = {
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

/** Result of a finished remote command. */
export interface RemoteResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * A `$`-like tagged template that runs on a remote host over ssh.
 * Interpolated values are shell-escaped; arrays expand to several words.
 */
export interface RemoteShell {
	(strings: TemplateStringsArray, ...values: unknown[]): Promise<RemoteResult>;
	/** Run every command from this directory on the remote host. */
	cwd(dir: string): RemoteShell;
	/** Don't throw on a non-zero exit code. */
	nothrow(): RemoteShell;
	/** Don't echo output (it is still captured in the result). */
	quiet(): RemoteShell;
}

export interface SshOptions {
	/** Output prefix. Default: the host part of the target. */
	label?: string;
	/** Extra `ssh` arguments, e.g. `["-p", "2222"]`. */
	args?: readonly string[];
}

export type Ssh = (target: string, options?: SshOptions) => RemoteShell;

export interface TaskCtx<
	Env = RawEnv,
	Args = Record<string, never>,
	Deps = Readonly<Record<string, unknown>>,
	Mode extends string = string,
> {
	/** Bun Shell, pre-configured with the task's cwd and resolved env. */
	$: Shell;
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
	/** Absolute repo root: the workspace root, or the directory of the root do.ts. */
	root: string;
	/** Name of the task being run. */
	name: string;
	/** The active `--mode` (the first declared mode by default; "" when none are declared). */
	mode: Mode;
	/** Run commands on a remote host: `` await ssh("me@vps")`cd app && git pull` ``. */
	ssh: Ssh;
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

/** Pre-checks run right before the task starts. Failing ones print `hint`. */
export interface Requires {
	/** Executables that must be on PATH (node_modules/.bin counts). */
	readonly bin?: readonly string[];
	/** Env vars that must be set and non-empty. */
	readonly env?: readonly string[];
	/** Files or directories that must exist (relative to the task cwd). */
	readonly file?: readonly string[];
	/** HTTP GET must return 2xx. */
	readonly url?: string;
	/** TCP connect must succeed (to `host`, default 127.0.0.1). */
	readonly port?: number;
	readonly host?: string;
	/** One line telling you how to fix it, e.g. "run outdo dev first". */
	readonly hint?: string;
}

export interface TaskMeta<Names extends string = string, Mode extends string = string> {
	/** One-line description shown in the task list. */
	desc?: string;
	/** Group heading for the task list. Ungrouped tasks are listed last. */
	group?: string;
	/** Input globs for fingerprint caching (skip when unchanged). */
	inputs?: readonly string[];
	/** Output globs — must exist for a cache hit; missing outputs are restored from the cache or rerun. */
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
	/** Tasks to run one after another (each with its own deps) once `deps` are done. */
	steps?: readonly Names[];
	/** Tasks that run after this one finishes — even when it fails or is interrupted. */
	finally?: readonly Names[];
	/** Flag names that may also be given as bare words, in order: `outdo logs api`. */
	positional?: readonly string[];
	/** Extra env files for this task (relative to its do.ts). `.env.x` also loads `.env.x.<mode>`. */
	envFiles?: readonly string[];
	/** Ask before running in these modes (`true` = always). Skip the question with `--yes`. */
	protect?: true | Mode | readonly Mode[];
	/** Always ask this question before running. Skip it with `--yes`. */
	confirm?: string;
	/** Checks that must pass before the task starts. */
	requires?: Requires;
	/** Safe to run unattended: reads but never changes anything. Allowed under OUTDO_READONLY=1. */
	readonly?: boolean;
	/** Changes or deletes things that are hard to get back. */
	destructive?: boolean;
}

/** A task written as an object inside `defineTasks` / `ns`. */
export interface TaskDef<
	Names extends string = string,
	Mode extends string = string,
	Env = RawEnv,
	Args = Record<string, never>,
	Deps = Readonly<Record<string, unknown>>,
> extends TaskMeta<Names, Mode> {
	deps?: readonly (DepEntry<Names | QualifiedDep> | OptionalDep)[];
	/** Standard Schema for required env vars — validated before anything runs. */
	env?: StandardSchemaV1;
	/** Typed CLI flags: `outdo <task> --flag value`. */
	args?: Record<string, ArgDecl>;
	/** A function, or shell command(s); args after `--` are appended to the last command. */
	run?: Command | ((ctx: TaskCtx<Env, Args, Deps, Mode>) => unknown);
}

/** @deprecated alias of `TaskDef`. */
export type InlineTaskDef = TaskDef;

/** Input to the `task()` builder. */
export interface TaskInput<
	E extends StandardSchemaV1 | undefined,
	A extends Record<string, ArgDecl> | undefined,
	Deps extends readonly DepEntry[],
	R = unknown,
> extends TaskMeta {
	deps?: Deps;
	/** Standard Schema for required env vars — validated before anything runs. */
	env?: E;
	/** Typed CLI flags: `outdo <task> --flag value`. */
	args?: A;
	run?: Command | ((ctx: TaskCtx<EnvOut<E>, ArgsOut<A>, DepsDataOf<Deps>>) => R);
}

/** Brand carried by `task()` results (set non-enumerably at runtime). */
export interface BuiltMark {
	readonly "~built": true;
}

/** A task produced by the `task()` builder, as returned to the author. */
export type BuiltTask<
	E extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
	A extends Record<string, ArgDecl> | undefined = Record<string, ArgDecl> | undefined,
	Deps extends readonly DepEntry[] = readonly DepEntry[],
	R = unknown,
> = TaskInput<E, A, Deps, R> & BuiltMark;

/**
 * What a `task()` result must look like inside `defineTasks`. Deliberately
 * without env/args/run: a union member that declares `run` would join the
 * contextual type of inline `run` functions and erase their ctx typing.
 */
export interface BuiltEntry extends TaskMeta, BuiltMark {
	deps?: readonly DepEntry[];
}

/** A group of tasks made by `ns()`: `db: ns({ reset, backup })` → `db:reset`, `db:backup`. */
export interface Namespace<T = unknown> {
	readonly "~ns": T;
}

/** Anything `defineTasks` accepts as one entry. */
export type TaskEntry = Command | TaskDef | BuiltTask | Namespace;

/** A normalized task map as consumed by the runner (type-erased). */
export type Tasks = Record<string, TaskEntry>;

// --------------------------------------------------------------------------
// defineTasks / ns inference plumbing
// --------------------------------------------------------------------------

type At<X, K> = K extends keyof X ? X[K] : unknown;
type EnvOf<X> = unknown extends X ? RawEnv : X;
type ArgsOf<X> = unknown extends X ? Record<string, never> : InferArgs<X>;
type DepsOf<X> = X extends readonly unknown[] ? DepsDataOf<X> : Readonly<Record<string, unknown>>;

/** Every runnable name: top-level keys, plus `ns:task` for namespaced ones. */
export type FlatNames<D, N> = {
	[K in keyof D & string]: K extends keyof N ? (unknown extends N[K] ? K : `${K}:${keyof N[K] & string}`) : K;
}[keyof D & string];

/**
 * The entry-shape of `defineTasks`/`ns` input as an intersection of reverse
 * mapped types: E/A/Dp/St/Fi capture each entry's env schema output, args,
 * deps, steps and finally (so `run` gets a typed ctx without `task()`), and
 * D carries the keys. Unknown keys fail excess-property checks. Only the D
 * mapping is a union: a union in every mapping multiplies out (TS distributes
 * the intersection) and pushed checking a small do.ts past 3 GB.
 */
type EntryShape<E, A, Dp, St, Fi, D, Names extends string, Mode extends string> = {
	[K in keyof E]: {
		env?: StandardSchemaV1<unknown, E[K]>;
	};
} & {
	[K in keyof A]: {
		args?: A[K] & Record<string, ArgDecl>;
	};
} & {
	[K in keyof Dp]: {
		deps?: Dp[K];
	};
} & {
	[K in keyof St]: {
		steps?: St[K];
	};
} & {
	[K in keyof Fi]: {
		finally?: Fi[K];
	};
} & {
	[K in keyof D]:
		| Command
		| Namespace
		| BuiltEntry
		| TaskDef<Names, Mode, EnvOf<At<E, K>>, ArgsOf<At<A, K>>, DepsOf<At<Dp, K>>>;
};

/** What a namespace remembers about each entry, for name checks in `defineTasks`. */
type NsShape<D, Dp, St, Fi> = {
	[K in keyof D]: {
		deps: At<Dp, K>;
		steps: At<St, K>;
		finally: At<Fi, K>;
	};
};

type CheckList<X, Allowed> = unknown extends X ? unknown : X extends readonly Allowed[] ? unknown : readonly Allowed[];

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

type DepNames<X> = X extends readonly (infer E)[] ? RequiredDepName<E> : never;

/** Resolves to `unknown` when every required dep name is known (or deps are plain `string`s). */
type DepsChecked<X, Names extends string> = unknown extends X
	? unknown
	: [
				DepNames<X>,
			] extends [
				Names | QualifiedDep,
			]
		? unknown
		: [
					string,
				] extends [
					DepNames<X>,
				]
			? unknown
			: readonly (DepEntry<Names | QualifiedDep> | OptionalDep)[];

type NsChecked<NT, Names extends string> = {
	[P in keyof NT]: {
		deps: DepsChecked<At<NT[P], "deps">, Names>;
		steps: CheckList<At<NT[P], "steps">, Names>;
		finally: CheckList<At<NT[P], "finally">, Names>;
	};
};

export type GitHook =
	| "applypatch-msg"
	| "commit-msg"
	| "post-checkout"
	| "post-commit"
	| "post-merge"
	| "post-rewrite"
	| "pre-applypatch"
	| "pre-commit"
	| "pre-merge-commit"
	| "pre-push"
	| "pre-rebase"
	| "prepare-commit-msg";

/** A git hook: a command, or a task-like body. `restage` re-adds fully staged files the hook changed. */
export interface HookDef<Names extends string = string> {
	desc?: string;
	deps?: readonly (DepEntry<Names | QualifiedDep> | OptionalDep)[];
	steps?: readonly Names[];
	run?: Command | ((ctx: TaskCtx) => unknown);
	restage?: boolean;
}

/** Defaults merged into every workspace member's task of that name (scripts included). */
export interface MemberDefaults extends Omit<TaskMeta, "steps" | "finally"> {
	/** Extra deps; `^name` = `name` in each workspace dependency of the package. */
	deps?: readonly DepEntry[];
}

export interface DefineOptions<Names extends string = string, Modes extends readonly string[] = readonly string[]> {
	/** Allowed `--mode` values; the first is the default. Picks `.env.<mode>` files. */
	modes?: Modes;
	/** Per-task-name defaults for workspace members, e.g. `{ tsc: { deps: ["^tsc"] } }`. */
	members?: Readonly<Record<string, MemberDefaults>>;
	/** Git hooks, installed with `outdo hooks install`. */
	hooks?: { readonly [H in GitHook]?: Command | HookDef<Names> };
}

/** The typed input of `defineTasks`. */
export type DefineInput<E, A, Dp, St, Fi, D, N, Mode extends string> = EntryShape<
	E,
	A,
	Dp,
	St,
	Fi,
	D,
	NoInfer<FlatNames<D, N>>,
	Mode
> & {
	[K in keyof N]: {
		readonly "~ns"?: N[K];
	};
} & {
	// Over keyof D, not keyof N: a second reverse mapping over N would add
	// empty inference candidates and lose the namespace contents.
	// `task()` entries are BuiltEntry (deps unchecked there), so their dep
	// names are checked here, from the captured Dp.
	[K in keyof D]: NoInfer<
		(K extends keyof N
			? unknown extends N[K]
				? unknown
				: Namespace<NsChecked<N[K], FlatNames<D, N> | (keyof N[K] & string)>>
			: unknown) &
			(unknown extends DepsChecked<At<Dp, K>, FlatNames<D, N>>
				? unknown
				: {
						deps?: DepsChecked<At<Dp, K>, FlatNames<D, N>>;
					})
	>;
};

/** The typed input of `ns`. Names are checked later, by `defineTasks`. */
export type NsInput<E, A, Dp, St, Fi, D> = EntryShape<E, A, Dp, St, Fi, D, string, string>;

export type { NsShape };

/** `defineTasks` result: one entry per key. */
export type DefinedTasks<D> = {
	readonly [K in keyof D]: TaskEntry;
};
