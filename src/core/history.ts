/**
 * Shell history as usage evidence: the outdo commands (and `bun run <script>`
 * calls) you typed before outdo recorded anything.
 *
 * History has no working directory, so a name typed in another repo counts
 * here too. It is only ever used as "this was used" — it can keep a task off
 * the unused list, never put one on it.
 *
 * Read-only, local, and never stored: `outdo usage` parses it on each call.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface HistoryEntry {
	/** Epoch ms, when the shell records it (zsh extended history, fish, bash with HISTTIMEFORMAT). */
	t: number | undefined;
	command: string;
}

/** One outdo-relevant call found in a history command. */
export type HistoryCall =
	| {
			kind: "outdo";
			/** Words after `outdo` (`bunx outdo`, `bun x outdo`, ...). */
			argv: string[];
	  }
	| {
			kind: "script";
			/** `bun run <script>` / `bun <script>`. */
			script: string;
	  };

/** History files to read: $HISTFILE, then each shell's default location. */
export function historyFiles(
	env: Readonly<Record<string, string | undefined>> = process.env,
	home: string = homedir(),
): string[] {
	const candidates = [
		env.HISTFILE,
		join(home, ".zsh_history"),
		join(home, ".bash_history"),
		join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "fish", "fish_history"),
		join(home, ".local", "share", "powershell", "PSReadLine", "ConsoleHost_history.txt"),
		...(env.APPDATA !== undefined
			? [
					join(env.APPDATA, "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"),
				]
			: []),
	];
	const out: string[] = [];
	for (const path of candidates) {
		if (path !== undefined && path !== "" && !out.includes(path) && existsSync(path)) {
			out.push(path);
		}
	}
	return out;
}

const ZSH_LINE = /^: (\d+):\d+;(.*)$/;

/** Parse a history file's text; the format is told apart by name and content. */
export function parseHistory(text: string, file: string): HistoryEntry[] {
	const lines = text.split(/\r?\n/);
	const entries: HistoryEntry[] = [];
	const name = basename(file);
	if (name === "fish_history") {
		let current: HistoryEntry | undefined;
		for (const line of lines) {
			const cmd = /^- cmd: (.*)$/.exec(line);
			if (cmd !== undefined && cmd !== null) {
				current = {
					t: undefined,
					command: (cmd[1] as string).replaceAll("\\n", "\n").replaceAll("\\\\", "\\"),
				};
				entries.push(current);
				continue;
			}
			const when = /^\s+when: (\d+)$/.exec(line);
			if (when !== null && current !== undefined) {
				current.t = Number(when[1]) * 1000;
			}
		}
		return entries;
	}
	// zsh (plain or extended), bash (optionally `#<epoch>` lines), PSReadLine.
	// A trailing `\` (zsh, bash) or backtick (PowerShell) continues a command.
	let pendingTime: number | undefined;
	let current: HistoryEntry | undefined;
	let continues = false;
	for (const line of lines) {
		if (continues && current !== undefined) {
			current.command += `\n${line}`;
		} else {
			const zsh = ZSH_LINE.exec(line);
			const stamp = /^#(\d{9,})$/.exec(line);
			if (stamp !== null) {
				pendingTime = Number(stamp[1]) * 1000;
				continue;
			}
			if (line === "") {
				continue;
			}
			current = {
				t: zsh !== null ? Number(zsh[1]) * 1000 : pendingTime,
				command: zsh !== null ? (zsh[2] as string) : line,
			};
			pendingTime = undefined;
			entries.push(current);
		}
		continues = /(?:\\|`)$/.test(line);
		if (continues) {
			current.command = current.command.slice(0, -1);
		}
	}
	return entries;
}

/** Split a command line into simple commands (`&&`, `||`, `;`, `|`, newlines) of words. */
export function splitCommand(command: string): string[][] {
	const out: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: string | undefined;
	const endWord = (): void => {
		if (inWord) {
			words.push(word);
		}
		word = "";
		inWord = false;
	};
	const endCommand = (): void => {
		endWord();
		if (words.length > 0) {
			out.push(words);
		}
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i] as string;
		if (quote !== undefined) {
			if (c === quote) {
				quote = undefined;
			} else {
				word += c;
			}
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			inWord = true;
		} else if (c === "&" || c === "|" || c === ";" || c === "\n" || c === "(" || c === ")") {
			endCommand();
		} else if (c === " " || c === "\t") {
			endWord();
		} else {
			word += c;
			inWord = true;
		}
	}
	endCommand();
	return out;
}

/** Bun's own commands: `bun <name>` with one of these is not a script. */
const BUN_COMMANDS = new Set([
	"add",
	"audit",
	"build",
	"create",
	"exec",
	"i",
	"info",
	"init",
	"install",
	"link",
	"outdated",
	"patch",
	"pm",
	"publish",
	"remove",
	"repl",
	"rm",
	"run",
	"test",
	"unlink",
	"update",
	"upgrade",
	"why",
	"x",
]);

/** Words that only wrap the command that follows them. */
const WRAPPERS = new Set([
	"builtin",
	"command",
	"exec",
	"noglob",
	"nohup",
	"sudo",
	"time",
]);

function isOutdo(word: string | undefined): boolean {
	if (word === undefined) {
		return false;
	}
	const bare = word.replace(/^.*[\\/]/, "").replace(/@[^/@]*$/, "");
	return bare === "outdo" || word.replace(/@[^/@]*$/, "") === "@meslzy/outdo";
}

/** The outdo calls and `bun run <script>` calls in one history command. */
export function callsIn(command: string): HistoryCall[] {
	const calls: HistoryCall[] = [];
	for (let words of splitCommand(command)) {
		while (words.length > 0 && (/^[A-Za-z_]\w*=/.test(words[0] as string) || WRAPPERS.has(words[0] as string))) {
			words = words.slice(1);
		}
		const [first, second] = words;
		if (isOutdo(first)) {
			calls.push({
				kind: "outdo",
				argv: words.slice(1),
			});
			continue;
		}
		if (first === "bunx" || (first === "bun" && second === "x")) {
			const after = words.slice(first === "bunx" ? 1 : 2);
			const at = after.findIndex((w) => !w.startsWith("-"));
			if (at !== -1 && isOutdo(after[at])) {
				calls.push({
					kind: "outdo",
					argv: after.slice(at + 1),
				});
			}
			continue;
		}
		if (first === "bun" && second !== undefined) {
			const after = words.slice(second === "run" ? 2 : 1);
			const script = after.find((w) => !w.startsWith("-"));
			if (
				script !== undefined
				&& !/[./\\]/.test(script)
				&& (second === "run" || !BUN_COMMANDS.has(script))
				&& !(second === "run" && script !== after[0] && after.includes("--filter"))
			) {
				calls.push({
					kind: "script",
					script,
				});
			}
		}
	}
	return calls;
}

export interface ShellHistory {
	files: string[];
	entries: HistoryEntry[];
}

/** Read every history file that exists (unreadable ones are skipped). */
export function readShellHistory(files: readonly string[] = historyFiles()): ShellHistory {
	const read: string[] = [];
	const entries: HistoryEntry[] = [];
	for (const file of files) {
		try {
			entries.push(...parseHistory(readFileSync(file, "latin1"), file));
			read.push(file);
		} catch {
			// unreadable: skip
		}
	}
	return {
		files: read,
		entries,
	};
}
