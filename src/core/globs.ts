/**
 * Glob helpers over Bun.Glob with leading-`!` negation (Bun.Glob itself only
 * supports negation at the start of a pattern's own syntax; we implement the
 * conventional partition semantics here). This module is the swap seam if
 * Bun.Glob matching ever falls short (picomatch would slot in behind it).
 */

import { Glob } from "bun";

export interface GlobSet {
	positive: Glob[];
	negative: Glob[];
}

export function compile(patterns: readonly string[]): GlobSet {
	const positive: Glob[] = [];
	const negative: Glob[] = [];
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) {
			negative.push(new Glob(pattern.slice(1)));
		} else {
			positive.push(new Glob(pattern));
		}
	}
	return {
		positive,
		negative,
	};
}

export function matches(set: GlobSet, path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	return set.positive.some((g) => g.match(normalized)) && !set.negative.some((g) => g.match(normalized));
}

/** Expand patterns into a sorted list of matching files, relative to cwd. */
export async function expand(patterns: readonly string[], cwd: string): Promise<string[]> {
	const set = compile(patterns);
	const seen = new Set<string>();
	for (const glob of set.positive) {
		for await (const path of glob.scan({
			cwd,
			onlyFiles: true,
			dot: false,
		})) {
			const normalized = path.replaceAll("\\", "/");
			if (!set.negative.some((g) => g.match(normalized))) {
				seen.add(normalized);
			}
		}
	}
	return [
		...seen,
	].sort();
}

/** True when every positive pattern matches at least one existing file. */
export async function allPatternsMatchSomething(patterns: readonly string[], cwd: string): Promise<boolean> {
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) {
			continue;
		}
		const glob = new Glob(pattern);
		const iter = glob.scan({
			cwd,
			onlyFiles: true,
			dot: false,
		});
		const first = await iter.next();
		if (first.done === true) {
			return false;
		}
	}
	return true;
}

const GLOB_CHARS = /[*?[\]{}!]/;

/** Static directory prefixes of patterns — the roots a watcher should observe. */
export function staticRoots(patterns: readonly string[]): string[] {
	const roots = new Set<string>();
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) {
			continue;
		}
		const parts = pattern.replaceAll("\\", "/").split("/");
		const staticParts: string[] = [];
		for (const part of parts) {
			if (GLOB_CHARS.test(part)) {
				break;
			}
			staticParts.push(part);
		}
		// Drop a trailing filename component (last static part with an extension).
		if (staticParts.length === parts.length && staticParts.length > 0) {
			staticParts.pop();
		}
		roots.add(staticParts.join("/") || ".");
	}
	// Deduplicate nested roots (keep outermost).
	const sorted = [
		...roots,
	].sort();
	const out: string[] = [];
	for (const root of sorted) {
		if (!out.some((existing) => root === existing || root.startsWith(`${existing}/`))) {
			out.push(root);
		}
	}
	return out;
}
