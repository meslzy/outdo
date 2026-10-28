// The "Writing tasks" example from skills/outdo/SKILL.md, verbatim (import path aside).
// test/unit/skill.test.ts fails when the two drift apart; tsc keeps the example honest.
// Excluded from biome (biome.json): it must stay byte-identical to the skill's example.

import { defineTasks, ns } from "~/index";
import { z } from "zod";

export default defineTasks(
	{
		fix: "bunx biome check --write",                       // one command
		sync: ["bun run syncpack:fix", "bun install"],         // commands in order
		tsc: { desc: "Type-check", run: "bunx tsc --noEmit", readonly: true },
		test: { deps: ["tsc"], run: "bun test" },              // deps run first, in parallel
		gate: { steps: ["fix", "tsc", "test"] },               // one after another
		build: { inputs: ["src/**"], outputs: ["dist/**"], run: "bun build src/index.ts --outdir dist" }, // cached
		dev: { persistent: true, ready: { port: 3000 }, run: "bun --watch src/index.ts" },
		playwright: "bunx playwright test",
		e2e: { steps: ["dev", "playwright"] },                 // server up, tests, server stopped
		shoot: { steps: ["build", "playwright"], finally: ["fix"] }, // finally runs even on failure
		feed: {
			args: {
				source: z.enum(["eco", "all"]).default("all"),   // schema flag: validated + typed
				id: { type: "string", required: true },          // or an ArgSpec
			},
			positional: ["id"],                              // outdo feed C-0007
			run: async ({ $, args, env, mode, root, log }) => {
				await $`bun scripts/feed.ts ${args.source} ${args.id}`;
			},
		},
		deploy: {
			protect: "prod",                                   // asks in prod; --yes skips
			env: z.object({ VPS_HOST: z.string() }),           // validated before anything runs
			run: async ({ ssh, env }) => {
				await ssh(`deploy@${env.VPS_HOST}`).cwd("~/app")`git pull && bunx outdo up --mode prod`;
			},
		},
		db: ns({ reset: { deps: ["backup"], run: "bun db/reset.ts" }, backup: "bun db/backup.ts" }),
	},
	{
		modes: ["dev", "prod"],                              // first is the default
		hooks: { "pre-commit": { steps: ["fix", "tsc"], restage: true } },
		members: { tsc: { deps: ["^tsc"] } },                // workspace defaults (replaces turbo)
	},
);
