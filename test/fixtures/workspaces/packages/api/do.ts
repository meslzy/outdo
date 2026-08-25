import { defineTasks } from "../../../../../src/index";

export default defineTasks({
	build: {
		desc: "Build api",
		run: () => {
			console.log("BUILD in api");
		},
	},
	"api-only": {
		deps: [
			"build",
		],
		run: () => {
			console.log("API-ONLY");
		},
	},
});
