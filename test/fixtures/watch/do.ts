import { defineTasks } from "../../../src/index";

export default defineTasks({
	build: {
		desc: "Rebuild when inputs change",
		inputs: [
			"src/**/*.txt",
		],
		run: async () => {
			const content = (await Bun.file("src/input.txt").text()).trim();
			console.log(`BUILT content=${content}`);
		},
	},
	report: {
		desc: "Depends on build",
		deps: [
			"build",
		],
		inputs: [
			"src/**/*.txt",
		],
		run: async () => {
			console.log("REPORTED");
		},
	},
	server: {
		desc: "Watchable service",
		persistent: true,
		watch: [
			"src/**/*.txt",
		],
		run: async ({ signal }) => {
			console.log(`SERVER up pid=${process.pid}`);
			for (let i = 0; i < 600; i++) {
				if (signal.aborted) {
					console.log("SERVER stopping");
					return;
				}
				await Bun.sleep(100);
			}
		},
	},
});
