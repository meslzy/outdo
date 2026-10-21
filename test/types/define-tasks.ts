/**
 * M0 type spike — compile-time assertions for defineTasks/task.
 * Gated by `tsc --noEmit`; every @ts-expect-error must actually error.
 */

import { z } from "zod";
import { defineTasks, task } from "~/index";

// --- helper assertions ------------------------------------------------------
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare function assertTrue<T extends true>(): void;

// --- 1. inline tasks: deps checked, default ctx typed ------------------------
defineTasks({
	build: {
		desc: "build",
		run: async ({ $, env, rest, signal, cwd, name, log }) => {
			await $`echo build`;
			assertTrue<Equal<typeof env, Readonly<Record<string, string | undefined>>>>();
			assertTrue<Equal<typeof rest, string[]>>();
			assertTrue<Equal<typeof signal, AbortSignal>>();
			assertTrue<Equal<typeof cwd, string>>();
			assertTrue<Equal<typeof name, string>>();
			log.info("ok");
		},
	},
	test: {
		deps: [
			"build",
		],
		run: () => {},
	},
});

// --- 2. dep typo is a compile error ------------------------------------------
defineTasks({
	build: {},
	broken: {
		// @ts-expect-error — "biuld" is not a task name
		deps: [
			"biuld",
		],
	},
});

// --- 3. dep typo inside a task() entry is also caught ------------------------
defineTasks({
	build: {},
	// @ts-expect-error — "biuld" is not a task name
	broken: task({
		deps: [
			"biuld",
		],
	}),
});

// --- 4. env schema output flows to ctx.env ------------------------------------
defineTasks({
	deploy: task({
		env: z.object({
			DEPLOY_URL: z.url(),
			RETRIES: z.coerce.number().default(3),
		}),
		run: ({ env }) => {
			assertTrue<Equal<typeof env.DEPLOY_URL, string>>();
			assertTrue<Equal<typeof env.RETRIES, number>>();
			// @ts-expect-error — MISSING is not part of the schema output
			env.MISSING;
		},
	}),
});

// --- 5. args records flow to ctx.args with required/default narrowing --------
defineTasks({
	exec: task({
		args: {
			service: {
				type: "string",
				default: "api",
			},
			cmd: {
				type: "string",
				required: true,
			},
			verbose: {
				type: "boolean",
				short: "v",
			},
			label: {
				type: "string",
			},
		},
		run: ({ args }) => {
			assertTrue<Equal<typeof args.service, string>>();
			assertTrue<Equal<typeof args.cmd, string>>();
			assertTrue<Equal<typeof args.verbose, boolean>>();
			assertTrue<Equal<typeof args.label, string | undefined>>();
			// @ts-expect-error — unknown flag
			args.nope;
		},
	}),
});

// --- 6. env + args together ---------------------------------------------------
defineTasks({
	both: task({
		env: z.object({
			TOKEN: z.string(),
		}),
		args: {
			dry: {
				type: "boolean",
			},
		},
		run: ({ env, args }) => {
			assertTrue<Equal<typeof env.TOKEN, string>>();
			assertTrue<Equal<typeof args.dry, boolean>>();
		},
	}),
});

// --- 7. inline entries type env/args without task() --------------------------
defineTasks({
	inline: {
		env: z.object({
			X: z.string(),
		}),
		args: {
			dry: {
				type: "boolean",
			},
		},
		run: ({ env, args }) => {
			assertTrue<Equal<typeof env.X, string>>();
			assertTrue<Equal<typeof args.dry, boolean>>();
		},
	},
});

// --- 8. bogus properties rejected ---------------------------------------------
defineTasks({
	x: {
		// @ts-expect-error — bogus property
		bogus: true,
	},
});

// --- 9. self-dep is type-legal (cycle caught at runtime) ----------------------
defineTasks({
	loop: {
		deps: [
			"loop",
		],
	},
});

// --- 10. return value preserves task names ------------------------------------
const tasks = defineTasks({
	a: {
		desc: "a",
	},
	b: {
		deps: [
			"a",
		],
	},
});
assertTrue<Equal<keyof typeof tasks, "a" | "b">>();
