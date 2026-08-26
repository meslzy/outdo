/**
 * Fingerprint cache: skip a task when nothing it depends on has changed.
 *
 * fingerprint = hash(version, component hashes, sorted input content digests)
 * where the named components cover the task definition (incl. run body text),
 * validated env output, args + rest, dep fingerprints, and dep data outputs.
 * Component hashes are persisted in the manifest so `outdo explain` can name
 * exactly what changed. Content hashing uses an mtime+size fast path per file
 * (wireit-style correctness at go-task speed). State lives in .outdo/cache/
 * at the repo root.
 */

import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { allPatternsMatchSomething, expand } from "~/core/globs";
import { debugLog } from "~/core/logger";
import type { Task } from "~/core/model";

const CACHE_VERSION = 3;

interface FileEntry {
	m: number; // mtimeMs
	s: number; // size
	h: string; // content hash
}

/** Named fingerprint components — the diagnosable "why did this miss" units. */
export interface ComponentHashes {
	def: string;
	env: string;
	args: string;
	rest: string;
	deps: string;
	depOutputs: string;
}

interface Manifest {
	version: number;
	fingerprint: string;
	components: ComponentHashes;
	files: Record<string, FileEntry>;
	/** JSON data output of the last successful run (replayed on a hit). */
	output?: unknown;
}

export interface CacheDecision {
	/** True when the task can be skipped. */
	hit: boolean;
	/** Fingerprint to store after a successful run. */
	fingerprint: string;
	components: ComponentHashes;
	files: Record<string, FileEntry>;
	/** Data output persisted by the previous run (defined only on a hit). */
	previousOutput: unknown;
}

export type MissReason =
	| {
			kind: "no-manifest";
	  }
	| {
			kind: "forced";
	  }
	| {
			kind: "def-changed";
	  }
	| {
			kind: "env-changed";
	  }
	| {
			kind: "args-changed";
	  }
	| {
			kind: "rest-changed";
	  }
	| {
			kind: "deps-changed";
	  }
	| {
			kind: "dep-outputs-changed";
	  }
	| {
			kind: "inputs-changed";
			added: string[];
			removed: string[];
			modified: string[];
	  }
	| {
			kind: "outputs-missing";
	  };

export interface CacheDiagnosis extends CacheDecision {
	reasons: MissReason[];
}

function hashText(text: string): string {
	return Bun.hash.xxHash64(text).toString(16);
}

async function hashFile(path: string): Promise<string> {
	const buffer = await Bun.file(path).arrayBuffer();
	return Bun.hash.xxHash64(buffer).toString(16);
}

function cacheDir(rootDir: string): string {
	return join(rootDir, ".outdo", "cache");
}

function manifestPath(rootDir: string, taskName: string): string {
	return join(cacheDir(rootDir), `${hashText(taskName)}.json`);
}

async function readManifest(rootDir: string, taskName: string): Promise<Manifest | undefined> {
	try {
		const manifest = (await Bun.file(manifestPath(rootDir, taskName)).json()) as Manifest;
		return manifest.version === CACHE_VERSION ? manifest : undefined;
	} catch {
		return undefined;
	}
}

/** A task participates in caching iff it declares inputs and is not a service. */
export function cacheable(task: Task): boolean {
	return task.inputs.length > 0 && !task.persistent && task.run !== undefined;
}

export interface FingerprintInputs {
	envOutput: unknown;
	args: Record<string, string | boolean | undefined>;
	rest: string[];
	/** Fingerprints of this task's dependencies (topo order guarantees presence). */
	depFingerprints: readonly string[];
	/** JSON-stringified dep data outputs, aligned with depFingerprints. */
	depOutputs: readonly string[];
}

interface Computed {
	fingerprint: string;
	components: ComponentHashes;
	files: Record<string, FileEntry>;
}

async function computeFingerprint(
	task: Task,
	inputs: FingerprintInputs,
	previous: Manifest | undefined,
): Promise<Computed> {
	const files: Record<string, FileEntry> = {};
	const digests: string[] = [];

	for (const relPath of await expand(task.inputs, task.cwd)) {
		const absPath = join(task.cwd, relPath);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(absPath);
		} catch {
			continue; // deleted between scan and stat
		}
		const prior = previous?.files[relPath];
		let entry: FileEntry;
		if (prior !== undefined && prior.m === stat.mtimeMs && prior.s === stat.size) {
			entry = prior;
		} else {
			try {
				entry = {
					m: stat.mtimeMs,
					s: stat.size,
					h: await hashFile(absPath),
				};
			} catch {
				continue; // deleted/locked between stat and read — treat like the stat race
			}
		}
		files[relPath] = entry;
		digests.push(`${relPath} ${entry.h}`);
	}

	const defText = JSON.stringify({
		name: task.name,
		deps: task.deps,
		inputs: task.inputs,
		outputs: task.outputs,
		cwd: task.cwd,
		run: task.run?.toString() ?? "",
	});
	const components: ComponentHashes = {
		def: hashText(defText),
		env: hashText(JSON.stringify(inputs.envOutput ?? null)),
		args: hashText(JSON.stringify(inputs.args)),
		rest: hashText(JSON.stringify(inputs.rest)),
		deps: hashText(inputs.depFingerprints.join("\n")),
		depOutputs: hashText(inputs.depOutputs.join("\n")),
	};
	// JSON-encode the pre-image: every part is unambiguously delimited, so no
	// crafted filename or hash prefix can collide two different states into
	// the same fingerprint (join("") had constructible collisions).
	const fingerprint = hashText(
		JSON.stringify([
			CACHE_VERSION,
			components,
			digests,
		]),
	);
	return {
		fingerprint,
		components,
		files,
	};
}

