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
	"rest:dep": {
		desc: "Helper that shows its rest args",
		run: ({ rest }) => {
			console.log(`dep-rest:${JSON.stringify(rest)}`);
		},
	},
	"rest:echo": {
		desc: "Echo passthrough args",
		deps: [
			"rest:dep",
		],
		run: ({ rest }) => {
			console.log(`echo-rest:${JSON.stringify(rest)}`);
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
