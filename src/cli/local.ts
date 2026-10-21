/** Hand-over from a global outdo to the project's own install (cli.ts hot path: node built-ins only). */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * A global `outdo` hands over to the project's own installed copy, so the
 * repo always runs the version in its lockfile (turbo does the same). Source
 * runs (`bun src/cli.ts`) never hand over; OUTDO_NO_LOCAL=1 disables it.
 */
export function localInstall(
	entry: string | undefined,
	cwd: string,
	env: Record<string, string | undefined>,
): string | undefined {
	if (env.OUTDO_NO_LOCAL === "1" || entry === undefined) {
		return undefined;
	}
	let self: string;
	try {
		self = realpathSync(entry);
	} catch {
		return undefined;
	}
	if (self.endsWith(".ts")) {
		return undefined;
	}
	let dir = resolve(cwd);
	for (;;) {
		const candidate = join(dir, "node_modules", "@meslzy", "outdo", "dist", "cli.js");
		if (existsSync(candidate)) {
			try {
				const real = realpathSync(candidate);
				return real === self ? undefined : real;
			} catch {
				return undefined;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}
