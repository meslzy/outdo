import { defineTasks } from "../../../src/index";

export default defineTasks({
	ok: {
		run: async () => {
			console.log("ok ran");
		},
	},
	boom: {
		deps: [
			"ok",
		],
		run: async () => {
			throw new Error("kaboom");
		},
	},
	downstream: {
		deps: [
			"boom",
		],
		run: async () => {
			console.log("downstream should never run");
		},
	},
	slow: {
		deps: [
			"ok",
		],
		run: async ({ signal }) => {
			console.log("slow started");
			const rounds = process.env.BUNDO_TEST_FAST_SLOW === "1" ? 3 : 100;
			for (let i = 0; i < rounds; i++) {
				if (signal.aborted) {
					console.log("slow aborted");
					return;
				}
				await Bun.sleep(100);
			}
			console.log("slow finished");
		},
	},
	all: {
		deps: [
			"downstream",
			"slow",
		],
	},
});
