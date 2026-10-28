/**
 * GitHub Actions integration: base-rev detection for --affected / `outdo ci`,
 * workflow-command annotations, the job step summary, and $GITHUB_OUTPUT.
 * Everything is a no-op outside Actions except base detection's env reads.
 */

import { appendFileSync, readFileSync } from "node:fs";
import type { RunReport } from "~/core/report";
import { formatMs } from "~/core/report";

export function inGithubActions(env: Record<string, string | undefined> = process.env): boolean {
	return env.GITHUB_ACTIONS === "true";
}

export type GithubBase =
	| {
			/** Compare against the merge-base with this remote branch (pull requests). */
			branch: string;
	  }
	| {
			/** Compare against this exact commit (pushes: the previous tip). */
			commit: string;
	  };

/** The natural base for this workflow run, from the Actions environment. */
export function githubBase(env: Record<string, string | undefined> = process.env): GithubBase | undefined {
	if (env.GITHUB_BASE_REF !== undefined && env.GITHUB_BASE_REF !== "") {
		return {
			branch: `origin/${env.GITHUB_BASE_REF}`,
		};
	}
	if (env.GITHUB_EVENT_NAME === "push" && env.GITHUB_EVENT_PATH !== undefined) {
		try {
			const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as {
				before?: unknown;
			};
			if (typeof event.before === "string" && /^[0-9a-f]{7,64}$/.test(event.before) && !/^0+$/.test(event.before)) {
				return {
					commit: event.before,
				};
			}
		} catch {
			// unreadable event payload — fall back to the generic detection
		}
	}
	return undefined;
}

function escapeData(text: string): string {
	return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(text: string): string {
	return escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export interface Annotation {
	file?: string;
	line?: number;
	col?: number;
	title: string;
	message: string;
}

export function formatAnnotation(a: Annotation): string {
	const props = [
		a.file !== undefined ? `file=${escapeProperty(a.file)}` : undefined,
		a.line !== undefined ? `line=${a.line}` : undefined,
		a.col !== undefined ? `col=${a.col}` : undefined,
		`title=${escapeProperty(a.title)}`,
	].filter((p) => p !== undefined);
	return `::error ${props.join(",")}::${escapeData(a.message)}`;
}

// tsc:   src/a.ts(12,5): error TS2322: Type 'x' is not assignable ...
const TSC = /^(?<file>[^\s()]+)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+): (?<msg>.+)$/;
// biome: src/a.ts:12:5 lint/style/useConst FIXABLE ━━━━━━━━━━━━━━━━━━━━━
const BIOME = /^(?<file>[^\s:]+\.[a-z]+):(?<line>\d+):(?<col>\d+) (?<rule>[\w/]+)(?: [A-Z]+)? ━/;
// bun test: (fail) suite > name [12.00ms]
const BUN_FAIL = /^\(fail\) (?<name>.+?)(?: \[[\d.]+m?s\])?$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI color codes
const ANSI = /\x1b\[[0-9;]*m/g;

/** File-level annotations recognized in a failed task's output (tsc, biome, bun test). */
export function annotationsFromOutput(task: string, lines: readonly string[]): Annotation[] {
	const out: Annotation[] = [];
	for (const raw of lines) {
		const line = raw.replace(ANSI, "").trim();
		const tsc = TSC.exec(line)?.groups;
		if (tsc !== undefined) {
			out.push({
				file: tsc.file,
				line: Number(tsc.line),
				col: Number(tsc.col),
				title: `${task}: ${tsc.code}`,
				message: tsc.msg as string,
			});
			continue;
		}
		const biome = BIOME.exec(line)?.groups;
		if (biome !== undefined) {
			out.push({
				file: biome.file,
				line: Number(biome.line),
				col: Number(biome.col),
				title: `${task}: ${biome.rule}`,
				message: biome.rule as string,
			});
			continue;
		}
		const fail = BUN_FAIL.exec(line)?.groups;
		if (fail !== undefined) {
			out.push({
				title: `${task}: test failed`,
				message: fail.name as string,
			});
		}
	}
	return out;
}

/** Markdown table for $GITHUB_STEP_SUMMARY. */
export function summaryMarkdown(title: string, report: RunReport): string {
	const icon: Record<string, string> = {
		ok: "✅",
		failed: "❌",
		skipped: "⏭️",
		aborted: "⏹️",
		running: "🟢",
	};
	const rows = report.tasks.map(
		(t) =>
			`| ${icon[t.status] ?? ""} \`${t.name}\` | ${t.status} | ${t.cache === "hit" ? "cached" : formatMs(t.durationMs)} |`,
	);
	const s = report.summary;
	return [
		`### ${report.ok ? "✅" : "❌"} ${title}`,
		"",
		`${s.ok} ok${s.cached > 0 ? ` (${s.cached} cached)` : ""}${s.failed > 0 ? `, ${s.failed} failed` : ""}${s.skipped > 0 ? `, ${s.skipped} skipped` : ""} · ${formatMs(report.timing.totalMs)}`,
		"",
		"| Task | Status | Time |",
		"| --- | --- | --- |",
		...rows,
		"",
	].join("\n");
}

export function appendStepSummary(markdown: string, env: Record<string, string | undefined> = process.env): void {
	const path = env.GITHUB_STEP_SUMMARY;
	if (path === undefined || path === "") {
		return;
	}
	try {
		appendFileSync(path, `${markdown}\n`);
	} catch {
		// a summary is a nicety — never fail the run over it
	}
}

/** Append `key=value` lines to $GITHUB_OUTPUT. Returns false when not in Actions. */
export function writeGithubOutputs(
	values: Record<string, string>,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const path = env.GITHUB_OUTPUT;
	if (path === undefined || path === "") {
		return false;
	}
	appendFileSync(
		path,
		Object.entries(values)
			.map(([key, value]) => `${key}=${value}\n`)
			.join(""),
	);
	return true;
}

/** GitHub output names: letters, digits, `-` and `_`. */
export function outputKey(task: string): string {
	return task.replaceAll(/[^A-Za-z0-9_-]/g, "_");
}

/** The workflow `outdo ci init` writes. */
export function workflowYaml(task: string, branch: string): string {
	return `name: CI

on:
  push:
    branches: [${branch}]
  pull_request:

jobs:
  ${task.replaceAll(/[^A-Za-z0-9_-]/g, "-")}:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # outdo compares against the PR base / previous push
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx outdo ci ${task}
`;
}
