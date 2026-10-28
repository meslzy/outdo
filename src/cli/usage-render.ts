/**
 * `outdo usage` output: the report and one task's view, plus the --since
 * parser. Kept apart from the command so it can be unit-tested without
 * loading the run planner.
 */

import { OutdoError } from "~/core/errors";
import { bold, dim, yellow } from "~/core/logger";
import type { Duplicate, TaskUsage, UsageReport } from "~/core/usage-report";
import { MIN_RUNS, usageScore, YOUNG_MS } from "~/core/usage-report";

const DAY = 24 * 60 * 60 * 1000;

/** `30d`, `2w`, `12h` or a date (`2026-10-01`) -> epoch ms. */
export function parseSince(value: string, now = Date.now()): number {
	const relative = /^(\d+)([hdw])$/.exec(value);
	if (relative !== null) {
		const unit = {
			h: 60 * 60 * 1000,
			d: DAY,
			w: 7 * DAY,
		}[relative[2] as "h" | "d" | "w"];
		return now - Number(relative[1]) * unit;
	}
	const date = Date.parse(value);
	if (/^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(date)) {
		return date;
	}
	throw new OutdoError("usage", `--since "${value}": use a span like 30d, 2w, 12h, or a date like 2026-10-01.`);
}

function day(t: number, now: number): string {
	const date = new Date(t);
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		...(sameYear
			? {}
			: {
					year: "numeric",
				}),
	});
}

export function ago(t: number, now: number): string {
	const s = Math.max(0, now - t) / 1000;
	if (s < 60) {
		return "just now";
	}
	if (s < 3600) {
		return `${Math.floor(s / 60)}m ago`;
	}
	if (s < 86_400) {
		return `${Math.floor(s / 3600)}h ago`;
	}
	const days = Math.floor(s / 86_400);
	return days < 30 ? `${days}d ago` : day(t, now);
}

