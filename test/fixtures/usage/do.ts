import { defineTasks } from "../../../src/index";

export default defineTasks(
	{
		build: "echo building",
		test: {
			deps: [
				"build",
			],
			run: "echo testing",
		},
		feed: {
			args: {
				source: {
					type: "string",
					choices: [
						"eco",
						"all",
						"none",
					],
					default: "all",
				},
				id: {
					type: "string",
				},
				verbose: {
					type: "boolean",
				},
			},
			positional: [
				"id",
			],
			run: "echo feeding",
		},
		nest: {
			run: async ({ $ }) => {
				await $`${process.execPath} ${process.argv[1] as string} build`;
			},
		},
		lint: "bun run lint",
		deploy: "echo deploying",
		stale: "echo stale",
	},
	{
		modes: [
			"dev",
			"prod",
		],
		hooks: {
			"pre-commit": "echo hook",
		},
	},
);
