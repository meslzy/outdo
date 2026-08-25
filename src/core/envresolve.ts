/**
 * Env cascade resolution with per-key provenance, plus Standard Schema
 * validation for tasks that declare an `env` schema.
 *
 * Cascade (lowest to highest precedence), matching Bun's loader:
 *   .env -> .env.{NODE_ENV} -> .env.local -> .env.{NODE_ENV}.local -> process
 * `.env.local` is skipped when NODE_ENV=test.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandValue, parseEnvFile } from "~/core/envfile";
import { BundoError } from "~/core/errors";
import type { Task } from "~/core/model";
import type { StandardSchemaV1 } from "~/types";

export interface ResolvedKey {
	value: string;
	/** File (relative name) or "process" that supplied the winning value. */
	source: string;
	/** Sources that were overridden, lowest first. */
	overrides: string[];
}

export interface ResolvedEnv {
	/** Full merged environment: process.env over the dotenv cascade. */
	env: Record<string, string | undefined>;
	/** Provenance for keys that came from dotenv files or were shadowed. */
	keys: Map<string, ResolvedKey>;
	/** Cascade files that existed and were loaded, in load order. */
	loadedFiles: string[];
}

export function cascadeFileNames(nodeEnv: string): string[] {
	const files = [
		".env",
		`.env.${nodeEnv}`,
	];
	if (nodeEnv !== "test") {
		files.push(".env.local");
	}
	files.push(`.env.${nodeEnv}.local`);
	return files;
}

export function resolveEnv(rootDir: string, processEnv: Record<string, string | undefined> = process.env): ResolvedEnv {
	const nodeEnv = processEnv.NODE_ENV ?? "development";
	const keys = new Map<string, ResolvedKey>();
	const merged: Record<string, string> = {};
	const loadedFiles: string[] = [];

	for (const fileName of cascadeFileNames(nodeEnv)) {
		const filePath = join(rootDir, fileName);
		if (!existsSync(filePath)) {
			continue;
		}
		loadedFiles.push(fileName);
		const entries = parseEnvFile(readFileSync(filePath, "utf8"));
		for (const [key, entry] of entries) {
			const lookup = (name: string): string | undefined => merged[name] ?? processEnv[name];
			const value = expandValue(entry.value, lookup);
			const existing = keys.get(key);
			keys.set(key, {
				value,
				source: fileName,
				overrides: existing
					? [
							...existing.overrides,
							existing.source,
						]
					: [],
			});
			merged[key] = value;
		}
	}

	// Real process env wins over every file.
	for (const [key, resolved] of keys) {
		const fromProcess = processEnv[key];
		if (fromProcess !== undefined && fromProcess !== resolved.value) {
			keys.set(key, {
				value: fromProcess,
				source: "process",
				overrides: [
					...resolved.overrides,
					resolved.source,
				],
			});
		}
	}

	const env: Record<string, string | undefined> = {
		...merged,
		...processEnv,
	};
	return {
		env,
		keys,
		loadedFiles,
	};
}

export interface EnvIssue {
	task: string;
	path: string;
	message: string;
}

/** Validate one task's schema against the merged env. Returns the schema output. */
export async function validateTaskEnv(
	task: Task,
	env: Record<string, string | undefined>,
): Promise<{
	value?: unknown;
	issues: EnvIssue[];
}> {
	const schema = task.env;
	if (!schema) {
		return {
			value: env,
			issues: [],
		};
	}
	const result = await (schema as StandardSchemaV1)["~standard"].validate(env);
	if (result.issues === undefined) {
		return {
			value: result.value,
			issues: [],
		};
	}
	return {
		issues: result.issues.map((issue) => ({
			task: task.name,
			path: (issue.path ?? [])
				.map((segment) =>
					String(typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment),
				)
				.join("."),
			message: issue.message,
		})),
	};
}

/**
 * Validate every schema-declaring task in the run set before anything spawns.
 * Throws a single BundoError aggregating all issues.
 */
export async function validateAll(
	tasks: Task[],
	env: Record<string, string | undefined>,
): Promise<Map<string, unknown>> {
	const outputs = new Map<string, unknown>();
	const issues: EnvIssue[] = [];
	for (const task of tasks) {
		const result = await validateTaskEnv(task, env);
		if (result.issues.length > 0) {
			issues.push(...result.issues);
		} else {
			outputs.set(task.name, result.value);
		}
	}
	if (issues.length > 0) {
		const lines = issues.map((i) => `  ${i.task}: ${i.path === "" ? "" : `${i.path} — `}${i.message}`);
		throw new BundoError("env-invalid", `Environment validation failed:\n${lines.join("\n")}`, {
			issues,
		});
	}
	return outputs;
}
