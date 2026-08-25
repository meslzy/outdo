import { defineTasks, task } from "../../../src/index";

export default defineTasks({
	"docker:up": {
		group: "Infra",
		desc: "Start local containers",
		run: async ({ log }) => {
			log.info("containers up");
		},
	},
	"db:reset": {
		group: "Infra",
		desc: "Reset the local database",
		deps: [
			"docker:up",
		],
		run: async ({ log }) => {
			log.info("db reset");
		},
	},
	build: {
		desc: "Build all packages",
		run: async () => {
			console.log("built");
		},
	},
	greet: task({
		desc: "Print a greeting",
		args: {
			name: {
				type: "string",
				default: "world",
				description: "Who to greet",
			},
		},
		run: ({ args }) => {
			console.log(`hello ${args.name}`);
		},
	}),
});
