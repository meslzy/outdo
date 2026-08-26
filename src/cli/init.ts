/** `outdo init`: scaffold a starter do.ts and gitignore the cache dir. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, OutdoError } from "~/core/errors";
import { green } from "~/core/logger";

const TEMPLATE = `import { defineTasks, task } from "outdo";

export default defineTasks({
	dev: {
		desc: "Start the dev server",
		persistent: true,
		run: async ({ $ }) => {
			await $\`bun --watch src/index.ts\`;
		},
	},
	build: {
		desc: "Build the project",
		inputs: ["src/**/*.ts"],
		outputs: ["dist/**"],
		run: async ({ $ }) => {
			await $\`bun build src/index.ts --outdir dist\`;
		},
	},
	test: {
		desc: "Run tests",
		deps: ["build"],
		run: async ({ $ }) => {
			await $\`bun test\`;
		},
	},

	// Typed env + flags need the task() builder:
	//
	// deploy: task({
	// 	desc: "Deploy to production",
	// 	env: z.object({ DEPLOY_TOKEN: z.string() }),
	// 	args: { dry: { type: "boolean", short: "d" } },
	// 	run: async ({ $, env, args }) => { ... },
	// }),
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
