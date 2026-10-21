/**
 * `outdo prune --docker` — the dependency layer of a Docker build: the root
 * package.json, every workspace member's package.json at its own path, and
 * the lockfile, copied into `<out>/json/`. The Dockerfile then stays fixed:
 *
 *   COPY out/json/ ./
 *   RUN bun install --frozen-lockfile
 *   COPY . .
 *
 * No do.ts is loaded (it may import things that are not installed yet).
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { EXIT, OutdoError } from "~/core/errors";
import { dim, green } from "~/core/logger";
import { enumerateMembers, findWorkspaceRoot } from "~/core/workspaces";

/** Root-level files bun install reads besides package.json. */
const ROOT_FILES = [
	"bun.lock",
	"bun.lockb",
	"bunfig.toml",
	".npmrc",
];

function nearestPackageDir(start: string): string | undefined {
	let dir = resolve(start);
	for (;;) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

export async function pruneCommand(out: string): Promise<number> {
	const ws = findWorkspaceRoot(process.cwd());
	const rootDir = ws?.rootDir ?? nearestPackageDir(process.cwd());
	if (rootDir === undefined) {
		throw new OutdoError("config-not-found", "prune: no package.json found in this directory or any parent.");
	}
	const outDir = resolve(rootDir, out, "json");
	rmSync(outDir, {
		recursive: true,
		force: true,
	});

	const files = [
		"package.json",
		...ROOT_FILES.filter((name) => existsSync(join(rootDir, name))),
	];
	if (ws !== undefined) {
		for (const member of await enumerateMembers(ws)) {
			files.push(relative(rootDir, join(member.dir, "package.json")));
		}
	}
	for (const rel of files) {
		const to = join(outDir, rel);
		mkdirSync(dirname(to), {
			recursive: true,
		});
		copyFileSync(join(rootDir, rel), to);
	}
	const shown = relative(process.cwd(), outDir).replaceAll("\\", "/") || ".";
	console.log(`${green("✓")} ${shown}/ ${dim(`(${files.length} files)`)}`);
	for (const rel of files) {
		console.log(dim(`  ${rel.replaceAll("\\", "/")}`));
	}
	return EXIT.ok;
}
