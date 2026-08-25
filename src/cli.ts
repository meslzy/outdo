#!/usr/bin/env bun
/**
 * bundo CLI entry. Keep this module's static imports minimal — everything
 * beyond parsing and error handling is loaded lazily per command.
 */

import { parseCli, wantsJsonErrors } from "~/cli/parse";
import { BundoError, EXIT } from "~/core/errors";
import { red, setColorMode } from "~/core/logger";

const HELP = `bundo — TypeScript-native task runner for Bun

Usage
  bundo                        List available tasks
  bundo <task> [flags] [-- args]   Run a task (and its dependencies)
  bundo <task1> <task2>        Run multiple tasks
  bundo ls [--json]            List tasks (machine-readable with --json)
  bundo graph [--dot]          Print the dependency graph (mermaid or dot)
  bundo explain <task>         Explain the plan: cache verdicts, inputs, backend
  bundo init                   Scaffold a starter do.ts
  bundo completion <shell>     Print shell completions (bash|zsh|fish|powershell)
  bundo --print-env <task>     Explain resolved env + validate the task's schema

Flags
  -w, --watch                  Re-run tasks when watched files change
  -j, --concurrency <n>        Max parallel tasks (default: CPU count)
      --continue               Keep running independent tasks after a failure
      --log-order <mode>       stream | grouped | auto (default: auto)
      --output-logs <mode>     full | errors-only | none (default: full)
      --dry[=json]             Show the plan without running anything
      --affected[=<rev>]       Only run tasks affected by git changes vs <rev>
                               (default: merge-base with origin's default branch)
      --profile[=<file>]       Write a Chrome trace of the run (.bundo/trace.json)
  -f, --force                  Ignore the fingerprint cache
  -F, --filter <pattern>       Filter workspace packages
      --isolate                Force the child-process backend (no in-process chains)
      --json                   Machine-readable output (runs emit a JSON report)
      --color <mode>           auto | always | never (also --no-color)
  -h, --help                   Show this help
  -V, --version                Show version
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
			return EXIT.ok;
		}
		case "run": {
			const { runCommand } = await import("~/cli/run");
			return await runCommand(command, flags);
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

try {
	process.exitCode = await main();
} catch (error) {
	if (error instanceof BundoError) {
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
