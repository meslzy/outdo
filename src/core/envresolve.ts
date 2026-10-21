/**
 * Env cascade resolution with per-key provenance, plus Standard Schema
 * validation for tasks that declare an `env` schema.
 *
 * Cascade (lowest to highest precedence), matching Bun's loader:
 *   .env -> .env.{NODE_ENV} -> .env.local -> .env.{NODE_ENV}.local -> process
 * `.env.local` is skipped when NODE_ENV=test. When the project declares
 * modes, the active --mode takes NODE_ENV's place in the file names. A task's
 * `envFiles` layer on top (each file, then its `.<mode>` variant); the
 * process env still wins over every file.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { expandValue, parseEnvFile } from "~/core/envfile";
import { OutdoError } from "~/core/errors";
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
	/** Values from files only (no process env), for layering task env files. */
	fileValues: Record<string, string>;
	/** The process env the files were resolved against (it wins over every file). */
	processEnv: Record<string, string | undefined>;
}

export function cascadeFileNames(nodeEnv: string, skipLocal = nodeEnv === "test"): string[] {
	const files = [
		".env",
		`.env.${nodeEnv}`,
	];
	if (!skipLocal) {
		files.push(".env.local");
	}
	files.push(`.env.${nodeEnv}.local`);
	return files;
}

export function resolveEnv(
	rootDir: string,
	processEnv: Record<string, string | undefined> = process.env,
	mode?: string,
): ResolvedEnv {
	const nodeEnv = processEnv.NODE_ENV ?? "development";
	const envName = mode !== undefined && mode !== "" ? mode : nodeEnv;
	const keys = new Map<string, ResolvedKey>();
	const merged: Record<string, string> = {};
	const loadedFiles: string[] = [];

	for (const fileName of cascadeFileNames(envName, nodeEnv === "test")) {
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
		fileValues: merged,
		processEnv,
	};
}

/**
 * Layer a task's own env files over a resolved cascade: `.env.platform` then
 * `.env.platform.<mode>`. Missing files are skipped. Provenance names are
 * relative to `rootDir`.
 */
export function layerEnvFiles(base: ResolvedEnv, files: readonly string[], mode: string, rootDir: string): ResolvedEnv {
	if (files.length === 0) {
		return base;
	}
	const keys = new Map(base.keys);
	const merged: Record<string, string> = {
		...base.fileValues,
	};
	const loadedFiles = [
		...base.loadedFiles,
	];
	const paths = files.flatMap((file) =>
		mode === ""
			? [
					file,
				]
			: [
					file,
					`${file}.${mode}`,
				],
	);
	for (const path of paths) {
		if (!existsSync(path)) {
			continue;
		}
		const name = relative(rootDir, path).replaceAll("\\", "/") || basename(path);
		loadedFiles.push(name);
		for (const [key, entry] of parseEnvFile(readFileSync(path, "utf8"))) {
			const value = expandValue(entry.value, (n) => merged[n] ?? base.processEnv[n]);
			const existing = keys.get(key);
			const fromProcess = base.processEnv[key];
			if (fromProcess !== undefined && fromProcess !== value) {
				keys.set(key, {
					value: fromProcess,
					source: "process",
					overrides: [
						...(existing?.source === "process"
							? existing.overrides
							: existing
								? [
										...existing.overrides,
										existing.source,
									]
								: []),
						name,
					],
				});
			} else {
				keys.set(key, {
					value,
					source: name,
					overrides: existing
						? [
								...existing.overrides,
								existing.source,
							]
						: [],
				});
			}
			merged[key] = value;
		}
	}
	return {
		env: {
			...merged,
			...base.processEnv,
		},
		keys,
		loadedFiles,
		fileValues: merged,
		processEnv: base.processEnv,
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
 * Throws a single OutdoError aggregating all issues.
 */
export async function validateAll(
	tasks: Task[],
	envFor: (task: Task) => Record<string, string | undefined>,
): Promise<Map<string, unknown>> {
	const outputs = new Map<string, unknown>();
	const issues: EnvIssue[] = [];
	for (const task of tasks) {
		const result = await validateTaskEnv(task, envFor(task));
		if (result.issues.length > 0) {
			issues.push(...result.issues);
		} else {
			outputs.set(task.name, result.value);
		}
	}
	if (issues.length > 0) {
		const lines = issues.map((i) => `  ${i.task}: ${i.path === "" ? "" : `${i.path} — `}${i.message}`);
		throw new OutdoError("env-invalid", `Environment validation failed:\n${lines.join("\n")}`, {
			issues,
		});
	}
	return outputs;
}
