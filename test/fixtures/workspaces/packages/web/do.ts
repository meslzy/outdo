import { defineTasks } from "../../../../../src/index";

export default defineTasks({
	build: {
		desc: "Build web",
		run: () => {
			console.log("BUILD in web");
		},
	},
});
