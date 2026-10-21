#!/usr/bin/env bun
/**
 * outdo CLI entry. Keep this module's static imports minimal — everything
 * beyond parsing and error handling is loaded lazily per command.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCli, wantsJsonErrors } from "~/cli/parse";
import { EXIT, OutdoError } from "~/core/errors";
import { red, setColorMode } from "~/core/logger";

const HELP = `outdo — TypeScript-native task runner for Bun

Usage
  outdo                          List tasks (do.ts tasks + package.json scripts)
  outdo <task> [flags] [-- args] Run a task (and its dependencies)
  outdo <task1> <task2>          Run several tasks
  outdo <ns> <task>              Run a namespaced task (same as <ns>:<task>)
  outdo run <task>               Run a task whose name is also a command
  outdo -i                       Pick a task interactively
  outdo ls [--json]              List tasks (machine-readable with --json)
  outdo explain <task>           Explain the plan: cache verdicts, inputs, backend
  outdo graph [--dot]            Print the dependency graph (mermaid or dot)
  outdo doctor                   Check every task's "requires"
  outdo --print-env <task>       Explain resolved env + validate the task's schema

Background services
  outdo bg start <task>          Start in the background; returns once ready
  outdo bg ps                    What is running
  outdo bg logs <task> [--follow]
  outdo bg stop [task...]        Stop one, or everything

CI / CD
  outdo ci <task>                CI run: only what changed, folded logs, annotations
  outdo ci init                  Write .github/workflows/ci.yml
  outdo affected <task> [--github-output]   Did this task's inputs change?
  outdo hooks install|uninstall|list        Git hooks declared in do.ts
  outdo prune --docker [--out dir]          package.jsons + lockfile for a Docker layer

More
  outdo init                     Scaffold a starter do.ts
  outdo mcp                      Serve tasks as MCP tools (for Claude)
  outdo completion <shell>       Print shell completions (bash|zsh|fish|powershell)

Flags
  -m, --mode <name>              Mode declared in do.ts (picks .env.<mode> files)
  -y, --yes                      Answer yes to protect/confirm questions
      --from / --until <step>    Run only part of a task's steps
  -w, --watch                    Re-run tasks when watched files change
  -j, --concurrency <n>          Max parallel tasks (default: CPU count)
      --continue                 Keep running independent tasks after a failure
      --log-order <mode>         stream | grouped | auto (default: auto)
      --output-logs <mode>       full | errors-only | none (default: full)
      --dry[=json]               Show the plan without running anything
      --affected[=<rev>]         Only run tasks affected by git changes vs <rev>
                                 (default: PR base / previous push in CI, else
                                 merge-base with origin's default branch)
      --profile[=<file>]         Write a Chrome trace of the run (.outdo/trace.json)
  -f, --force                    Ignore the fingerprint cache
  -F, --filter <pattern>         Filter workspace packages
      --isolate                  Force the child-process backend (no in-process chains)
      --json                     Machine-readable output (runs emit a JSON report)
      --color <mode>             auto | always | never (also --no-color)
  -h, --help                     Show this help
  -V, --version                  Show version

--mode, --yes, --from and --until may also follow the task name.
`;

async function main(): Promise<number> {
	const { command, flags } = parseCli(process.argv.slice(2));
	setColorMode(flags.color);

	switch (command.kind) {
		case "help": {
			process.stdout.write(HELP);
			return EXIT.ok;
		}
		case "version": {
			const { default: pkg } = await import("../package.json");
			console.log(pkg.version);
			return EXIT.ok;
		}
		case "list": {
			const { loadProjectFromCwd } = await import("~/cli/load");
			const { listJson, renderList } = await import("~/cli/list");
			const project = await loadProjectFromCwd(flags.filter);
			if (flags.json) {
				console.log(JSON.stringify(listJson(project), null, 2));
			} else {
				console.log(renderList(project));
			}
			const { refreshCompletionCache } = await import("~/cli/complete");
			refreshCompletionCache(project);
			return EXIT.ok;
		}
		case "run":
		case "ci":
		case "bg-start": {
			if (command.kind === "bg-start") {
				const { bgStart } = await import("~/cli/bg");
				return await bgStart(command, flags);
			}
			const { runCommand } = await import("~/cli/run");
			return await runCommand(command, flags);
		}
		case "bg-stop":
		case "bg-ps":
		case "bg-logs": {
			const bg = await import("~/cli/bg");
			if (command.kind === "bg-stop") {
				return await bg.bgStop(command.tasks);
			}
			if (command.kind === "bg-logs") {
				return await bg.bgLogs(command.task, command.follow);
			}
			return await bg.bgPs(flags);
		}
		case "ci-init": {
			const { ciInitCommand } = await import("~/cli/ci-init");
			return await ciInitCommand(flags);
		}
		case "affected": {
			const { affectedCommand } = await import("~/cli/affected");
			return await affectedCommand(command, flags);
		}
		case "hooks": {
			const { hooksCommand } = await import("~/cli/hooks");
			return await hooksCommand(command, flags);
		}
		case "prune": {
			const { pruneCommand } = await import("~/cli/prune");
			return await pruneCommand(command.out);
		}
		case "mcp": {
			const { mcpCommand } = await import("~/cli/mcp");
			return await mcpCommand();
		}
		case "doctor": {
			const { doctorCommand } = await import("~/cli/doctor");
			return await doctorCommand(flags);
		}
		case "pick": {
			const { pickCommand } = await import("~/cli/pick");
			return await pickCommand(flags);
		}
		case "print-env": {
			const { printEnvCommand } = await import("~/cli/print-env");
			return await printEnvCommand(command.task, flags);
		}
		case "explain": {
			const { explainCommand } = await import("~/cli/explain");
			return await explainCommand(command.task, flags);
		}
		case "graph": {
			const { graphCommand } = await import("~/cli/graph");
			return await graphCommand(command.dot, flags);
		}
		case "init": {
			const { initCommand } = await import("~/cli/init");
			return await initCommand();
		}
		case "completion": {
			const { completionCommand } = await import("~/cli/completion");
			return await completionCommand(command.shell);
		}
		case "complete": {
			const { completeCommand } = await import("~/cli/complete");
			return await completeCommand(command.words);
		}
		case "worker": {
			const { workerCommand } = await import("~/cli/worker");
			return await workerCommand();
		}
	}
}

/**
 * A global `outdo` hands over to the project's own installed copy, so the
 * repo always runs the version in its lockfile (turbo does the same). Source
 * runs (`bun src/cli.ts`) never hand over; OUTDO_NO_LOCAL=1 disables it.
 */
