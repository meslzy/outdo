/** Task model fields added after the unit-test factories were written (all "off"). */

import type { Task } from "~/core/model";

export const TASK_EXTRAS: Pick<
	Task,
	| "kind"
	| "after"
	| "steps"
	| "finally"
	| "positional"
	| "command"
	| "script"
	| "envFiles"
	| "protect"
	| "confirm"
	| "requires"
	| "readonly"
	| "destructive"
> = {
	kind: "task",
	after: [],
	steps: [],
	finally: [],
	positional: [],
	command: undefined,
	script: undefined,
	envFiles: [],
	protect: [],
	confirm: undefined,
	requires: undefined,
	readonly: false,
	destructive: false,
};
