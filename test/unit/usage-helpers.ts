/** A small in-memory project for the usage unit tests. */

import { join } from "node:path";
import { normalizeEntry, withStepEdges } from "~/core/config";
import type { HookSpec, Project, Task } from "~/core/model";

export const ROOT = join(process.cwd(), "test", "fixtures", "usage-unit");

export function doTask(name: string, raw: unknown): Task {
	const task = normalizeEntry(name, raw, {
		configPath: join(ROOT, "do.ts"),
		baseDir: ROOT,
		kind: "task",
	});
	withStepEdges(task);
	return task;
}

export function scriptTask(name: string, command: string): Task {
	return {
		...doTask(name, {}),
		kind: "script",
		desc: command,
		script: name,
		sourceConfig: join(ROOT, "package.json"),
	};
}

export function project(tasks: Task[], extra: Partial<Project> = {}): Project {
	return {
		configPath: join(ROOT, "do.ts"),
		rootDir: ROOT,
		tasks: new Map(
			tasks.map((t) => [
				t.name,
				t,
			]),
		),
		modes: [],
		hooks: new Map<string, HookSpec>(),
		sources: [],
		...extra,
	};
}
