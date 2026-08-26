import { defineTasks } from "../../../src/index";

export default defineTasks({
	notaservice: {
		ready: {
			log: "READY",
		},
		run: () => {},
	},
});
