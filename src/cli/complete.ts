/**
 * Hidden `outdo __complete -- <words...>` endpoint. Prints one candidate per
 * line as `value<TAB>description`. Must never fail loudly and must stay fast —
 * shells call this on every TAB press.
 */

import { loadProjectFromCwd } from "~/cli/load";
import { findTaskMatches } from "~/cli/resolve-task";

const GLOBAL_FLAGS: [
	string,
	string,
][] = [
	[
		"--watch",
		"re-run on file changes",
	],
	[
		"--concurrency",
		"max parallel tasks",
	],
	[
		"--continue",
		"keep running after a failure",
	],
	[
		"--log-order",
		"stream | grouped | auto",
	],
	[
		"--output-logs",
		"full | errors-only | none",
	],
	[
		"--dry",
		"show the plan without running",
	],
	[
		"--force",
		"ignore the fingerprint cache",
	],
	[
		"--affected",
		"only run tasks affected by git changes",
	],
	[
		"--profile",
		"write a Chrome trace of the run",
	],
	[
		"--isolate",
		"force the child-process backend",
	],
	[
		"--filter",
		"filter workspace packages",
	],
	[
		"--json",
		"machine-readable output",
	],
	[
		"--color",
		"auto | always | never",
	],
	[
		"--print-env",
		"explain resolved env for a task",
	],
	[
		"--help",
		"show help",
	],
];

const SUBCOMMANDS: [
	string,
	string,
][] = [
	[
		"ls",
		"list tasks",
	],
	[
		"graph",
		"print the dependency graph",
	],
	[
		"explain",
		"explain cache/plan for a task",
	],
	[
		"init",
		"scaffold a starter do.ts",
	],
	[
		"completion",
		"print shell completions",
	],
];

const SHELLS = [
	"bash",
	"zsh",
	"fish",
	"powershell",
];

export async function completeCommand(words: string[]): Promise<number> {
	try {
		// `--empty` (before `--`) means the cursor sits on a fresh word — sent by
		// shells that can't pass a literal "" to native commands (PowerShell).
		let raw = words;
		let cursorOnFreshWord = false;
		if (raw[0] === "--empty") {
			cursorOnFreshWord = true;
			raw = raw.slice(1);
		}
		const args = raw[0] === "--" ? raw.slice(1) : raw;
		if (cursorOnFreshWord) {
			args.push("");
		}
		// The last word is the partial being completed (may be "").
		const current = args.at(-1) ?? "";
		const prior = args.slice(0, -1).filter((w) => w !== "");

		const out: string[] = [];
		const emit = (value: string, desc: string): void => {
			if (value.startsWith(current)) {
				out.push(`${value}\t${desc}`);
			}
		};

		const firstPositional = prior.find((w) => !w.startsWith("-"));

		if (firstPositional === "completion") {
			for (const shell of SHELLS) {
				emit(shell, "shell");
			}
		} else if (current.startsWith("-")) {
			for (const [flag, desc] of GLOBAL_FLAGS) {
				emit(flag, desc);
			}
			if (firstPositional !== undefined) {
				const project = await loadProjectFromCwd().catch(() => undefined);
				// Bare workspace names count too (`api-only` -> `api#api-only`);
				// flags are offered only when the name is unambiguous.
				const matches = project === undefined ? [] : findTaskMatches(project, firstPositional);
				if (matches.length === 1) {
					for (const [flag, spec] of Object.entries((matches[0] as (typeof matches)[number]).args)) {
						emit(`--${flag}`, spec.description ?? spec.type);
					}
				}
			}
		} else if (firstPositional === undefined) {
			const project = await loadProjectFromCwd().catch(() => undefined);
			if (project !== undefined) {
				for (const task of project.tasks.values()) {
					emit(task.name, task.desc ?? "");
				}
			}
			for (const [sub, desc] of SUBCOMMANDS) {
				emit(sub, desc);
			}
		} else {
			// Completing additional task names.
			const project = await loadProjectFromCwd().catch(() => undefined);
			if (project !== undefined) {
				for (const task of project.tasks.values()) {
					emit(task.name, task.desc ?? "");
				}
			}
		}

		if (out.length > 0) {
			console.log(out.join("\n"));
		}
	} catch {
		// Completions are best-effort; stay silent.
	}
	return 0;
}
