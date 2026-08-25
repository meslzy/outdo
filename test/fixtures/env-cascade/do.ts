import { z } from "zod";
import { defineTasks, task } from "../../../src/index";

export default defineTasks({
	"env:dump": {
		desc: "Dump resolved env markers",
		run: async ({ env }) => {
			const raw = env as Record<string, string | undefined>;
			console.log(
				JSON.stringify({
					APP_NAME: raw.APP_NAME,
					DATABASE_URL: raw.DATABASE_URL,
					SHARED: raw.SHARED,
					LOCAL_ONLY: raw.LOCAL_ONLY,
					COMPOSED: raw.COMPOSED,
					LITERAL: raw.LITERAL,
				}),
			);
		},
	},
	"env:typed": task({
		desc: "Validated + coerced env",
		env: z.object({
			DATABASE_URL: z.url(),
			PORT: z.coerce.number(),
		}),
		run: ({ env }) => {
			console.log(
				JSON.stringify({
					port: env.PORT,
					portType: typeof env.PORT,
					url: env.DATABASE_URL,
				}),
			);
		},
	}),
	"env:strict": task({
		desc: "Requires a secret that is not in any .env file",
		env: z.object({
			REQUIRED_SECRET: z.string().min(1),
		}),
		run: ({ env, log }) => {
			log.info("secret ok", env.REQUIRED_SECRET.length);
		},
	}),
	"side-effect": task({
		desc: "Writes a marker file, then fails env validation",
		deps: [],
		env: z.object({
			NEVER_SET_VAR_XYZ: z.string(),
		}),
		run: async ({ $ }) => {
			await $`touch should-not-exist.txt`;
		},
	}),
});
