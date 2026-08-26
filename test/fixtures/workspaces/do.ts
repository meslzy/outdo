import { defineTasks } from "../../../src/index";

export default defineTasks({
	"root-only": {
		desc: "Root-level task",
		run: () => {
			console.log("ROOT-ONLY");
		},
	},
	build: {
		desc: "Root build",
		run: () => {
			console.log("BUILD in root");
		},
	},
});
