import { defineTasks } from "../../../src/index";

export default defineTasks({
	forever: {
		// > 2^31-1 ms would be clamped to ~1ms by the runtime — rejected at load.
		timeoutMs: 2_592_000_000_000,
		run: () => {},
	},
});