export function duration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return minutes < 60 ? `${minutes}m ${seconds}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const num = (n: number): string => (n === 0 ? "-" : String(n));

function table(rows: string[][], align: ("l" | "r")[]): string[] {
	const widths = align.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
	return rows.map((row) =>
		row
			.map((cell, i) => (align[i] === "r" ? cell.padStart(widths[i] as number) : cell.padEnd(widths[i] as number)))
			.join("  ")
			.trimEnd(),
	);
}

function describeDuplicate(dup: Duplicate): string {
	const pkgJson = (pkg: string): string => (pkg === "" ? "package.json" : `${pkg} package.json`);
	switch (dup.kind) {
		case "hidden-script":
			return `${pkgJson(dup.pkg)} "${dup.script}" (${dup.command}) never runs through outdo: do.ts "${dup.task}" replaces it${
				dup.typed > 0 ? ` — but "bun run ${dup.script}" was typed ${dup.typed}× (that still runs the script)` : ""
			}`;
		case "runs-own-script":
			return `"${dup.task}" runs "${dup.command}": drop its run — a do.ts entry without one runs the same-named script`;
		case "alias":
			return `"${dup.task}" only runs "${dup.of}" (${dup.command}): keep one`;
		case "same-command":
			return `${dup.tasks.map((t) => `"${t}"`).join(", ")} run the same command: ${dup.command}`;
		case "same-steps":
			return `${dup.tasks.map((t) => `"${t}"`).join(", ")} do the same thing: ${dup.steps.join(" → ")}`;
		case "outdo-script":
			return `${pkgJson(dup.pkg)} "${dup.script}" only calls "${dup.command}": outdo runs do.ts tasks itself — keep it only if something runs "bun run ${dup.script}"`;
	}
}

/** Whether a duplicate finding concerns this task. */
export function involves(dup: Duplicate, name: string): boolean {
	switch (dup.kind) {
		case "same-command":
		case "same-steps":
			return dup.tasks.includes(name);
		case "alias":
			return dup.task === name || dup.of === name;
		case "outdo-script":
			return false;
		default:
			return dup.task === name;
	}
}

/** Flags of a task that ran at least MIN_RUNS times and never got them. */
function unusedFlags(task: TaskUsage): string[] {
	return task.flags.filter((f) => !f.required && f.given === 0 && f.runs >= MIN_RUNS).map((f) => `--${f.flag}`);
}

function header(report: UsageReport): string {
	const parts: string[] = [];
	if (report.runs === 0) {
		parts.push("no runs recorded yet — outdo records every run from now on (.outdo/usage.jsonl)");
	} else {
		parts.push(
			`${report.runs} run${report.runs === 1 ? "" : "s"} recorded since ${day(report.firstRun as number, report.now)}`,
		);
	}
	if (report.history.calls > 0) {
		parts.push(
			`shell history: ${report.history.calls} call${report.history.calls === 1 ? "" : "s"}${
				report.history.from !== undefined ? ` since ${day(report.history.from, report.now)}` : ""
			}`,
		);
	}
	if (report.since !== undefined) {
		parts.push(`window: since ${day(report.since, report.now)}`);
	}
	return dim(parts.join(" · "));
}

export function renderUsage(report: UsageReport, all: boolean): string {
	const lines: string[] = [
		header(report),
	];
	const { now } = report;
	const section = (title: string): void => {
		lines.push("", bold(title));
	};

	const ranked = report.tasks
		.filter((t) => all || usageScore(t) > 0)
		.sort((a, b) => usageScore(b) - usageScore(a) || a.name.localeCompare(b.name));
	const shown = all ? ranked : ranked.filter((t) => t.you + t.agent + t.typed + t.hooks > 0).slice(0, 15);
	if (shown.length > 0) {
		section(all ? "every task" : "most used");
		const rows = [
			[
				"",
				"you",
				"agent",
				"as dep",
				"shell",
				"last",
				"avg",
				"fails",
			],
			...shown.map((t) => [
				t.name,
				num(t.you),
				num(t.agent),
				num(t.deps),
				num(t.typed),
				t.last !== undefined ? ago(t.last, now) : "-",
				t.service ? "service" : t.avgMs !== undefined ? duration(t.avgMs) : "-",
				num(t.fails),
			]),
		];
		const rendered = table(rows, [
			"l",
			"r",
			"r",
			"r",
			"r",
			"r",
			"r",
			"r",
		]);
		lines.push(dim(`  ${rendered[0]}`), ...rendered.slice(1).map((r) => `  ${r}`));
		const more = ranked.length - shown.length;
		if (!all && more > 0) {
			lines.push(dim(`  … ${more} more ran only as dependencies (outdo usage --all)`));
		}
	}

	const unused = report.tasks.filter((t) => t.status === "unused");
	const rootUnused = unused.filter((t) => !t.name.includes("#"));
	const memberUnused = unused.filter((t) => t.name.includes("#"));
	const unusedNames = new Set(unused.map((t) => t.name));
	if (rootUnused.length > 0) {
		section(
			`unused — ${rootUnused.length} task${rootUnused.length === 1 ? "" : "s"}: never run, not in shell history, and nothing that runs uses them`,
		);
		const rows = rootUnused.map((t) => {
			const notes: string[] = [];
			if (t.usedBy.length > 0) {
				notes.push(
					`only used by ${t.usedBy.join(", ")}${t.usedBy.every((u) => unusedNames.has(u)) ? " (unused too)" : ""}`,
				);
			}
			// Added after tracking began: say so, it has had less time to be used.
			if (
				t.firstSeen !== undefined
				&& report.trackedSince !== undefined
				&& t.firstSeen - report.trackedSince > DAY
				&& now - t.firstSeen < YOUNG_MS
			) {
				notes.push(`added ${ago(t.firstSeen, now)}`);
			}
			return [
				t.name,
				t.kind === "script" ? "package.json" : (t.group ?? ""),
				notes.join(" · "),
			];
		});
		for (const row of table(rows, [
			"l",
			"l",
			"l",
		])) {
			lines.push(`  ${row}`);
		}
	}
	if (memberUnused.length > 0) {
		section(`workspace scripts that never ran through outdo — ${memberUnused.length}`);
		lines.push(dim("  turbo, bun --filter or a container may still run them; outdo only sees what it runs"));
		const byPkg = new Map<string, string[]>();
		for (const t of memberUnused) {
			const [pkg, local] = t.name.split("#") as [
				string,
				string,
			];
			byPkg.set(pkg, [
				...(byPkg.get(pkg) ?? []),
				local,
			]);
		}
		for (const [pkg, names] of byPkg) {
			lines.push(`  ${pkg}: ${names.join(", ")}`);
		}
	}

	const referenced = report.tasks.filter((t) => t.status === "referenced" && !t.name.includes("#"));
	if (referenced.length > 0) {
		section("never run here, but something uses them");
		for (const row of table(
			referenced.map((t) => [
				t.name,
				`← ${t.usedBy.join(", ")}`,
			]),
			[
				"l",
				"l",
			],
		)) {
			lines.push(`  ${row}`);
		}
	}

	const flagRows = report.tasks
		.map((t) => ({
			task: t,
			flags: unusedFlags(t),
		}))
		.filter((r) => r.flags.length > 0);
	if (flagRows.length > 0) {
		section(`flags never passed — tasks asked for ${MIN_RUNS}+ times`);
		for (const row of table(
			flagRows.map(({ task, flags }) => [
				task.name,
				flags.join(" "),
				dim(`(${Math.max(...task.flags.map((f) => f.runs))} runs)`),
			]),
			[
				"l",
				"l",
				"l",
			],
		)) {
			lines.push(`  ${row}`);
		}
	}

	const choiceRows = report.tasks.flatMap((t) =>
		t.flags
			.filter((f) => f.unusedValues !== undefined)
			.map((f) => [
				`${t.name} --${f.flag}`,
				(f.unusedValues ?? []).join(", "),
				dim(`(${f.runs} runs)`),
			]),
	);
	if (choiceRows.length > 0) {
		section("choices never picked");
		for (const row of table(choiceRows, [
			"l",
			"l",
			"l",
		])) {
			lines.push(`  ${row}`);
		}
	}

	const counts: string[] = [];
	if (report.modes.length > 0 && report.runs > 0) {
		counts.push(`${bold("modes")}  ${report.modes.map((m) => `${m.name} ${m.runs}`).join(dim(" · "))}`);
	}
	if (report.hooks.length > 0) {
		counts.push(`${bold("hooks")}  ${report.hooks.map((h) => `${h.name} ${h.runs}`).join(dim(" · "))}`);
	}
	if (counts.length > 0) {
		lines.push("", ...counts);
	}

	if (report.duplicates.length > 0) {
		section(`duplicates — ${report.duplicates.length}`);
		for (const dup of report.duplicates) {
			lines.push(`  ${describeDuplicate(dup)}`);
		}
	}

	const age = report.trackedSince === undefined ? 0 : now - report.trackedSince;
	if (rootUnused.length > 0 && age < YOUNG_MS) {
		lines.push(
			"",
			yellow(
				`tracking started ${report.trackedSince === undefined ? "now" : ago(report.trackedSince, now)}: give it a couple of weeks before deleting tasks for being unused. Duplicates are safe to act on now.`,
			),
		);
	}
	lines.push("", dim("one task: outdo usage <task> · everything: --all · for scripts and agents: --json"));
	return lines.join("\n");
}

export function renderTaskUsage(report: UsageReport, task: TaskUsage): string {
	const { now } = report;
	const lines = [
		`${bold(task.name)}${task.desc !== undefined ? dim(` — ${task.desc}`) : ""}`,
		header(report),
		"",
	];
	const row = (label: string, value: string): void => {
		lines.push(`  ${dim(label.padEnd(10))}${value}`);
	};
	row(
		"asked for",
		`you ${task.you} · agent ${task.agent} · hooks ${task.hooks} · shell history ${task.typed} · as a dependency ${task.deps}`,
	);
	const timing: string[] = [
		task.last !== undefined ? `last ${ago(task.last, now)}` : "never run",
	];
	if (task.avgMs !== undefined) {
		timing.push(`avg ${duration(task.avgMs)}`);
	}
	if (task.fails > 0) {
		timing.push(`${task.fails} failed`);
	}
	row("runs", timing.join(" · "));
	row(
		"status",
		task.status === "used"
			? "used"
			: task.status === "referenced"
				? "never run, but something uses it"
				: yellow("unused"),
	);
	if (task.usedBy.length > 0) {
		row("used by", task.usedBy.join(", "));
	}
	if (task.firstSeen !== undefined) {
		row("tracked", `since ${day(task.firstSeen, now)}`);
	}
	if (task.flags.length > 0) {
		lines.push("", `  ${dim("flags")}`);
		const rows = task.flags.map((f) => {
			const values =
				f.values === undefined
					? ""
					: Object.entries(f.values)
							.sort((a, b) => b[1] - a[1])
							.map(([v, n]) => `${v} ${n}`)
							.join(" · ");
			const notes = [
				f.given === 0 ? (f.runs >= MIN_RUNS && !f.required ? yellow("never passed") : "never passed") : `${f.given}×`,
				values,
				f.unusedValues !== undefined ? yellow(`never: ${f.unusedValues.join(", ")}`) : "",
			].filter(Boolean);
			return [
				`--${f.flag}`,
				notes.join("  "),
				dim(`${f.runs} run${f.runs === 1 ? "" : "s"} since added`),
			];
		});
		for (const r of table(rows, [
			"l",
			"l",
			"l",
		])) {
			lines.push(`    ${r}`);
		}
	}
	const dups = report.duplicates.filter((d) => involves(d, task.name));
	if (dups.length > 0) {
		lines.push("", `  ${dim("duplicates")}`);
		for (const dup of dups) {
			lines.push(`    ${describeDuplicate(dup)}`);
		}
	}
	return lines.join("\n");
}
