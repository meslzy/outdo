/** Global argv parsing. Task-specific flags are re-parsed later by argspec. */

import { parseArgs } from "node:util";
import { OutdoError } from "~/core/errors";
import type { ColorMode } from "~/core/logger";

export interface GlobalFlags {
	json: boolean;
	help: boolean;
	version: boolean;
	color: ColorMode;
	watch: boolean;
	concurrency: number | undefined;
	continueOnError: boolean;
	logOrder: "stream" | "grouped" | "auto";
	outputLogs: "full" | "errors-only" | "none";
	dry: false | "text" | "json";
	force: boolean;
	filter: string[];
	isolate: boolean;
	/** Git-aware task selection. `base: undefined` = auto-detect the base rev. */
	affected:
		| false
		| {
				base: string | undefined;
		  };
	/** Chrome trace output path, or false. */
	profile: string | false;
	/** `--mode <name>` (validated against the project's declared modes). */
	mode: string | undefined;
	/** `--yes`: answer every protect/confirm question with yes. */
	yes: boolean;
	/** `--from` / `--until`: run only part of a task's steps. */
	from: string | undefined;
	until: string | undefined;
	/** CI mode (`outdo ci`): folded logs, annotations, step summary. */
	ci: boolean;
}

interface RunLike {
	tasks: string[];
	taskArgv: string[];
	rest: string[];
}

export type Command =
	| {
			kind: "list";
			/** `outdo db` lists one namespace; set when the namespace is resolved later. */
	  }
	| ({
			kind: "run";
	  } & RunLike)
	| ({
			kind: "ci";
			/** Run everything requested, not only what changed. */
			all: boolean;
			base: string | undefined;
	  } & RunLike)
	| {
			kind: "ci-init";
	  }
	| {
			kind: "affected";
			tasks: string[];
			base: string | undefined;
			githubOutput: boolean;
	  }
	| ({
			kind: "bg-start";
	  } & RunLike)
	| {
			kind: "bg-stop";
			tasks: string[];
	  }
	| {
			kind: "bg-ps";
	  }
	| {
			kind: "bg-logs";
			task: string;
			follow: boolean;
	  }
	| {
			kind: "hooks";
			action: "install" | "uninstall" | "list" | "run";
			hook: string | undefined;
			rest: string[];
	  }
	| {
			kind: "prune";
			out: string;
	  }
	| {
			kind: "mcp";
	  }
	| {
			kind: "skill";
			action: "install" | "path";
			global: boolean;
	  }
	| {
			kind: "doctor";
	  }
	| {
			kind: "pick";
	  }
	| {
			kind: "graph";
			dot: boolean;
	  }
	| {
			kind: "init";
	  }
	| {
			kind: "completion";
			shell: string | undefined;
	  }
	| {
			kind: "complete";
			words: string[];
	  }
	| {
			kind: "print-env";
			task: string;
	  }
	| {
			kind: "explain";
			task: string;
	  }
	| {
			kind: "help";
	  }
	| {
			kind: "version";
	  }
	| {
			kind: "worker";
	  };

export interface ParsedCli {
	command: Command;
	flags: GlobalFlags;
}

/** Words that are outdo commands, not task names (a same-named task runs via `outdo run <name>`). */
export const SUBCOMMANDS = new Set([
	"ls",
	"run",
	"graph",
	"init",
	"completion",
	"explain",
	"bg",
	"ci",
	"affected",
	"hooks",
	"prune",
	"mcp",
	"doctor",
	"skill",
	"__complete",
]);

/** Subcommands whose tail is parsed like a run: `[globals] tasks... [task flags] [-- rest]`. */
const RUN_LIKE = new Set([
	"run",
	"ci",
]);

