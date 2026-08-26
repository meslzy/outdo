import { defineTasks } from "../../../src/index";

// A cycle that only "exists" through a conditional edge — still a config
// error: cycles are validated over declared edges, independent of env.
export default defineTasks({
	x: {
		deps: [
			{
				task: "y",
				if: "NEVER_SET",
			},
		],
	},
	y: {
		deps: [
			"x",
		],
	},
});
