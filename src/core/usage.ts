/**
 * The usage log: which tasks, flags and modes this repo actually uses.
 *
 * Every run appends a line to `.outdo/usage.jsonl` when it starts (what was
 * asked for, the flags given, the mode, where the run came from, whether an
 * agent ran it) and another when it ends (outcome, time per task).
 * `.outdo/usage-seen.json` remembers when each task, flag and mode first
 * appeared, so a task added yesterday is not reported as unused for a month.
 * `outdo usage` reads both back.
 *
 * Recording never throws: a read-only checkout or a full disk must not fail
 * a run. Nothing is recorded in CI (`CI` set) or under OUTDO_NO_USAGE=1.
 * Flag values are kept only for flags with fixed choices — free-form values
 * (ids, paths, messages) never reach the log.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "~/core/model";
import type { TaskResult } from "~/core/scheduler";

/** Where a run came from. */
export type UsageVia = "cli" | "pick" | "watch" | "bg" | "ci" | "hook" | "mcp" | "nested";

export interface UsageStart {
	id: string;
	/** Epoch ms. */
	t: number;
	via: UsageVia;
	/** The agent that started it (from AI_AGENT, CLAUDECODE, ...); absent when a person typed it. */
	agent?: string;
	/** The git hook, for via "hook". */
	hook?: string;
	/** Tasks asked for. */
	tasks: string[];
	/** Every planned task: the ones asked for, their deps and steps. */
	ran: string[];
	/** Flags given to the one task asked for: `name`, or `name=value` for flags with choices. */
	flags?: string[];
	mode?: string;
}

export interface UsageEnd {
	end: string;
	t: number;
	ok: boolean;
	/** Time per task that ran (cache hits excluded). */
	ms?: Record<string, number>;
	failed?: string[];
	cached?: string[];
}

export interface UsageLog {
	starts: UsageStart[];
	ends: Map<string, UsageEnd>;
	/** First time each task / `task --flag` / `mode:name` was seen (epoch ms). */
	seen: Record<string, number>;
}

/** The log is trimmed to its newer half past this size (~15k runs). */
const MAX_BYTES = 4 * 1024 * 1024;

function usageDir(rootDir: string): string {
	return join(rootDir, ".outdo");
}

export function usageLogPath(rootDir: string): string {
	return join(usageDir(rootDir), "usage.jsonl");
}

function seenPath(rootDir: string): string {
	return join(usageDir(rootDir), "usage-seen.json");
}

const set = (value: string | undefined): boolean => value !== undefined && value !== "" && value !== "0";

/** Whether this process should record runs at all. */
export function recordingEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
	return !set(env.OUTDO_NO_USAGE) && !(set(env.CI) && env.CI !== "false");
}

/** The agent running this process, if any (AI_AGENT is the cross-tool convention). */
export function agentOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
	if (set(env.AI_AGENT)) {
		return /^[A-Za-z][\w.-]*?(?=_\d|$)/.exec(env.AI_AGENT as string)?.[0] ?? (env.AI_AGENT as string);
	}
	if (set(env.CLAUDECODE)) {
		return "claude-code";
	}
	if (set(env.CODEX_SANDBOX) || set(env.CODEX_THREAD_ID)) {
		return "codex";
	}
	if (set(env.CURSOR_AGENT)) {
		return "cursor";
	}
	if (set(env.GEMINI_CLI)) {
		return "gemini";
	}
	return undefined;
}

/** Every name `outdo usage` tracks the age of: tasks, their flags, modes. */
export function seenKeys(project: Project): string[] {
	const keys: string[] = [];
	for (const task of project.tasks.values()) {
		keys.push(task.name);
		for (const flag of Object.keys(task.args)) {
			keys.push(`${task.name} --${flag}`);
		}
	}
	for (const mode of project.modes) {
		keys.push(`mode:${mode}`);
	}
	return keys;
}

function readSeen(rootDir: string): Record<string, number> {
	try {
		const parsed = JSON.parse(readFileSync(seenPath(rootDir), "utf8")) as {
			keys?: Record<string, number>;
		};
		return parsed.keys ?? {};
	} catch {
		return {};
	}
}

