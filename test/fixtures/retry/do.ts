import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { defineTasks } from "../../../src/index";

const bump = (file: string): number => {
	const next = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;
	writeFileSync(file, String(next));
	return next;
};

export default defineTasks({
	flaky: {
		desc: "Fails until attempt 3, then succeeds (cacheable)",
		inputs: [
			"src/**",
		],
		retry: {
			attempts: 3,
			delayMs: 50,
		},
		run: () => {
			const attempt = bump("flaky-counter.txt");
			console.log(`FLAKY attempt=${attempt}`);
			if (attempt < 3) {
				throw new Error(`flaky failure ${attempt}`);
			}
		},
	},
	hopeless: {
		desc: "Always fails; retry: 2 total attempts",
		retry: 2,
		run: () => {
			const attempt = bump("hopeless-counter.txt");
			console.log(`HOPELESS attempt=${attempt}`);
			throw new Error("always fails");
		},
	},
	"slow-retry": {
		desc: "Fails fast, then waits 5s before retrying — abort should cancel",
		retry: {
			attempts: 2,
			delayMs: 5000,
		},
		run: () => {
			bump("slow-retry-counter.txt");
			console.log("SLOW-RETRY ATTEMPT");
			throw new Error("slow-retry fails");
		},
	},
	"quick-fail": {
		desc: "Independent task that fails shortly after start",
		run: async () => {
			await Bun.sleep(150);
			console.log("QUICK FAIL");
			throw new Error("quick failure");
		},
	},
});
