/** bundo builds itself with bundo. */

import { defineTasks } from "./src/index";

export default defineTasks({
	typecheck: {
		group: "Verify",
		desc: "TypeScript gate (includes compile-time type tests)",
		run: async ({ $ }) => {
			await $`bun run typecheck`;
		},
	},
	lint: {
		group: "Verify",
		desc: "Biome lint + format check",
		run: async ({ $ }) => {
			await $`bun run lint`;
		},
	},
	test: {
		group: "Verify",
		desc: "Full test suite",
		run: async ({ $ }) => {
			await $`bun run test`;
		},
	},
	check: {
		group: "Verify",
		desc: "Everything that must pass before a commit",
		deps: [
			"typecheck",
			"lint",
			"test",
		],
	},
	build: {
		group: "Release",
		desc: "Bundle dist/ (CLI + library + declarations)",
		inputs: [
			"src/**/*.ts",
			"tsconfig.build.json",
			"scripts/build.ts",
		],
		outputs: [
			"dist/**",
		],
		run: async ({ $ }) => {
			await $`bun run build`;
		},
	},
	pack: {
		group: "Release",
		desc: "Build and create the npm tarball",
		deps: [
			"build",
		],
		run: async ({ $ }) => {
			await $`bun pm pack`;
		},
	},
});