/** Global options, shared by every command. */
const GLOBAL_OPTIONS = {
	json: {
		type: "boolean",
		default: false,
	},
	help: {
		type: "boolean",
		short: "h",
		default: false,
	},
	version: {
		type: "boolean",
		short: "V",
		default: false,
	},
	color: {
		type: "string",
	},
	watch: {
		type: "boolean",
		short: "w",
		default: false,
	},
	concurrency: {
		type: "string",
		short: "j",
	},
	continue: {
		type: "boolean",
		default: false,
	},
	"log-order": {
		type: "string",
	},
	"output-logs": {
		type: "string",
	},
	dry: {
		type: "boolean",
		default: false,
	},
	"dry-json": {
		type: "boolean",
		default: false,
	},
	force: {
		type: "boolean",
		short: "f",
		default: false,
	},
	filter: {
		type: "string",
		short: "F",
		multiple: true,
	},
	"print-env": {
		type: "string",
	},
	isolate: {
		type: "boolean",
		default: false,
	},
	affected: {
		type: "string",
	},
	profile: {
		type: "string",
	},
	mode: {
		type: "string",
		short: "m",
	},
	yes: {
		type: "boolean",
		short: "y",
		default: false,
	},
	from: {
		type: "string",
	},
	until: {
		type: "string",
	},
	interactive: {
		type: "boolean",
		short: "i",
		default: false,
	},
} as const;

/** Global flags that consume the next token when written space-separated. */
const VALUE_FLAGS = new Set([
	"--color",
	"--concurrency",
	"-j",
	"--log-order",
	"--output-logs",
	"--filter",
	"-F",
	"--print-env",
	"--mode",
	"-m",
	"--from",
	"--until",
	"--base",
	"--out",
]);

const COMMAND_OPTIONS: Record<
	string,
	Record<
		string,
		{
			type: "boolean" | "string";
			short?: string;
		}
	>
> = {
	graph: {
		dot: {
			type: "boolean",
		},
	},
	ci: {
		all: {
			type: "boolean",
		},
		base: {
			type: "string",
		},
	},
	affected: {
		base: {
			type: "string",
		},
		"github-output": {
			type: "boolean",
		},
	},
	bg: {
		follow: {
			type: "boolean",
		},
	},
	skill: {
		global: {
			type: "boolean",
		},
	},
	prune: {
		docker: {
			type: "boolean",
		},
		out: {
			type: "string",
		},
	},
};

function normalizeToken(token: string): string {
	if (token === "--no-color") {
		return "--color=never";
	}
	if (token === "--dry=json") {
		return "--dry-json";
	}
	// Bare forms take no value; a base rev / path requires the `=` form so the
	// next token (a task name) is never swallowed.
	if (token === "--affected") {
		return "--affected=";
	}
	if (token === "--profile") {
		return "--profile=";
	}
	return token;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string, fallback: T): T {
	if (value === undefined) {
		return fallback;
	}
	if ((allowed as readonly string[]).includes(value)) {
		return value as T;
	}
	throw new OutdoError("usage", `Invalid value "${value}" for ${flag}. Expected one of: ${allowed.join(", ")}.`);
}

/** Index of the first positional token (global flags and their values come before it). */
function firstPositionalIndex(tokens: readonly string[]): number {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as string;
		if (token.startsWith("-") && token !== "-") {
			if (!token.includes("=") && VALUE_FLAGS.has(token)) {
				i++; // skip this flag's value
			}
			continue;
		}
		return i;
	}
	return tokens.length;
}

/** Run-mode tail: leading bare words are task names; the rest belongs to the (single) task. */
function splitTasks(tail: readonly string[]): {
	tasks: string[];
	taskArgv: string[];
} {
	const tasks: string[] = [];
	let i = 0;
	for (; i < tail.length; i++) {
		const token = tail[i] as string;
		if (token.startsWith("-") && token !== "-") {
			break;
		}
		tasks.push(token);
	}
	return {
		tasks,
		taskArgv: tail.slice(i),
	};
}

function parseOptions(
	tokens: readonly string[],
	options: Record<string, unknown>,
): {
	values: Record<string, unknown>;
	positionals: string[];
} {
	try {
		return parseArgs({
			args: [
				...tokens,
			],
			options: options as NonNullable<Parameters<typeof parseArgs>[0]>["options"],
			strict: true,
			allowPositionals: true,
		}) as {
			values: Record<string, unknown>;
			positionals: string[];
		};
	} catch (error) {
		const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
		throw new OutdoError("usage", `${message} Run "outdo --help" for usage.`);
	}
}

