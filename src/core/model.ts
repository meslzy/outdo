/** Internal, type-erased task model consumed by the runner. */

import type { WorkspaceMember } from "~/core/workspaces";
import type { ArgSpec, ReadyProbe, RetrySpec, StandardSchemaV1, TaskCtx } from "~/types";

/** One declared dependency edge (optional-missing edges are pruned at load). */
export interface DepEdge {
	task: string;
	optional: boolean;
	/** Env-var name (truthy check) or predicate; undefined = unconditional. */
	condition: string | ((env: Readonly<Record<string, string | undefined>>) => boolean) | undefined;
}

export interface Task {
	name: string;
	desc: string | undefined;
	group: string | undefined;
	/**
	 * Dependency names. At load time this is every declared edge; the run
	 * pipeline replaces it with the condition-filtered active set
	 * (`applyConditions`) so all downstream consumers stay edge-agnostic.
	 */
	deps: readonly string[];
	/** All declared edges (for graph rendering and condition evaluation). */
	depEdges: readonly DepEdge[];
	env: StandardSchemaV1 | undefined;
	args: Readonly<Record<string, ArgSpec>>;
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
	/** The do.ts file this task was defined in. */
	sourceConfig: string;
	/** Name within its own do.ts (differs from name for workspace tasks). */
	localName: string;
}

export interface Project {
	/** Absolute path of the loaded do.ts. */
	configPath: string;
	/** Directory containing do.ts. */
	rootDir: string;
	tasks: ReadonlyMap<string, Task>;
	/** Workspace members (workspace mode only). */
	members?: readonly WorkspaceMember[];
}