/**
 * Compute the current fingerprint and decide hit/miss. `previous` manifests'
 * mtime+size fast path avoids re-hashing unchanged files.
 */
export async function checkCache(
	rootDir: string,
	task: Task,
	inputs: FingerprintInputs,
	force: boolean,
): Promise<CacheDecision> {
	const previous = force ? undefined : await readManifest(rootDir, task.name);
	const current = await computeFingerprint(task, inputs, previous);

	let hit = previous !== undefined && previous.fingerprint === current.fingerprint;
	if (hit && task.outputs.length > 0) {
		hit = await allPatternsMatchSomething(task.outputs, task.cwd);
		if (!hit) {
			debugLog(`cache: outputs missing for ${task.name}`);
		}
	}
	return {
		hit,
		fingerprint: current.fingerprint,
		components: current.components,
		files: current.files,
		previousOutput: hit ? previous?.output : undefined,
	};
}

/**
 * Like checkCache, but explains a miss: reads the manifest even under --force
 * and names every changed component. Used by `outdo explain`; the run path
 * stays on the leaner checkCache.
 */
export async function diagnoseCache(
	rootDir: string,
	task: Task,
	inputs: FingerprintInputs,
	force: boolean,
): Promise<CacheDiagnosis> {
	const previous = await readManifest(rootDir, task.name);
	const current = await computeFingerprint(task, inputs, previous);
	const reasons: MissReason[] = [];

	if (force) {
		reasons.push({
			kind: "forced",
		});
	}
	if (previous === undefined) {
		reasons.push({
			kind: "no-manifest",
		});
	} else {
		for (const key of [
			"def",
			"env",
			"args",
			"rest",
			"deps",
			"depOutputs",
		] as const) {
			if (previous.components[key] !== current.components[key]) {
				reasons.push({
					kind:
						key === "depOutputs"
							? "dep-outputs-changed"
							: (`${key}-changed` as "def-changed" | "env-changed" | "args-changed" | "rest-changed" | "deps-changed"),
				});
			}
		}
		const added: string[] = [];
		const removed: string[] = [];
		const modified: string[] = [];
		for (const [rel, entry] of Object.entries(current.files)) {
			const prior = previous.files[rel];
			if (prior === undefined) {
				added.push(rel);
			} else if (prior.h !== entry.h) {
				modified.push(rel);
			}
		}
		for (const rel of Object.keys(previous.files)) {
			if (current.files[rel] === undefined) {
				removed.push(rel);
			}
		}
		if (added.length > 0 || removed.length > 0 || modified.length > 0) {
			reasons.push({
				kind: "inputs-changed",
				added,
				removed,
				modified,
			});
		}
	}

	let outputsOk = true;
	const fingerprintMatch = previous !== undefined && previous.fingerprint === current.fingerprint;
	if (fingerprintMatch && task.outputs.length > 0) {
		outputsOk = await allPatternsMatchSomething(task.outputs, task.cwd);
		if (!outputsOk) {
			reasons.push({
				kind: "outputs-missing",
			});
		}
	}
	const hit = !force && fingerprintMatch && outputsOk;
	return {
		hit,
		fingerprint: current.fingerprint,
		components: current.components,
		files: current.files,
		previousOutput: hit ? previous?.output : undefined,
		reasons,
	};
}

/**
 * Persist the manifest after a successful run. Never throws: an unwritable
 * .outdo (read-only checkout, full disk) must not turn a green task into a
 * failure — the task simply stays uncached.
 */
export async function writeCache(
	rootDir: string,
	task: Task,
	decision: CacheDecision,
	output?: unknown,
): Promise<void> {
	try {
		mkdirSync(cacheDir(rootDir), {
			recursive: true,
		});
		const manifest: Manifest = {
			version: CACHE_VERSION,
			fingerprint: decision.fingerprint,
			components: decision.components,
			files: decision.files,
			...(output === undefined
				? {}
				: {
						output,
					}),
		};
		await Bun.write(manifestPath(rootDir, task.name), JSON.stringify(manifest));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`warning: could not write cache for ${task.name} (${message}) — result not cached`);
	}
}
