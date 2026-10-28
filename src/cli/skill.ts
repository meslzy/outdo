/**
 * `outdo skill install [--global]` — copy the agent skill that ships with
 * outdo (skills/outdo, Vercel skills layout) into `.claude/skills/outdo` of
 * the repo, or of the home directory with --global. `outdo skill path` prints
 * where the bundled copy lives. (`bunx skills add meslzy/outdo` works too.)
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { loadProjectFromCwd } from "~/cli/load";
import { EXIT, OutdoError } from "~/core/errors";
import { dim, green } from "~/core/logger";

/** The skill directory next to the running CLI (src/ in a checkout, dist/ when installed). */
export function bundledSkill(entry: string = process.argv[1] as string): string {
	return join(dirname(resolve(entry)), "..", "skills", "outdo");
}

export async function skillCommand(action: "install" | "path", global: boolean): Promise<number> {
	const source = bundledSkill();
	if (!existsSync(join(source, "SKILL.md"))) {
		throw new OutdoError("config-not-found", `The bundled skill is missing (${source}).`);
	}
	if (action === "path") {
		console.log(source);
		return EXIT.ok;
	}
	const base = global ? homedir() : ((await loadProjectFromCwd().catch(() => undefined))?.rootDir ?? process.cwd());
	const target = join(base, ".claude", "skills", "outdo");
	rmSync(target, {
		recursive: true,
		force: true,
	});
	mkdirSync(dirname(target), {
		recursive: true,
	});
	cpSync(source, target, {
		recursive: true,
	});
	const shown = global ? target : relative(process.cwd(), target) || target;
	console.log(`${green("✓")} installed the outdo skill in ${shown.replaceAll("\\", "/")}`);
	console.log(dim("  other agents: bunx skills add meslzy/outdo"));
	return EXIT.ok;
}
