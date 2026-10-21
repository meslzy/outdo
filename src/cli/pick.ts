/**
 * `outdo -i` — an interactive task picker: type to filter (fuzzy, by name and
 * description), arrows to move, Enter to run, Esc to quit. Required flags and
 * positional values are asked for afterwards (choices are listed), then the
 * task runs like `outdo <task> ...`.
 */

import type { GlobalFlags } from "~/cli/parse";
import { EXIT, OutdoError } from "~/core/errors";
import { bold, cyan, dim } from "~/core/logger";
import type { ArgDef, Task } from "~/core/model";

export interface PickItem {
	name: string;
	desc: string;
}

/**
 * Fuzzy score of `query` against an item (higher is better; -1 = no match):
 * name prefix > name substring > description substring > subsequence.
 */
export function scoreItem(item: PickItem, query: string): number {
	const q = query.toLowerCase().trim();
	if (q === "") {
		return 0;
	}
	const name = item.name.toLowerCase();
	if (name.startsWith(q)) {
		return 400 - name.length;
	}
	const inName = name.indexOf(q);
	if (inName !== -1) {
		return 300 - inName;
	}
	if (item.desc.toLowerCase().includes(q)) {
		return 200;
	}
	let at = 0;
	for (const ch of q) {
		if (ch === " ") {
			continue;
		}
		at = name.indexOf(ch, at);
		if (at === -1) {
			return -1;
		}
		at++;
	}
	return 100 - name.length;
}

export function filterItems(items: readonly PickItem[], query: string): PickItem[] {
	return items
		.map((item, index) => ({
			item,
			index,
			score: scoreItem(item, query),
		}))
		.filter((entry) => entry.score >= 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.item);
}

function choose(items: readonly PickItem[]): Promise<string | undefined> {
	const out = process.stderr;
	const stdin = process.stdin;
	const height = Math.max(3, Math.min(15, (out.rows ?? 24) - 3));
	let query = "";
	let selected = 0;
	let drawn = 0;

	const draw = (): void => {
		const matches = filterItems(items, query);
		selected = Math.min(selected, Math.max(0, matches.length - 1));
		const start = Math.max(0, selected - height + 1);
		const visible = matches.slice(start, start + height);
		const width = Math.max(0, ...visible.map((m) => m.name.length));
		const lines = [
			`${cyan(">")} ${query}${dim("▌")} ${dim(`${matches.length}/${items.length}`)}`,
			...visible.map((m, i) => {
				const line = `${m.name.padEnd(width)}  ${dim(m.desc)}`;
				return start + i === selected ? `${cyan("›")} ${bold(line)}` : `  ${line}`;
			}),
		];
		if (drawn > 0) {
			out.write(`\x1b[${drawn}A`);
		}
		out.write("\r\x1b[J");
		out.write(`${lines.join("\n")}\n`);
		drawn = lines.length;
	};

	return new Promise((resolve) => {
		const finish = (value: string | undefined): void => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			if (drawn > 0) {
				out.write(`\x1b[${drawn}A\r\x1b[J`);
			}
			out.write("\x1b[?25h");
			resolve(value);
		};
		const onData = (data: Buffer): void => {
			const key = data.toString("utf8");
			const matches = filterItems(items, query);
			if (key === "\x03" || key === "\x1b") {
				finish(undefined);
				return;
			}
			if (key === "\r" || key === "\n") {
				finish(matches[selected]?.name);
				return;
			}
			if (key === "\x1b[A" || key === "\x10") {
				selected = Math.max(0, selected - 1);
			} else if (key === "\x1b[B" || key === "\x0e") {
				selected = Math.min(matches.length - 1, selected + 1);
			} else if (key === "\x7f" || key === "\b") {
				query = query.slice(0, -1);
				selected = 0;
			} else if (key === "\x15") {
				query = "";
				selected = 0;
			} else if (!key.startsWith("\x1b") && key >= " ") {
				query += key;
				selected = 0;
			}
			draw();
		};
		out.write("\x1b[?25l");
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
		draw();
	});
}

/** Ask for one flag's value on the terminal. */
function ask(flag: string, def: ArgDef): string | undefined {
	const hint = def.choices !== undefined ? ` ${dim(`(${def.choices.join(" | ")})`)}` : "";
	const answer = prompt(
		`${cyan("?")} --${flag}${def.description !== undefined ? ` ${dim(def.description)}` : ""}${hint}`,
	);
	return answer === null || answer.trim() === "" ? undefined : answer.trim();
}

/** Build the argv for a picked task by asking for its required values. */
export function askForArgs(task: Task): string[] {
	const argv: string[] = [];
	for (const flag of task.positional) {
		const def = task.args[flag] as ArgDef;
		if (!def.required && def.choices === undefined) {
			continue;
		}
		const value = ask(flag, def);
		if (value === undefined) {
			if (def.required) {
				throw new OutdoError("usage", `--${flag} is required.`);
			}
			continue;
		}
		argv.push(value);
	}
	for (const [flag, def] of Object.entries(task.args)) {
		if (task.positional.includes(flag) || !def.required) {
			continue;
		}
		const value = ask(flag, def);
		if (value === undefined) {
			throw new OutdoError("usage", `--${flag} is required.`);
		}
		argv.push(`--${flag}=${value}`);
	}
	return argv;
}

export async function pickCommand(flags: GlobalFlags): Promise<number> {
	if (process.stdin.isTTY !== true) {
		throw new OutdoError("usage", 'outdo -i needs an interactive terminal. List tasks with "outdo".');
	}
	const { loadProjectFromCwd } = await import("~/cli/load");
	const project = await loadProjectFromCwd(flags.filter);
	const tasks = [
		...project.tasks.values(),
	].filter((task) => task.kind !== "hook");
	const items: PickItem[] = tasks
		.sort((a, b) => Number(a.name.includes("#")) - Number(b.name.includes("#")))
		.map((task) => ({
			name: task.name,
			desc: task.desc ?? "",
		}));
	const picked = await choose(items);
	if (picked === undefined) {
		return EXIT.ok;
	}
	const task = project.tasks.get(picked) as Task;
	const taskArgv = askForArgs(task);
	console.error(
		dim(
			`$ outdo ${[
				picked,
				...taskArgv,
			].join(" ")}`,
		),
	);
	const { runCommand } = await import("~/cli/run");
	return await runCommand(
		{
			kind: "run",
			tasks: [
				picked,
			],
			taskArgv,
			rest: [],
		},
		flags,
	);
}
