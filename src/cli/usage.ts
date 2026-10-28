/**
 * `outdo usage [task] [--since 30d] [--all] [--no-history] [--json]`.
 *
 * What this repo's tasks are actually used for: the most used tasks (by you,
 * by agents, as dependencies), tasks nothing uses, flags never passed,
 * choices never picked, modes and hooks, and duplicate tasks/scripts. Reads
 * `.outdo/usage.jsonl` (written by every run), your shell history and the
 * files that call outdo (CI workflows, package.json scripts, Dockerfiles,
 * tasks' own code). Never runs a task.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { loadProjectFromCwd, readScripts } from "~/cli/load";
import type { Command, GlobalFlags } from "~/cli/parse";
import { extractRunnerFlags, parseCli } from "~/cli/parse";
import { resolveRequested, resolveWords } from "~/cli/plan";
import { involves, parseSince, renderTaskUsage, renderUsage } from "~/cli/usage-render";
import { givenFlags } from "~/core/argspec";
import { EXIT, OutdoError } from "~/core/errors";
import { callsIn, readShellHistory } from "~/core/history";
import type { Project, Task } from "~/core/model";
import { markSeen, readUsageLog } from "~/core/usage";
import type { Mention, PackageScripts, TypedUse, UsageReport } from "~/core/usage-report";
import { analyzeUsage } from "~/core/usage-report";

type UsageCommand = Extract<
	Command,
	{
		kind: "usage";
	}
>;

/** The tasks (and the one target's flags) an `outdo ...` argv runs in this project. */
function resolveCall(
	project: Project,
	argv: readonly string[],
):
	| {
			tasks: Task[];
			flags: string[];
	  }
	| undefined {
	try {
		const { command } = parseCli(argv);
		let words: readonly string[];
		let taskArgv: readonly string[] = [];
		if (command.kind === "run" || command.kind === "ci" || command.kind === "bg-start") {
			words = command.tasks;
			taskArgv = command.taskArgv;
		} else if (command.kind === "affected") {
			words = command.tasks;
		} else {
			return undefined;
		}
		const resolved = resolveWords(project, words, taskArgv);
		if ("namespace" in resolved) {
			return undefined;
		}
		const tasks = resolveRequested(project, resolved.names);
		let flags: string[] = [];
		if (tasks.length === 1) {
			const task = tasks[0] as Task;
			const runner = extractRunnerFlags(
				resolved.targetArgv,
				new Set(Object.keys(task.args)),
				new Set(
					Object.values(task.args)
						.map((def) => def.short)
						.filter((s): s is string => s !== undefined),
				),
			);
			flags = givenFlags(task, runner.argv);
		}
		return {
			tasks,
			flags,
		};
	} catch {
		return undefined;
	}
}

