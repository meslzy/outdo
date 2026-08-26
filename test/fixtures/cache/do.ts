import { z } from "zod";
import { defineTasks, task } from "../../../src/index";

let counter = 0;

export default defineTasks({
	compile: {
		desc: "Pretend compile with input/output tracking",
		inputs: [
			"src/**/*.txt",
		],
		outputs: [
			"out/**",
		],
		run: async ({ $ }) => {
			counter++;
			await $`mkdir -p out`;
			const inputs = await Array.fromAsync(
				new Bun.Glob("src/**/*.txt").scan({
					cwd: process.cwd(),
				}),
			);
			await Bun.write("out/result.txt", `compiled:${inputs.length}`);
			console.log(`COMPILED run=${counter}`);
		},
	},
	bundle: {
		desc: "Depends on compile",
		deps: [
			"compile",
		],
		inputs: [
			"out/**",
		],
		run: async () => {
			console.log("BUNDLED");
		},
	},
	flagged: task({
		desc: "Cacheable task whose args are part of the fingerprint",
		inputs: [
			"src/**/*.txt",
		],
		args: {
			mode: {
				type: "string",
				default: "dev",
			},
		},
		run: ({ args }) => {
			console.log(`FLAGGED mode=${args.mode}`);
		},
	}),
	enved: task({
		desc: "Cacheable task whose env output is part of the fingerprint",
		inputs: [
			"src/**/*.txt",
		],
		env: z.object({
			CACHE_SALT: z.string().default("none"),
		}),
		run: ({ env }) => {
			console.log(`ENVED salt=${env.CACHE_SALT}`);
		},
	}),
});
