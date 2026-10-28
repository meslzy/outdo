/** outdo builds itself with outdo. */

import { defineTasks } from "./src/index";

export default defineTasks({
	typecheck: {
		group: "Verify",
		desc: "TypeScript gate (includes compile-time type tests)",
		readonly: true,
	},
	lint: {
		group: "Verify",
		desc: "Biome lint + format check",
		readonly: true,
	},
	fix: {
		group: "Verify",
		desc: "Apply Biome fixes and formatting",
	},
	test: {
		group: "Verify",
		desc: "Full test suite",
		readonly: true,
	},
	coverage: {
		group: "Verify",
		desc: "Test suite with coverage report (text + lcov in coverage/)",
		readonly: true,
	},
	check: {
		group: "Verify",
		desc: "Everything that must pass before a commit",
		readonly: true,
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
	},
	pack: {
		group: "Release",
		desc: "Build and create the npm tarball",
		deps: [
			"build",
		],
		run: "bun pm pack",
	},
	"docs:dev": {
		group: "Docs",
		desc: "Docs dev server (VitePress)",
		persistent: true,
	},
	"docs:build": {
		group: "Docs",
		desc: "Build the docs site",
		inputs: [
			"docs/**",
			"!docs/.vitepress/dist/**",
			"!docs/.vitepress/cache/**",
		],
		outputs: [
			"docs/.vitepress/dist/**",
		],
	},
});
