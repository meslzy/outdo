/** Per-task flag parsing (ArgSpec records -> parseArgs) and task help. */

import { parseArgs } from "node:util";
import { BundoError } from "~/core/errors";
import { bold, cyan, dim } from "~/core/logger";
import type { Task } from "~/core/model";
import { didYouMean } from "~/core/util";

export function parseTaskArgs(task: Task, argv: readonly string[]): Record<string, string | boolean | undefined> {
	const options: Record<
		string,
		{
			type: "string" | "boolean";
			short?: string;
			default?: string | boolean;
		}
	> = {};
	for (const [flag, spec] of Object.entries(task.args)) {
		options[flag] = {
			type: spec.type,
			...(spec.short !== undefined
				? {
						short: spec.short,
					}
				: {}),
			...(spec.default !== undefined
				? {
						default: spec.default,
					}
				: {}),
		};
	}

	let values: Record<string, unknown>;
	try {
		({ values } = parseArgs({
			args: [
				...argv,
			],
			options: options as NonNullable<Parameters<typeof parseArgs>[0]>["options"],
			strict: true,
			allowPositionals: false,
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
		const unknown = /'--?([^']+)'/.exec(String(message))?.[1];
		let hint = "";
		if (unknown !== undefined) {
			const close = didYouMean(unknown.replace(/^-+/, ""), Object.keys(task.args));
			if (close !== undefined) {
				hint = ` Did you mean "--${close}"?`;
			} else {
				hint = ` Global flags go before the task name; see "bundo --help".`;
			}
		}
		throw new BundoError("usage", `Task "${task.name}": ${message}${hint}`, {
			task: task.name,
		});
	}

	const out: Record<string, string | boolean | undefined> = {};
	const missing: string[] = [];
	for (const [flag, spec] of Object.entries(task.args)) {
		let value = values[flag] as string | boolean | undefined;
		if (spec.type === "boolean" && value === undefined) {
			value = spec.default === true;
		}
		if (spec.required === true && value === undefined) {
			missing.push(flag);
		}
		out[flag] = value;
	}
	if (missing.length > 0) {
		throw new BundoError(
			"usage",
			`Task "${task.name}" requires ${missing.map((f) => `--${f}`).join(", ")}. See "bundo ${task.name} --help".`,
			{
				task: task.name,
				missing,
			},
		);
	}
	return out;
}

/** True when the task itself does not claim -h/--help as a flag. */
export function wantsTaskHelp(task: Task, argv: readonly string[]): boolean {
	const claimsShortH = Object.values(task.args).some((spec) => spec.short === "h");
	const claimsHelp = "help" in task.args;
	return argv.some((token) => (token === "--help" && !claimsHelp) || (token === "-h" && !claimsShortH));
}

export function renderTaskHelp(task: Task): string {
	const lines: string[] = [];
	lines.push(`${bold(task.name)}${task.desc === undefined ? "" : ` — ${task.desc}`}`);
	lines.push("");
	lines.push(`Usage: bundo ${task.name}${Object.keys(task.args).length > 0 ? " [flags]" : ""} [-- args]`);
	if (task.deps.length > 0) {
		lines.push(`Deps:  ${task.deps.join(", ")}`);
	}
	const entries = Object.entries(task.args);
	if (entries.length > 0) {
		lines.push("");
		lines.push("Flags");
		const width = Math.max(...entries.map(([flag]) => flag.length));
		for (const [flag, spec] of entries) {
			const short = spec.short === undefined ? "    " : `-${spec.short}, `;
			const name = `--${flag.padEnd(width)}`;
			const meta: string[] = [];
			if (spec.type === "string") {
				meta.push("string");
			}
			if (spec.required === true) {
				meta.push("required");
			}
			if (spec.default !== undefined) {
				meta.push(`default: ${JSON.stringify(spec.default)}`);
			}
			const suffix = meta.length > 0 ? ` ${dim(`(${meta.join(", ")})`)}` : "";
			lines.push(`  ${short}${cyan(name)}  ${spec.description ?? ""}${suffix}`);
		}
	}
	if (task.env !== undefined) {
		lines.push("");
		lines.push(dim(`env: validated by schema — inspect with "bundo --print-env ${task.name}"`));
	}
	return lines.join("\n");
}
