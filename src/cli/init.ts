/** `outdo init`: scaffold a starter do.ts and gitignore the cache dir. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, OutdoError } from "~/core/errors";
import { green } from "~/core/logger";

const TEMPLATE = `import { defineTasks } from "@meslzy/outdo";

export default defineTasks({
	// A task can be one command...
	fix: "bunx biome check --write",
	tsc: "bunx tsc --noEmit",
	test: { desc: "Run tests", run: "bun test" }, // outdo test -- --watch appends args

	// ...a service...
	dev: {
		desc: "Start the dev server",
		persistent: true,
		run: "bun --watch src/index.ts",
	},

	// ...a cached build (skipped when src/ is unchanged)...
	build: {
		desc: "Build the project",
		inputs: ["src/**/*.ts"],
		outputs: ["dist/**"],
		run: "bun build src/index.ts --outdir dist",
	},

	// ...steps that run in order (outdo check --from tsc)...
	check: { desc: "Everything that must pass before a commit", steps: ["fix", "tsc", "test"] },

	// ...or a function with typed flags (and env, via a zod schema):
	// deploy: {
	// 	desc: "Deploy",
	// 	args: { dry: { type: "boolean", short: "d" } },
	// 	protect: true, // asks before running; --yes skips the question
	// 	run: async ({ $, args }) => { ... },
	// },
});
`;

export async function initCommand(): Promise<number> {
	const target = join(process.cwd(), "do.ts");
	if (existsSync(target)) {
		throw new OutdoError("usage", `${target} already exists — refusing to overwrite.`);
	}
	await Bun.write(target, TEMPLATE);
	console.log(`${green("✓")} created do.ts`);

	const gitignore = join(process.cwd(), ".gitignore");
	if (existsSync(gitignore)) {
		const text = readFileSync(gitignore, "utf8");
		if (!text.includes(".outdo")) {
			await Bun.write(gitignore, `${text.trimEnd()}\n.outdo/\n`);
			console.log(`${green("✓")} added .outdo/ to .gitignore`);
		}
	} else {
		await Bun.write(gitignore, ".outdo/\n");
		console.log(`${green("✓")} created .gitignore with .outdo/`);
	}

	console.log('\nrun "outdo" to list tasks.');
	return EXIT.ok;
}
