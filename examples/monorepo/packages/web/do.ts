import { defineTasks } from "bundo";

export default defineTasks({
	build: {
		desc: "Build the web app",
		inputs: [
			"src/**/*.tsx",
			"src/**/*.ts",
		],
		outputs: [
			"dist/**",
		],
		run: async ({ $ }) => {
			await $`bun build src/main.tsx --outdir dist`;
		},
	},
});
