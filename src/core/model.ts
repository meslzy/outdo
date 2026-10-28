/** Internal, type-erased task model consumed by the runner. */

import type { WorkspaceMember } from "~/core/workspaces";
import type { ReadyProbe, Requires, RetrySpec, StandardSchemaV1, TaskCtx } from "~/types";

/** One declared dependency edge (optional-missing edges are pruned at load). */
export interface DepEdge {
	task: string;
	optional: boolean;
	/** Env-var name (truthy check) or predicate; undefined = unconditional. */
	condition: string | ((env: Readonly<Record<string, string | undefined>>) => boolean) | undefined;
	/** Added by a `steps` entry (ordered by the run pipeline, not declared as a dep). */
	step?: boolean;
}

/**
 * A normalized flag. ArgSpec and Standard Schema declarations both land here;
 * `type` is the CLI shape (how many tokens, how to coerce), the schema — when
 * present — does the real validation.
 */
export interface ArgDef {
	type: "string" | "boolean" | "number" | "array";
	short: string | undefined;
	description: string | undefined;
	default: unknown;
	required: boolean;
	/** Allowed string values (ArgSpec `choices` or a schema's enum). */
	choices: readonly string[] | undefined;
	/** Completion-only suggestions (ArgSpec `suggest`). */
	suggest: readonly string[] | undefined;
	schema: StandardSchemaV1 | undefined;
	/** JSON Schema for the flag (schema flags only; drives MCP input schemas). */
	jsonSchema: Record<string, unknown> | undefined;
}

export type ArgValues = Record<string, unknown>;

export type TaskKind = "task" | "script" | "hook";

export interface Task {
	name: string;
	desc: string | undefined;
	group: string | undefined;
	kind: TaskKind;
	/**
	 * Dependency names. At load time this is every declared edge; the run
	 * pipeline replaces it with the condition-filtered active set
	 * (`applyConditions`) so all downstream consumers stay edge-agnostic.
	 */
	deps: readonly string[];
	/** All declared edges (for graph rendering and condition evaluation). */
	depEdges: readonly DepEdge[];
	/**
	 * Ordering-only predecessors added by the run pipeline for `steps`: they
	 * must finish first, but they are not data deps (no ctx.deps entry, no
	 * cache fingerprint component).
	 */
	after: readonly string[];
	/** Resolved `steps` names, in order (each is also a dep edge with `step: true`). */
	steps: readonly string[];
	/** Resolved `finally` task names. */
	finally: readonly string[];
	env: StandardSchemaV1 | undefined;
	args: Readonly<Record<string, ArgDef>>;
	/** Arg names fillable by bare words, in order. */
	positional: readonly string[];
	inputs: readonly string[];
	outputs: readonly string[];
	watch: readonly string[];
	persistent: boolean;
	/** Readiness probe (persistent tasks only). */
	ready: ReadyProbe | undefined;
	/** Fully-defaulted retry policy (non-persistent tasks only). */
	retry: Required<RetrySpec> | undefined;
	/** Per-attempt time budget in ms (non-persistent tasks only). */
	timeoutMs: number | undefined;
	/** Absolute working directory (resolved against the do.ts directory). */
	cwd: string;
	run: ((ctx: TaskCtx<unknown, unknown, Readonly<Record<string, unknown>>>) => unknown) | undefined;
	/** Shell commands (one-line tasks), run in order; passthrough args go on the last. */
	command: readonly string[] | undefined;
	/** package.json script run with `bun run <script>` in `cwd`. */
	script: string | undefined;
	/** Absolute extra env files (mode variants are added at resolve time). */
	envFiles: readonly string[];
	/** Modes that require confirmation ("*" = every run). */
	protect: readonly string[];
	confirm: string | undefined;
	requires: Requires | undefined;
	readonly: boolean;
	destructive: boolean;
	/** The do.ts (or package.json for scripts) this task was defined in. */
	sourceConfig: string;
	/** Name within its own do.ts (differs from name for workspace tasks). */
	localName: string;
}

export interface HookSpec {
	/** Task that implements the hook (kind "hook"). */
	task: string;
	restage: boolean;
}

export interface Project {
	/** Absolute path of the loaded do.ts (or package.json when there is none). */
	configPath: string;
	/** Directory containing do.ts — the repo root (workspace root in workspace mode). */
	rootDir: string;
	tasks: ReadonlyMap<string, Task>;
	/** Workspace members (workspace mode only). */
	members?: readonly WorkspaceMember[];
	/** Declared `--mode` values (first = default). Empty when none are declared. */
	modes: readonly string[];
	/** Git hooks from defineTasks options, by hook name. */
	hooks: ReadonlyMap<string, HookSpec>;
	/** Every file whose change invalidates the cached task list (completion cache). */
	sources: readonly string[];
}

/** Every predecessor the scheduler must wait for: data deps plus step ordering. */
export function predecessors(task: Task): readonly string[] {
	return task.after.length === 0
		? task.deps
		: [
				...task.deps,
				...task.after,
			];
}
