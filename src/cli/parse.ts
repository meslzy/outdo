/** Global argv parsing. Task-specific flags are re-parsed later by argspec. */

import { parseArgs } from "node:util";
import { BundoError } from "~/core/errors";
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
}

export type Command =
	| {
			kind: "list";
	  }
	| {
			kind: "run";
			tasks: string[];
			taskArgv: string[];
			rest: string[];
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

const SUBCOMMANDS = new Set([
	"ls",
	"graph",
	"init",
	"completion",
	"explain",
	"__complete",
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
]);

const COMMAND_OPTIONS: Record<
	string,
	Record<
		string,
		{
			type: "boolean" | "string";
		}
	>
> = {
	graph: {
		dot: {
			type: "boolean",
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
	throw new BundoError("usage", `Invalid value "${value}" for ${flag}. Expected one of: ${allowed.join(", ")}.`);
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
	let firstPos = head.length;
	for (let i = 0; i < head.length; i++) {
		const token = head[i] as string;
		if (token.startsWith("-") && token !== "-") {
			if (!token.includes("=") && VALUE_FLAGS.has(token)) {
				i++; // skip this flag's value
			}
			continue;
		}
		firstPos = i;
		break;
	}
	const globalArgv = head.slice(0, firstPos).map(normalizeToken);
	const tail = head.slice(firstPos);
	const first = tail[0];

	// 3. Subcommands parse their own tail flags strictly (plus globals anywhere).
	const isSub = first !== undefined && SUBCOMMANDS.has(first);
	const options = isSub
		? {
				...GLOBAL_OPTIONS,
				...COMMAND_OPTIONS[first as string],
			}
		: GLOBAL_OPTIONS;
	const parseInput = isSub
		? [
				...globalArgv,
				...tail.slice(1).map(normalizeToken),
			]
		: globalArgv;

	let values: Record<string, unknown>;
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args: parseInput,
			options: options as NonNullable<Parameters<typeof parseArgs>[0]>["options"],
			strict: true,
			allowPositionals: true,
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
		throw new BundoError("usage", `${message} Run "bundo --help" for usage.`);
	}

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
			values.profile === undefined ? false : values.profile === "" ? ".bundo/trace.json" : (values.profile as string),
	};

	const printEnv = values["print-env"] as string | undefined;

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
			throw new BundoError("usage", "--print-env requires a task name.");
		}
		command = {
			kind: "print-env",
			task: printEnv,
		};
	} else if (first === undefined) {
		command = {
			kind: "list",
		};
	} else if (first === "ls") {
		command = {
			kind: "list",
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
			throw new BundoError("usage", "explain requires exactly one task name.");
		}
		command = {
			kind: "explain",
			task: positionals[0] as string,
		};
	} else {
		// Run mode: leading bare words are task names; the remainder (flags and
		// their values) belongs to the requested task and is re-parsed later.
		const tasks: string[] = [];
		let i = 0;
		for (; i < tail.length; i++) {
			const token = tail[i] as string;
			if (token.startsWith("-") && token !== "-") {
				break;
			}
			tasks.push(token);
		}
		command = {
			kind: "run",
			tasks,
			taskArgv: tail.slice(i),
			rest,
		};
	}

	return {
		command,
		flags,
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
		if (SUBCOMMANDS.has(token)) {
			inSubcommand = true;
			continue;
		}
		if (!inSubcommand) {
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
		throw new BundoError("usage", `Invalid --concurrency "${value}" — expected a positive integer.`);
	}
	return n;
}

function defaultsOnly(): GlobalFlags {
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
	};
}
