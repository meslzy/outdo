/**
 * Compile-time assertions for the big-release authoring surface: one-line
 * command tasks, inline env/args typing (no task()), schema flags, choices,
 * steps/finally name checks, modes, namespaces. Gated by `tsc --noEmit`.
 */

import { z } from "zod";
import type { RawEnv, Shell } from "~/index";
import { defineTasks, from, ns, task } from "~/index";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare function assertTrue<T extends true>(): void;

const version = task({
	run: () => ({
		tag: "1.2.3",
	}),
});

// --- 1. commands, inline typing, schema flags, modes ---------------------------
const tasks = defineTasks(
	{
		fix: "bunx biome check --write",
		syncpack: {
			deps: [
				"fix",
			],
			run: [
				"bun run syncpack:fix",
				"bun install",
			],
		},
		tsc: {
			desc: "Type-check",
			run: "bun run tsc",
		},
		version,
		deploy: {
			deps: [
				"tsc",
				from("version", version),
			],
			env: z.object({
				URL: z.url(),
				RETRIES: z.coerce.number().default(3),
			}),
			args: {
				dry: {
					type: "boolean",
				},
				name: {
					type: "string",
					required: true,
				},
				tag: {
					type: "string",
				},
				pick: {
					type: "string",
					choices: [
						"x",
						"y",
					],
					default: "x",
				},
				source: z
					.enum([
						"a",
						"b",
					])
					.default("a"),
				runs: z.coerce.number().int().min(1).default(1),
			},
			positional: [
				"name",
			],
			protect: "prod",
			run: async ({ $, env, args, deps, mode, root, ssh }) => {
				assertTrue<Equal<typeof $, Shell>>();
				assertTrue<Equal<typeof env.URL, string>>();
				assertTrue<Equal<typeof env.RETRIES, number>>();
				assertTrue<Equal<typeof args.dry, boolean>>();
				assertTrue<Equal<typeof args.name, string>>();
				assertTrue<Equal<typeof args.tag, string | undefined>>();
				assertTrue<Equal<typeof args.pick, "x" | "y">>();
				assertTrue<Equal<typeof args.source, "a" | "b">>();
				assertTrue<Equal<typeof args.runs, number>>();
				assertTrue<Equal<typeof deps.version.tag, string>>();
				assertTrue<Equal<typeof mode, "dev" | "prod">>();
				assertTrue<Equal<typeof root, string>>();
				const vps = ssh("me@vps").cwd("~/app");
				const result = await vps`git pull ${[
					"--ff-only",
				]}`;
				assertTrue<Equal<typeof result.exitCode, number>>();
				// @ts-expect-error — not part of the env schema output
				env.NOPE;
				// @ts-expect-error — unknown flag
				args.nope;
			},
		},
		plain: {
			run: ({ env, args }) => {
				assertTrue<Equal<typeof env, RawEnv>>();
				assertTrue<Equal<typeof args, Record<string, never>>>();
			},
		},
		gate: {
			steps: [
				"fix",
				"tsc",
			],
			finally: [
				"plain",
			],
		},
		// @ts-expect-error — "fxi" is not a task name
		gate2: {
			steps: [
				"fxi",
			],
		},
		// @ts-expect-error — "plian" is not a task name
		cleanup: {
			finally: [
				"plian",
			],
		},
		broken: {
			// @ts-expect-error — "tcs" is not a task name
			deps: [
				"tcs",
			],
		},
		workspace: {
			deps: [
				"^tsc",
				"@acme/api#build",
			],
		},
		bogus: {
			// @ts-expect-error — bogus property
			bogus: true,
		},
		// @ts-expect-error — "staging" is not a declared mode
		staging: {
			protect: "staging",
		},
	},
	{
		modes: [
			"dev",
			"prod",
		],
		members: {
			tsc: {
				deps: [
					"^tsc",
				],
				inputs: [
					"src/**",
				],
			},
		},
		hooks: {
			"pre-commit": {
				steps: [
					"fix",
					"tsc",
				],
				restage: true,
			},
			"pre-push": "bun scripts/guard.ts",
		},
	},
);
assertTrue<
	Equal<
		keyof typeof tasks,
		| "fix"
		| "syncpack"
		| "tsc"
		| "version"
		| "deploy"
		| "plain"
		| "gate"
		| "gate2"
		| "cleanup"
		| "broken"
		| "workspace"
		| "bogus"
		| "staging"
	>
>();

// --- 2. hooks name-check their steps -------------------------------------------
defineTasks(
	{
		fix: "x",
	},
	{
		hooks: {
			// @ts-expect-error — "fxi" is not a task name
			"pre-commit": {
				steps: [
					"fxi",
				],
			},
		},
	},
);

// --- 3. namespaces ---------------------------------------------------------------
defineTasks({
	stop: "docker compose stop",
	db: ns({
		reset: {
			deps: [
				"backup", // sibling
				"stop", // top-level
			],
			args: {
				force: {
					type: "boolean",
				},
			},
			run: ({ args }) => {
				assertTrue<Equal<typeof args.force, boolean>>();
			},
		},
		backup: "pg_dump",
	}),
	after: {
		deps: [
			"db:reset",
		],
	},
	after2: {
		// @ts-expect-error — "db:rest" is not a task name
		deps: [
			"db:rest",
		],
	},
	// @ts-expect-error — "stpo" is not a task name (inside a namespace)
	look: ns({
		serve: {
			deps: [
				"stpo",
			],
		},
	}),
});

// --- 4. no modes declared: mode is a plain string --------------------------------
defineTasks({
	any: {
		run: ({ mode }) => {
			assertTrue<Equal<typeof mode, string>>();
		},
	},
});
