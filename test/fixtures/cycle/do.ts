import { defineTasks } from "../../../src/index";

export default defineTasks({
	a: {
		deps: [
			"b",
		],
	},
	b: {
		deps: [
			"c",
		],
	},
	c: {
		deps: [
			"a",
		],
	},
});