function localInstall(): string | undefined {
	if (process.env.OUTDO_NO_LOCAL === "1" || process.argv[1] === undefined) {
		return undefined;
	}
	let self: string;
	try {
		self = realpathSync(process.argv[1]);
	} catch {
		return undefined;
	}
	if (self.endsWith(".ts")) {
		return undefined;
	}
	let dir = resolve(process.cwd());
	for (;;) {
		const candidate = join(dir, "node_modules", "@meslzy", "outdo", "dist", "cli.js");
		if (existsSync(candidate)) {
			try {
				const real = realpathSync(candidate);
				return real === self ? undefined : real;
			} catch {
				return undefined;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

const local = localInstall();
if (local !== undefined) {
	// Workers re-spawn `process.argv[1]`; point it at the local copy too.
	process.argv[1] = local;
	await import(pathToFileURL(local).href);
} else {
	try {
		process.exitCode = await main();
	} catch (error) {
		if (error instanceof OutdoError) {
			const wantJson = wantsJsonErrors(process.argv.slice(2));
			if (wantJson) {
				console.error(
					JSON.stringify({
						error: {
							code: error.code,
							message: error.message,
							detail: error.detail ?? null,
						},
					}),
				);
			} else {
				console.error(`${red("error")} ${error.message}`);
			}
			process.exitCode = error.exitCode;
		} else {
			console.error(error);
			process.exitCode = EXIT.taskFailure;
		}
	}
}
