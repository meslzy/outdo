import { z } from "zod";
import { defineTasks, ns } from "../../../src/index";

export default defineTasks(
	{
		hello: "echo hello-from-command",
		pair: [
			"echo first-command",
			"echo second-command",
		],
		echoargs: {
			desc: "Echo passthrough args",
			run: "echo got",
		},
		fix: {
			desc: "Pretend formatter",
			run: () => console.log("STEP fix"),
		},
		typegen: {
			run: () => console.log("STEP typegen"),
		},
		tsc: {
			deps: [
				"typegen",
			],
			run: () => console.log("STEP tsc"),
		},
		test: {
			run: () => console.log("STEP test"),
		},
		gate: {
			desc: "All checks in order",
			steps: [
				"fix",
				"tsc",
				"test",
			],
		},
		boom: {
			run: () => {
				throw new Error("boom failed");
			},
		},
		cleanup: {
			run: () => console.log("CLEANUP RAN"),
		},
		guarded: {
			steps: [
				"boom",
			],
			finally: [
				"cleanup",
			],
		},
		feed: {
			args: {
				source: z
					.enum([
						"eco",
						"metal",
						"all",
					])
					.default("all")
					.describe("which feed"),
				runs: z.coerce.number().int().min(1).default(1),
				id: z
					.string()
					.regex(/^C-\d{4}$/)
					.optional(),
			},
			run: ({ args }) => console.log(`FEED ${args.source} x${args.runs} id=${args.id ?? "-"}`),
		},
		logs: {
			args: {
				svc: {
					type: "string",
					choices: [
						"api",
						"web",
					],
					required: true,
				},
				follow: {
					type: "boolean",
					short: "f",
				},
			},
			positional: [
				"svc",
			],
			run: ({ args }) => console.log(`LOGS ${args.svc} follow=${args.follow}`),
		},
		db: ns({
			backup: {
				run: () => console.log("DB BACKUP"),
			},
			reset: {
				desc: "Reset the database",
				deps: [
					"backup",
				],
				protect: "prod",
				run: ({ mode }) => console.log(`DB RESET in ${mode}`),
			},
		}),
		whereami: {
			envFiles: [
				".env.platform",
			],
			env: z.object({
				PLATFORM: z.string(),
			}),
			run: ({ env, mode, root, cwd }) => console.log(`MODE=${mode} PLATFORM=${env.PLATFORM} ROOTOK=${root === cwd}`),
		},
		nuke: {
			confirm: "Really nuke everything?",
			destructive: true,
			run: () => console.log("NUKED"),
		},
		audit: {
			readonly: true,
			run: () => console.log("AUDIT OK"),
		},
		needs: {
			requires: {
				bin: [
					"definitely-not-a-real-binary-xyz",
				],
				env: [
					"OUTDO_TEST_NEVER_SET",
				],
				hint: "install the thing first",
			},
			run: () => console.log("NEEDS RAN"),
		},
		server: {
			desc: "HTTP service for bg tests",
			persistent: true,
			ready: {
				port: Number(process.env.OUTDO_TEST_PORT ?? "65123"),
			},
			run: async ({ signal }) => {
				const server = Bun.serve({
					port: Number(process.env.OUTDO_TEST_PORT ?? "65123"),
					fetch: () => new Response("ok"),
				});
				console.log(`SERVER UP ${server.port}`);
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
				server.stop(true);
				console.log("SERVER DOWN");
			},
		},
		remote: {
			run: async ({ ssh }) => {
				const vps = ssh("me@vps.example", {
					label: "vps",
				}).cwd("~/app");
				const result = await vps`echo ${"it's"} ${[
					"a b",
					"c",
				]}`;
				console.log(`REMOTE exit=${result.exitCode}`);
			},
		},
	},
	{
		modes: [
			"dev",
			"prod",
		],
		hooks: {
			"pre-commit": {
				steps: [
					"fix",
					"test",
				],
				restage: true,
			},
		},
	},
);
