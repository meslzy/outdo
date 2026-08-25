import { readFileSync } from "node:fs";
import { defineTasks, from, task } from "../../../src/index";

const version = task({
	desc: "Cacheable producer: returns data derived from its input",
	inputs: [
		"src/version.txt",
	],
	run: () => {
		const tag = readFileSync("src/version.txt", "utf8").trim();
		console.log(`VERSION RAN tag=${tag}`);
		return {
			tag,
			n: 42,
		};
	},
});

export default defineTasks({
	version,
	consume: task({
		desc: "Typed consumer via from()",
		deps: [
			from("version", version),
		],
		inputs: [
			"src/note.txt",
		],
		run: ({ deps }) => {
			console.log(`CONSUMED tag=${deps.version.tag} n=${deps.version.n}`);
		},
	}),
	stamp: {
		desc: "Non-cacheable producer (no inputs) — output changes with stamp.txt",
		run: () => {
			const value = readFileSync("stamp.txt", "utf8").trim();
			console.log(`STAMP RAN value=${value}`);
			return value;
		},
	},
	"use-stamp": {
		desc: "Cacheable consumer of a non-cacheable producer",
		deps: [
			"stamp",
		],
		inputs: [
			"src/note.txt",
		],
		run: (ctx) => {
			console.log(`USED stamp=${String(ctx.deps.stamp)}`);
		},
	},
	bad: {
		desc: "Returns a circular (non-JSON) output",
		run: () => {
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			return circular;
		},
	},
});
