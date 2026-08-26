/**
 * A realistic single-repo do.ts for a web app with a database.
 * Copy next to your package.json and adapt.
 */

import { defineTasks, task } from "outdo";
import { z } from "zod";

export default defineTasks({
	// --- Infra ---------------------------------------------------------------
	"docker:up": {
		group: "Infra",
		desc: "Start local Postgres + Redis",
		run: async ({ $ }) => {
			await $`docker compose up -d postgres redis`;
		},
	},
	"db:migrate": {
		group: "Infra",
		desc: "Apply pending migrations",
		deps: [
			"docker:up",
		],
		run: async ({ $ }) => {
			await $`bun prisma migrate deploy`;
		},
	},
	"db:reset": {
		group: "Infra",
		desc: "Reset + reseed the local database",
		deps: [
			"docker:up",
		],
		run: async ({ $ }) => {
			await $`bun prisma migrate reset --force`;
			await $`bun prisma db seed`;
		},
	},
	"db:backup": task({
		group: "Infra",
		desc: "Dump the database and upload it",
		env: z.object({
			DATABASE_URL: z.url(),
			BACKUP_BUCKET: z.string().min(1),
		}),
		run: async ({ $, env }) => {
			const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
			const file = `backup-${stamp}.sql`;
			await $`pg_dump ${env.DATABASE_URL} -f ${file}`;
			await $`aws s3 cp ${file} s3://${env.BACKUP_BUCKET}/db/${file}`;
			await $`rm ${file}`;
		},
	}),

	// --- Dev -----------------------------------------------------------------
	dev: {
		group: "Dev",
		desc: "Dev server (restarts on watched changes)",
		persistent: true,
		deps: [
			"docker:up",
		],
		watch: [
			"src/**/*.ts",
		],
		run: async ({ $ }) => {
			await $`bun --watch src/server.ts`;
		},
	},
	exec: task({
		group: "Dev",
		desc: "Run a command inside a service container",
		args: {
			service: {
				type: "string",
				short: "s",
				default: "api",
				description: "compose service",
			},
			cmd: {
				type: "string",
				default: "sh",
				description: "command to run",
			},
		},
		run: async ({ $, args }) => {
			await $`docker compose exec ${args.service} ${args.cmd}`;
		},
	}),

	// --- Verify / Release ----------------------------------------------------
	typecheck: {
		group: "Verify",
		desc: "tsc gate",
		inputs: [
			"src/**/*.ts",
			"tsconfig.json",
		],
		run: async ({ $ }) => {
			await $`bunx tsc --noEmit`;
		},
	},
	test: {
		group: "Verify",
		desc: "Test suite (pass extra flags after --)",
		deps: [
			"db:migrate",
		],
		run: async ({ $, rest }) => {
			await $`bun test ${rest}`;
		},
	},
	build: {
		group: "Release",
		desc: "Production build (cached)",
		inputs: [
			"src/**/*.ts",
			"tsconfig.json",
		],
		outputs: [
			"dist/**",
		],
		run: async ({ $ }) => {
			await $`bun build src/server.ts --outdir dist --target bun`;
		},
	},
	release: task({
		group: "Release",
		desc: "Build, containerize, push",
		deps: [
			"typecheck",
			"test",
			"build",
		],
		env: z.object({
			NODE_ENV: z.literal("production"),
			CONTAINER_REGISTRY: z.string(),
			RELEASE_VERSION: z.string().regex(/^v\d+\.\d+\.\d+$/),
		}),
		args: {
			"skip-push": {
				type: "boolean",
				description: "Build the image but do not push",
			},
		},
		run: async ({ $, env, args, log }) => {
			const tag = `${env.CONTAINER_REGISTRY}/app:${env.RELEASE_VERSION}`;
			await $`docker build -t ${tag} .`;
			if (args["skip-push"]) {
				log.info("skipping push");
				return;
			}
			await $`docker push ${tag}`;
		},
	}),
});
