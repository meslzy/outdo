import { defineTasks } from "../../../src/index";

export default defineTasks({
	"svc:flaky": {
		desc: "Service that dies on its own after 300ms",
		persistent: true,
		run: async () => {
			console.log("flaky service up");
			await Bun.sleep(300);
			throw new Error("service crashed");
		},
	},
	"uses:flaky": {
		deps: [
			"svc:flaky",
		],
		run: async () => {
			console.log("dependent ran while service alive");
		},
	},
	"svc:steady": {
		desc: "Service that runs until aborted",
		persistent: true,
		run: async ({ signal }) => {
			console.log("steady service up");
			for (let i = 0; i < 600; i++) {
				if (signal.aborted) {
					console.log("steady stopping");
					return;
				}
				await Bun.sleep(100);
			}
		},
	},
});
