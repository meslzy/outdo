import { defineTasks } from "../../../../../src/index";

export default defineTasks({
	build: {
		desc: "Build lib",
		run: () => {
			console.log("BUILD in lib");
		},
	},
});
