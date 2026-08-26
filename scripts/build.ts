/**
 * Build for publishing: bundle the CLI and library for Bun with code-split
 * lazy chunks, then emit type declarations for the public surface.
 */

import { rmSync } from "node:fs";
import { $ } from "bun";

rmSync("dist", {
	recursive: true,
	force: true,
});

const result = await Bun.build({
	entrypoints: [
		"src/cli.ts",
		"src/index.ts",
	],
	outdir: "dist",
	target: "bun",
	splitting: true,
	sourcemap: "linked",
});
if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

// The bin entry must carry the bun shebang (bun install writes shims from it).
const cliPath = "dist/cli.js";
const cli = await Bun.file(cliPath).text();
if (!cli.startsWith("#!")) {
	await Bun.write(cliPath, `#!/usr/bin/env bun\n${cli}`);
}

await $`bunx tsc -p tsconfig.build.json`;

console.log("built dist/");