/** Note when names first appear (writes only when something is new; never throws). */
export function markSeen(project: Project, now = Date.now()): void {
	try {
		const seen = readSeen(project.rootDir);
		let added = false;
		for (const key of seenKeys(project)) {
			if (seen[key] === undefined) {
				seen[key] = now;
				added = true;
			}
		}
		if (!added) {
			return;
		}
		mkdirSync(usageDir(project.rootDir), {
			recursive: true,
		});
		const path = seenPath(project.rootDir);
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(
			tmp,
			JSON.stringify({
				v: 1,
				keys: seen,
			}),
		);
		renameSync(tmp, path);
	} catch {
		// best effort
	}
}

function append(rootDir: string, record: UsageStart | UsageEnd): void {
	const path = usageLogPath(rootDir);
	mkdirSync(usageDir(rootDir), {
		recursive: true,
	});
	let size = 0;
	try {
		size = statSync(path).size;
	} catch {
		// no log yet
	}
	if (size > MAX_BYTES) {
		const lines = readFileSync(path, "utf8").split("\n");
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(
			tmp,
			`${lines
				.slice(Math.floor(lines.length / 2))
				.join("\n")
				.trim()}\n`,
		);
		renameSync(tmp, path);
	}
	appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export interface RunUsage {
	via: UsageVia;
	hook?: string;
	tasks: readonly string[];
	ran: readonly string[];
	flags: readonly string[];
	mode: string;
}

export interface UsageRecorder {
	/** Append the run's outcome. */
	end(results: Iterable<TaskResult>, ok: boolean): void;
}

/**
 * Record a run as it starts. Returns undefined when recording is off; the
 * recorder's `end` adds the outcome.
 */
export function recordRun(
	project: Project,
	run: RunUsage,
	env: Readonly<Record<string, string | undefined>> = process.env,
	now = Date.now(),
): UsageRecorder | undefined {
	if (!recordingEnabled(env)) {
		return undefined;
	}
	const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const agent = agentOf(env) ?? (run.via === "mcp" ? "mcp" : undefined);
	const start: UsageStart = {
		id,
		t: now,
		via: run.via,
		...(agent !== undefined
			? {
					agent,
				}
			: {}),
		...(run.hook !== undefined
			? {
					hook: run.hook,
				}
			: {}),
		tasks: [
			...run.tasks,
		],
		ran: [
			...run.ran,
		],
		...(run.flags.length > 0
			? {
					flags: [
						...run.flags,
					],
				}
			: {}),
		...(run.mode !== ""
			? {
					mode: run.mode,
				}
			: {}),
	};
	try {
		markSeen(project, now);
		append(project.rootDir, start);
	} catch {
		return undefined;
	}
	return {
		end(results, ok) {
			const ms: Record<string, number> = {};
			const failed: string[] = [];
			const cached: string[] = [];
			for (const result of results) {
				if (result.cached === true) {
					cached.push(result.name);
				} else if (result.status === "ok" || result.status === "failed") {
					ms[result.name] = Math.round(result.durationMs);
				}
				if (result.status === "failed") {
					failed.push(result.name);
				}
			}
			const record: UsageEnd = {
				end: id,
				t: Date.now(),
				ok,
				...(Object.keys(ms).length > 0
					? {
							ms,
						}
					: {}),
				...(failed.length > 0
					? {
							failed,
						}
					: {}),
				...(cached.length > 0
					? {
							cached,
						}
					: {}),
			};
			try {
				append(project.rootDir, record);
			} catch {
				// best effort
			}
		},
	};
}

/** Parse a usage log's text (malformed lines are skipped). */
export function parseUsageLog(text: string): Pick<UsageLog, "starts" | "ends"> {
	const starts: UsageStart[] = [];
	const ends = new Map<string, UsageEnd>();
	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		try {
			const record = JSON.parse(line) as Partial<UsageStart> & Partial<UsageEnd>;
			if (typeof record.end === "string") {
				ends.set(record.end, record as UsageEnd);
			} else if (typeof record.id === "string" && typeof record.t === "number" && Array.isArray(record.tasks)) {
				starts.push({
					...(record as UsageStart),
					ran: Array.isArray(record.ran) ? record.ran : record.tasks,
				});
			}
		} catch {
			// a torn line from a concurrent write
		}
	}
	return {
		starts,
		ends,
	};
}

export function readUsageLog(rootDir: string): UsageLog {
	let text = "";
	try {
		text = readFileSync(usageLogPath(rootDir), "utf8");
	} catch {
		// nothing recorded yet
	}
	return {
		...parseUsageLog(text),
		seen: readSeen(rootDir),
	};
}