/** `outdo ...` calls inside code or config text (template literals, YAML `run:` lines, ...). */
const OUTDO_IN_TEXT =
	/(?:^|[\s`'"(;&|=/])(?:bunx[ \t]+(?:--bun[ \t]+)?|bun[ \t]+x[ \t]+)?(?:@meslzy\/)?outdo((?:[ \t]+[^\s`'"$;&|)\\]+)*)/g;
const BUN_RUN_IN_TEXT = /(?:^|[\s`'"(;&|=])bun[ \t]+run[ \t]+([A-Za-z][\w:.-]*)/g;
/** Runners that fan a script out over workspace members: `turbo run a b`, `bun --filter x a`. */
const TURBO_IN_TEXT = /(?:^|[\s`'"(;&|=])(?:bunx[ \t]+)?turbo(?:[ \t]+run)?((?:[ \t]+[A-Za-z][\w:.-]*)+)/g;
const FILTER_IN_TEXT =
	/(?:^|[\s`'"(;&|=])bun[ \t]+(?:run[ \t]+)?(?:--filter|-F)[ \t=]+(\S+)[ \t]+(?:run[ \t]+)?([A-Za-z][\w:.-]*)/g;

/** Member tasks a fan-out runner reaches: every member's script of that name, or one member's. */
function memberTargets(project: Project, script: string, filter: string | undefined): Task[] {
	const pkg = filter?.replaceAll(/^["']|["']$/g, "");
	const exact = pkg !== undefined && (project.members ?? []).some((m) => m.name === pkg);
	return [
		...project.tasks.values(),
	].filter((t) => t.name.includes("#") && t.localName === script && (!exact || t.name.startsWith(`${pkg}#`)));
}

function mentionsIn(
	project: Project,
	text: string,
	from: string,
	scriptTask: (script: string) => Task | undefined,
	out: Mention[],
): void {
	for (const match of text.matchAll(OUTDO_IN_TEXT)) {
		const argv = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
		if (argv.length === 0) {
			continue;
		}
		for (const task of resolveCall(project, argv)?.tasks ?? []) {
			out.push({
				task: task.name,
				from,
			});
		}
	}
	for (const match of text.matchAll(BUN_RUN_IN_TEXT)) {
		const task = scriptTask(match[1] as string);
		if (task !== undefined) {
			out.push({
				task: task.name,
				from,
			});
		}
	}
	const fanOut = [
		...[
			...text.matchAll(TURBO_IN_TEXT),
		].flatMap((m) =>
			(m[1] ?? "")
				.trim()
				.split(/\s+/)
				.flatMap((script) => memberTargets(project, script, undefined)),
		),
		...[
			...text.matchAll(FILTER_IN_TEXT),
		].flatMap((m) => memberTargets(project, m[2] as string, m[1])),
	];
	for (const task of fanOut) {
		out.push({
			task: task.name,
			from,
		});
	}
}

/** Files that commonly call outdo, relative to a package dir. */
const ROOT_FILES = [
	".github/workflows/*.yml",
	".github/workflows/*.yaml",
	"Makefile",
	"makefile",
	"justfile",
	"*.sh",
	"scripts/**/*.sh",
	".githooks/*",
	".husky/*",
];
const PACKAGE_FILES = [
	"Dockerfile*",
	"*.Dockerfile",
	"docker-compose*.yml",
	"docker-compose*.yaml",
	"compose*.yml",
	"compose*.yaml",
];

function packageDirOf(task: Task): string {
	return join(task.sourceConfig, "..");
}

function gatherPackages(project: Project): PackageScripts[] {
	const dirs: {
		dir: string;
		pkg: string;
	}[] = [
		{
			dir: project.rootDir,
			pkg: "",
		},
		...(project.members ?? []).map((m) => ({
			dir: m.dir,
			pkg: m.name,
		})),
	];
	const out: PackageScripts[] = [];
	for (const { dir, pkg } of dirs) {
		const path = join(dir, "package.json");
		try {
			const json = JSON.parse(readFileSync(path, "utf8")) as {
				scripts?: Record<string, unknown>;
			};
			const scripts: Record<string, string> = {};
			for (const [name, command] of Object.entries(json.scripts ?? {})) {
				if (typeof command === "string") {
					scripts[name] = command;
				}
			}
			out.push({
				dir,
				pkg,
				scripts,
				visible: new Set(Object.keys(readScripts(path))),
			});
		} catch {
			// no package.json here
		}
	}
	return out;
}

function gatherMentions(project: Project, packages: readonly PackageScripts[]): Mention[] {
	const out: Mention[] = [];
	const tasks = [
		...project.tasks.values(),
	];
	const inPackage = (dir: string) => (script: string) =>
		tasks.find((t) => t.localName === script && packageDirOf(t) === dir) ?? undefined;

	for (const task of tasks) {
		const text = [
			...(task.command ?? []),
			task.run !== undefined ? String(task.run) : "",
		].join("\n");
		if (text.trim() !== "") {
			mentionsIn(project, text, `task:${task.name}`, inPackage(packageDirOf(task)), out);
		}
	}
	for (const pkg of packages) {
		for (const [script, command] of Object.entries(pkg.scripts)) {
			const label = `${pkg.pkg === "" ? "" : `${pkg.pkg} `}package.json "${script}"`;
			mentionsIn(project, command, label, inPackage(pkg.dir), out);
		}
		const patterns =
			pkg.pkg === ""
				? [
						...ROOT_FILES,
						...PACKAGE_FILES,
					]
				: PACKAGE_FILES;
		for (const pattern of patterns) {
			for (const rel of new Glob(pattern).scanSync({
				cwd: pkg.dir,
				dot: true,
				onlyFiles: true,
			})) {
				const file = join(pkg.dir, rel);
				try {
					mentionsIn(
						project,
						// Exec-form arrays (CMD ["bun", "run", "start"]) read as one command line.
						readFileSync(file, "utf8").replaceAll(/"\s*,\s*"/g, " "),
						relative(project.rootDir, file).replaceAll("\\", "/"),
						inPackage(pkg.dir),
						out,
					);
				} catch {
					// unreadable: skip
				}
			}
		}
	}
	return out;
}

function gatherHistory(project: Project): {
	typed: TypedUse[];
	typedScripts: string[];
} {
	const typed: TypedUse[] = [];
	const typedScripts: string[] = [];
	const rootScript = (script: string): Task | undefined =>
		[
			...project.tasks.values(),
		].find((t) => !t.name.includes("#") && t.script === script && packageDirOf(t) === project.rootDir);
	for (const entry of readShellHistory().entries) {
		if (!entry.command.includes("outdo") && !entry.command.includes("bun")) {
			continue;
		}
		for (const call of callsIn(entry.command)) {
			if (call.kind === "script") {
				typedScripts.push(call.script);
				const task = rootScript(call.script);
				if (task !== undefined) {
					typed.push({
						t: entry.t,
						task: task.name,
						flags: [],
					});
				}
				continue;
			}
			const resolved = resolveCall(project, call.argv);
			for (const task of resolved?.tasks ?? []) {
				typed.push({
					t: entry.t,
					task: task.name,
					flags: resolved?.tasks.length === 1 ? resolved.flags : [],
				});
			}
		}
	}
	return {
		typed,
		typedScripts,
	};
}

export async function buildUsageReport(
	project: Project,
	options: {
		since?: number;
		history: boolean;
		now?: number;
	},
): Promise<UsageReport> {
	markSeen(project);
	const log = readUsageLog(project.rootDir);
	const packages = gatherPackages(project);
	const history = options.history
		? gatherHistory(project)
		: {
				typed: [],
				typedScripts: [],
			};
	return analyzeUsage({
		project,
		starts: log.starts,
		ends: log.ends,
		seen: log.seen,
		typed: history.typed,
		typedScripts: history.typedScripts,
		mentions: gatherMentions(project, packages),
		packages,
		...(options.since !== undefined
			? {
					since: options.since,
				}
			: {}),
		now: options.now ?? Date.now(),
	});
}

export async function usageCommand(command: UsageCommand, flags: GlobalFlags): Promise<number> {
	const project = await loadProjectFromCwd(flags.filter);
	const since = command.since !== undefined ? parseSince(command.since) : undefined;
	let target: Task | undefined;
	if (command.task.length > 0) {
		const resolved = resolveWords(project, command.task, []);
		if ("namespace" in resolved) {
			throw new OutdoError("usage", `"${resolved.namespace}" is a namespace — name one of its tasks.`);
		}
		const tasks = resolveRequested(project, resolved.names);
		if (tasks.length !== 1) {
			throw new OutdoError(
				"usage",
				`"${command.task.join(" ")}" matches ${tasks.length} tasks (${tasks.map((t) => t.name).join(", ")}) — name one.`,
			);
		}
		target = tasks[0];
	}
	const report = await buildUsageReport(project, {
		...(since !== undefined
			? {
					since,
				}
			: {}),
		history: command.history,
	});
	const task = target === undefined ? undefined : report.tasks.find((t) => t.name === target.name);
	if (flags.json) {
		console.log(
			JSON.stringify(
				task === undefined
					? report
					: {
							...task,
							duplicates: report.duplicates.filter((d) => involves(d, task.name)),
						},
				null,
				2,
			),
		);
		return EXIT.ok;
	}
	console.log(task === undefined ? renderUsage(report, command.all) : renderTaskUsage(report, task));
	return EXIT.ok;
}
