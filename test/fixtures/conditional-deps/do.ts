import { defineTasks, optional } from "../../../src/index";

export default defineTasks({
	base: {
		desc: "Sometimes a dependency",
		run: () => {
			console.log("BASE RAN");
		},
	},
	gated: {
		desc: "Depends on base only when RUN_BASE is truthy",
		deps: [
			{
				task: "base",
				if: "RUN_BASE",
			},
		],
		run: () => {
			console.log("GATED RAN");
		},
	},
	pred: {
		desc: "Predicate condition",
		deps: [
			{
				task: "base",
				if: (env) => env.PRED_ON === "yes",
			},
		],
		run: () => {
			console.log("PRED RAN");
		},
	},
	soft: {
		desc: "Optional dep on a task that does not exist",
		deps: [
			"base",
			optional("missing-task"),
		],
		run: () => {
			console.log("SOFT RAN");
		},
	},
});
