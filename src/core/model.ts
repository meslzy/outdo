/** Internal, type-erased task model consumed by the runner. */

import type { ArgSpec, StandardSchemaV1, TaskCtx } from "~/types";

export interface Task {
	name: string;
	desc: string | undefined;
	group: string | undefined;
	deps: readonly string[];
	env: StandardSchemaV1 | undefined;
	args: Readonly<Record<string, ArgSpec>>;
	inputs: readonly string[];
	outputs: readonly string[];
	watch: readonly string[];
	persistent: boolean;
	/** Absolute working directory (resolved against the do.ts directory). */
	cwd: string;
	run: ((ctx: TaskCtx<unknown, unknown>) => unknown) | undefined;
	/** Whether the entry came from the task() builder. */
	built: boolean;
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
}