export function parseCli(argv: readonly string[]): ParsedCli {
	// 1. Split off everything after `--` (raw passthrough for the task).
	// Tokens are kept RAW here: normalizeToken applies only to the global zone
	// below — a task's own declared flags (a task-owned --no-color, --dry=json,
	// --affected, ...) must reach parseTaskArgs untouched.
	const terminatorIdx = argv.indexOf("--");
	const rest = terminatorIdx === -1 ? [] : argv.slice(terminatorIdx + 1).map(String);
	const head = (terminatorIdx === -1 ? argv : argv.slice(0, terminatorIdx)).map(String);

	// `__worker` is the hidden child-process entry — IPC-driven, no flags.
	if (head[0] === "__worker") {
		return {
			command: {
				kind: "worker",
			},
			flags: defaultsOnly(),
		};
	}

	// `__complete` receives the raw shell words verbatim — bypass parsing.
	if (head[0] === "__complete") {
		return {
			command: {
				kind: "complete",
				words: [
					...head.slice(1),
					...(terminatorIdx === -1
						? []
						: [
								"--",
								...rest,
							]),
				],
			},
			flags: defaultsOnly(),
		};
	}

	// 2. Find the first positional; global flags must precede it.
	const firstPos = firstPositionalIndex(head);
	const globalArgv = head.slice(0, firstPos).map(normalizeToken);
	const tail = head.slice(firstPos);
	const first = tail[0];
	const isSub = first !== undefined && SUBCOMMANDS.has(first);
	const sub = isSub ? (first as string) : undefined;

	// 3. Subcommands parse their own tail flags strictly (plus globals anywhere),
	// except run-like ones, whose tail after the task names belongs to the task.
	let subTail = isSub ? tail.slice(1) : [];
	let runTail: string[] = isSub ? [] : tail;
	if (sub !== undefined && RUN_LIKE.has(sub) && !(sub === "ci" && subTail[0] === "init")) {
		const pos = firstPositionalIndex(subTail);
		runTail = subTail.slice(pos);
		subTail = subTail.slice(0, pos);
	}
	if (sub === "bg" && subTail[0] === "start") {
		const afterVerb = subTail.slice(1);
		const pos = firstPositionalIndex(afterVerb);
		runTail = afterVerb.slice(pos);
		subTail = [
			"start",
			...afterVerb.slice(0, pos),
		];
	}
	const options =
		sub !== undefined
			? {
					...GLOBAL_OPTIONS,
					...COMMAND_OPTIONS[sub],
				}
			: GLOBAL_OPTIONS;
	const { values, positionals } = parseOptions(
		[
			...globalArgv,
			...subTail.map(normalizeToken),
		],
		options,
	);

	const flags: GlobalFlags = {
		json: values.json === true,
		help: values.help === true,
		version: values.version === true,
		color: oneOf(
			values.color as string | undefined,
			[
				"auto",
				"always",
				"never",
			],
			"--color",
			"auto",
		),
		watch: values.watch === true,
		concurrency: parseConcurrency(values.concurrency as string | undefined),
		continueOnError: values.continue === true,
		logOrder: oneOf(
			values["log-order"] as string | undefined,
			[
				"stream",
				"grouped",
				"auto",
			],
			"--log-order",
			"auto",
		),
		outputLogs: oneOf(
			values["output-logs"] as string | undefined,
			[
				"full",
				"errors-only",
				"none",
			],
			"--output-logs",
			"full",
		),
		dry: values["dry-json"] === true ? "json" : values.dry === true ? "text" : false,
		force: values.force === true,
		filter: (values.filter as string[] | undefined) ?? [],
		isolate: values.isolate === true,
		affected:
			values.affected === undefined
				? false
				: {
						base: values.affected === "" ? undefined : (values.affected as string),
					},
		profile:
			values.profile === undefined ? false : values.profile === "" ? ".outdo/trace.json" : (values.profile as string),
		mode: values.mode as string | undefined,
		yes: values.yes === true,
		from: values.from as string | undefined,
		until: values.until as string | undefined,
		ci: false,
	};

	const printEnv = values["print-env"] as string | undefined;
	const runLike = (): RunLike => ({
		...splitTasks(runTail),
		rest,
	});

	let command: Command;
	if (flags.help) {
		command = {
			kind: "help",
		};
	} else if (flags.version) {
		command = {
			kind: "version",
		};
	} else if (printEnv !== undefined) {
		if (printEnv === "") {
			throw new OutdoError("usage", "--print-env requires a task name.");
		}
		command = {
			kind: "print-env",
			task: printEnv,
		};
	} else if (values.interactive === true) {
		command = {
			kind: "pick",
		};
	} else if (first === undefined || first === "ls") {
		command = {
			kind: "list",
		};
	} else if (first === "run") {
		command = {
			kind: "run",
			...runLike(),
		};
		if (command.tasks.length === 0) {
			throw new OutdoError("usage", "run requires at least one task name.");
		}
	} else if (first === "ci") {
		if (positionals[0] === "init") {
			command = {
				kind: "ci-init",
			};
		} else {
			flags.ci = true;
			// `outdo ci check --all` reads naturally; ci's own flags may follow the tasks.
			const run = runLike();
			let all = values.all === true;
			let base = values.base as string | undefined;
			const taskArgv: string[] = [];
			for (let i = 0; i < run.taskArgv.length; i++) {
				const token = run.taskArgv[i] as string;
				if (token === "--all") {
					all = true;
				} else if (token === "--base" && run.taskArgv[i + 1] !== undefined) {
					base = run.taskArgv[++i];
				} else if (token.startsWith("--base=")) {
					base = token.slice("--base=".length);
				} else {
					taskArgv.push(token);
				}
			}
			command = {
				kind: "ci",
				...run,
				taskArgv,
				all,
				base,
			};
			if (command.tasks.length === 0) {
				throw new OutdoError("usage", 'ci requires a task name, e.g. "outdo ci check" (or "outdo ci init").');
			}
		}
	} else if (first === "affected") {
		if (positionals.length === 0) {
			throw new OutdoError("usage", "affected requires at least one task name.");
		}
		command = {
			kind: "affected",
			tasks: positionals,
			base: values.base as string | undefined,
			githubOutput: values["github-output"] === true,
		};
	} else if (first === "bg") {
		// `-f` is the global --force short alias; for `bg logs` it can only mean follow.
		command = parseBg(positionals, runLike, values.follow === true || values.force === true);
	} else if (first === "hooks") {
		const action = positionals[0] ?? "list";
		if (action !== "install" && action !== "uninstall" && action !== "list" && action !== "run") {
			throw new OutdoError("usage", `Unknown hooks action "${action}". Use: install, uninstall, list, run <hook>.`);
		}
		if (action === "run" && positionals[1] === undefined) {
			throw new OutdoError("usage", "hooks run requires a hook name, e.g. pre-commit.");
		}
		command = {
			kind: "hooks",
			action,
			hook: positionals[1],
			rest,
		};
	} else if (first === "prune") {
		if (values.docker !== true) {
			throw new OutdoError("usage", 'prune needs --docker (the only mode so far): "outdo prune --docker".');
		}
		command = {
			kind: "prune",
			out: (values.out as string | undefined) ?? "out",
		};
	} else if (first === "mcp") {
		command = {
			kind: "mcp",
		};
	} else if (first === "skill") {
		const action = positionals[0] ?? "install";
		if (action !== "install" && action !== "path") {
			throw new OutdoError("usage", `Unknown skill action "${action}". Use: install [--global], path.`);
		}
		command = {
			kind: "skill",
			action,
			global: values.global === true,
		};
	} else if (first === "doctor") {
		command = {
			kind: "doctor",
		};
	} else if (first === "graph") {
		command = {
			kind: "graph",
			dot: values.dot === true,
		};
	} else if (first === "init") {
		command = {
			kind: "init",
		};
	} else if (first === "completion") {
		command = {
			kind: "completion",
			shell: positionals[0],
		};
	} else if (first === "explain") {
		if (positionals.length !== 1) {
			throw new OutdoError("usage", "explain requires exactly one task name.");
		}
		command = {
			kind: "explain",
			task: positionals[0] as string,
		};
	} else {
		command = {
			kind: "run",
			...runLike(),
		};
	}

	return {
		command,
		flags,
	};
}

