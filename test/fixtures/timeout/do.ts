import { defineTasks } from "../../../src/index";

export default defineTasks({
	slow: {
		desc: "Cooperatively respects the timeout signal",
		timeoutMs: 300,
		run: async ({ signal }) => {
			console.log("SLOW START");
			for (let i = 0; i < 200; i++) {
				if (signal.aborted) {
					return;
				}
				await Bun.sleep(50);
			}
			console.log("SLOW FINISHED");
		},
	},
	quick: {
		desc: "Finishes well inside its timeout",
		timeoutMs: 10_000,
		run: () => {
			console.log("QUICK DONE");
		},
	},
});
