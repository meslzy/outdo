import { defineTasks } from "bundo";

export default defineTasks({
	build: {
		desc: "Build the API",
		inputs: [
			"src/**/*.ts",
		],
		outputs: [
			"dist/**",
		],
		run: async ({ $ }) => {
			await $`bun build src/index.ts --outdir dist --target bun`;
		},
	},
	dev: {
		desc: "API dev server",
		persistent: true,
		watch: [
			"src/**/*.ts",
		],
		run: async ({ $ }) => {
			await $`bun --watch src/index.ts`;
		},
	},
});