function parseBg(positionals: string[], runLike: () => RunLike, follow: boolean): Command {
	const verb = positionals[0] ?? "ps";
	switch (verb) {
		case "start": {
			const run = runLike();
			if (run.tasks.length === 0) {
				throw new OutdoError("usage", "bg start requires a task name.");
			}
			return {
				kind: "bg-start",
				...run,
			};
		}
		case "stop":
			return {
				kind: "bg-stop",
				tasks: positionals.slice(1),
			};
		case "ps":
			return {
				kind: "bg-ps",
			};
		case "logs": {
			const task = positionals[1];
			if (task === undefined) {
				throw new OutdoError("usage", "bg logs requires a task name.");
			}
			return {
				kind: "bg-logs",
				task,
				follow,
			};
		}
		default:
			throw new OutdoError("usage", `Unknown bg action "${verb}". Use: start <task>, stop [task], ps, logs <task>.`);
	}
}

/**
 * Pull runner flags (--mode, --yes, --from, --until) out of a task's own argv
 * when the task does not declare a flag of that name itself, so
 * `outdo up --mode prod` works as well as `outdo --mode prod up`. The short
 * forms `-y` / `-m` count too, unless the task claims that alias.
 */
export function extractRunnerFlags(
	argv: readonly string[],
	taskFlags: ReadonlySet<string>,
	taskShorts: ReadonlySet<string> = new Set(),
): {
	argv: string[];
	mode?: string;
	yes?: boolean;
	from?: string;
	until?: string;
} {
	const out: string[] = [];
	const found: {
		mode?: string;
		yes?: boolean;
		from?: string;
		until?: string;
	} = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string;
		const eq = token.indexOf("=");
		const long = token.startsWith("--") ? token.slice(2, eq === -1 ? undefined : eq) : undefined;
		const short = /^-([ym])(?:=|$)/.exec(token)?.[1];
		const name =
			long
			?? (short === "y" && !taskShorts.has("y") ? "yes" : short === "m" && !taskShorts.has("m") ? "mode" : undefined);
		if (name === "yes" && eq === -1 && !taskFlags.has("yes")) {
			found.yes = true;
			continue;
		}
		if ((name === "mode" || name === "from" || name === "until") && !taskFlags.has(name)) {
			const value = eq === -1 ? argv[i + 1] : token.slice(eq + 1);
			if (value === undefined || (eq === -1 && value.startsWith("-"))) {
				throw new OutdoError("usage", `--${name} requires a value.`);
			}
			if (eq === -1) {
				i++;
			}
			found[name] = value;
			continue;
		}
		out.push(token);
	}
	return {
		argv: out,
		...found,
	};
}

