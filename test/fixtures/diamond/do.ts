import { defineTasks } from "../../../src/index";

const stamp = (name: string, phase: "start" | "end") => {
	console.log(`${name} ${phase} ${Date.now()}`);
};

export default defineTasks({
	a: {
		run: async () => {
			stamp("a", "start");
			await Bun.sleep(40);
			stamp("a", "end");
		},
	},
	b: {
		deps: [
			"a",
		],
		run: async () => {
			stamp("b", "start");
			await Bun.sleep(120);
			stamp("b", "end");
		},
	},
	c: {
		deps: [
			"a",
		],
		run: async () => {
			stamp("c", "start");
			await Bun.sleep(120);
			stamp("c", "end");
		},
	},
	d: {
		deps: [
			"b",
			"c",
		],
		run: async () => {
			stamp("d", "start");
			stamp("d", "end");
		},
	},
});
