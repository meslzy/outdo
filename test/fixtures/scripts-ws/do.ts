import { defineTasks } from "../../../src/index";

export default defineTasks(
	{
		tsc: {
			desc: "Type-check every package, dependencies first",
			deps: [
				"^tsc",
			],
			run: "echo ROOT-TSC",
		},
		lint: {
			desc: "do.ts decorates the package.json script",
			readonly: true,
		},
	},
	{
		members: {
			tsc: {
				deps: [
					"^tsc",
				],
			},
		},
	},
);