/**
 * Whether error output should be the machine JSON envelope: --json counts
 * only in the global zone (before `--`, and before a task name — tokens after
 * a task name belong to the task; subcommands still accept globals anywhere).
 * Used by the top-level error handler, which may run before/without parseCli.
 */
export function wantsJsonErrors(argv: readonly string[]): boolean {
	let inSubcommand = false;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string;
		if (token === "--") {
			return false;
		}
		if (token === "--json") {
			return true;
		}
		if (token.startsWith("-") && token !== "-") {
			if (!token.includes("=") && VALUE_FLAGS.has(token)) {
				i++; // skip this flag's value
			}
			continue;
		}
		if (SUBCOMMANDS.has(token) && !RUN_LIKE.has(token)) {
			inSubcommand = true;
			continue;
		}
		if (!inSubcommand && !RUN_LIKE.has(token)) {
			return false; // task name — everything after belongs to the task
		}
	}
	return false;
}

function parseConcurrency(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n) || n < 1 || String(n) !== value.trim()) {
		throw new OutdoError("usage", `Invalid --concurrency "${value}" — expected a positive integer.`);
	}
	return n;
}

export function defaultsOnly(): GlobalFlags {
	return {
		json: false,
		help: false,
		version: false,
		color: "auto",
		watch: false,
		concurrency: undefined,
		continueOnError: false,
		logOrder: "auto",
		outputLogs: "full",
		dry: false,
		force: false,
		filter: [],
		isolate: false,
		affected: false,
		profile: false,
		mode: undefined,
		yes: false,
		from: undefined,
		until: undefined,
		ci: false,
	};
}
