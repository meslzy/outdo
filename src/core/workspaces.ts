/**
 * Bun workspace awareness. There is no programmatic enumeration API in Bun,
 * so we read the root package.json `workspaces` globs, expand them with
 * Bun.Glob, and read each member's package.json ourselves.
 *
 * Filter microsyntax (subset of turbo's):
 *   name        exact package name        api
 *   glob        name glob                 @acme/*
 *   ./dir       path prefix from root     ./packages/api
 *   ...name     name + its workspace dependencies (transitive)
 *   name...     name + its workspace dependents (transitive)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Glob } from "bun";
import { BundoError } from "~/core/errors";

interface PackageJson {
	name?: string;
	workspaces?:
		| string[]
		| {
				packages?: string[];
		  };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

export interface WorkspaceMember {
	name: string;
	/** Absolute directory. */
	dir: string;
	/** Workspace-internal dependency package names. */
	deps: string[];
}

export interface WorkspaceRoot {
	rootDir: string;
	patterns: string[];
}

function readPkg(path: string): PackageJson | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
	} catch {
		return undefined;
	}
}

/**
 * Extract valid workspace glob patterns from a parsed package.json. The single
 * source of truth for "is this a workspace root" — findConfig's upward walk
 * must agree with findWorkspaceRoot, or bundo reports "no do.ts" when the real
 * one sits above a package.json with a malformed `workspaces` key.
 */
export function workspacePatternsOf(pkg: unknown): string[] | undefined {
	const raw = (pkg as PackageJson | null | undefined)?.workspaces;
	const patterns = Array.isArray(raw) ? raw : raw?.packages;
	return Array.isArray(patterns) && patterns.every((p) => typeof p === "string") ? patterns : undefined;
}

/** Nearest ancestor (including startDir) whose package.json declares workspaces. */
export function findWorkspaceRoot(startDir: string): WorkspaceRoot | undefined {
	let dir = resolve(startDir);
	for (;;) {
		const patterns = workspacePatternsOf(readPkg(join(dir, "package.json")));
		if (patterns !== undefined) {
			return {
				rootDir: dir,
				patterns,
			};
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

export async function enumerateMembers(root: WorkspaceRoot): Promise<WorkspaceMember[]> {
	const dirs = new Set<string>();
	const exclusions = root.patterns.filter((p) => p.startsWith("!")).map((p) => new Glob(p.slice(1)));
	for (const pattern of root.patterns) {
		if (pattern.startsWith("!")) {
			continue;
		}
		const glob = new Glob(pattern.endsWith("/") ? pattern.slice(0, -1) : pattern);
		for await (const path of glob.scan({
			cwd: root.rootDir,
			onlyFiles: false,
		})) {
			const rel = path.replaceAll("\\", "/");
			if (exclusions.some((g) => g.match(rel))) {
				continue;
			}
			const abs = join(root.rootDir, rel);
			if (existsSync(join(abs, "package.json"))) {
				dirs.add(abs);
			}
		}
	}

	const members: WorkspaceMember[] = [];
	for (const dir of [
		...dirs,
	].sort()) {
		const pkg = readPkg(join(dir, "package.json"));
		if (pkg?.name === undefined) {
			continue;
		}
		members.push({
			name: pkg.name,
			dir,
			deps: Object.keys({
				...pkg.dependencies,
				...pkg.devDependencies,
				...pkg.peerDependencies,
			}),
		});
	}
	// Keep only workspace-internal deps.
	const names = new Set(members.map((m) => m.name));
	for (const member of members) {
		member.deps = member.deps.filter((dep) => names.has(dep));
	}
	return members;
}

export function applyFilters(
	members: WorkspaceMember[],
	filters: readonly string[],
	rootDir: string,
): WorkspaceMember[] {
	if (filters.length === 0) {
		return members;
	}
	const byName = new Map(
		members.map((m) => [
			m.name,
			m,
		]),
	);
	const dependentsOf = new Map<string, Set<string>>();
	for (const member of members) {
		for (const dep of member.deps) {
			let set = dependentsOf.get(dep);
			if (!set) {
				set = new Set();
				dependentsOf.set(dep, set);
			}
			set.add(member.name);
		}
	}

	const selected = new Set<string>();
	const addWithClosure = (name: string, edges: (n: string) => Iterable<string>): void => {
		if (selected.has(name)) {
			return;
		}
		selected.add(name);
		for (const next of edges(name)) {
			addWithClosure(next, edges);
		}
	};

	for (const filter of filters) {
		if (filter.startsWith("./") || filter.startsWith(".\\")) {
			// Path prefix: the member dir must live at or below the target dir.
			const target = resolve(rootDir, filter);
			for (const member of members) {
				const rel = relative(target, member.dir);
				if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
					selected.add(member.name);
				}
			}
			continue;
		}
		if (filter.startsWith("...")) {
			const name = filter.slice(3);
			if (byName.has(name)) {
				addWithClosure(name, (n) => byName.get(n)?.deps ?? []);
			}
			continue;
		}
		if (filter.endsWith("...")) {
			const name = filter.slice(0, -3);
			if (byName.has(name)) {
				addWithClosure(name, (n) => dependentsOf.get(n) ?? []);
			}
			continue;
		}
		if (filter.includes("*")) {
			const glob = new Glob(filter);
			for (const member of members) {
				if (glob.match(member.name)) {
					selected.add(member.name);
				}
			}
			continue;
		}
		if (byName.has(filter)) {
			selected.add(filter);
		}
	}

	const result = members.filter((m) => selected.has(m.name));
	if (result.length === 0) {
		throw new BundoError("usage", `--filter ${filters.join(" ")} matched no workspace packages.`, {
			filters,
		});
	}
	return result;
}
