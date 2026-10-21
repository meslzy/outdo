/**
 * `outdo explain <task>` — a read-only account of what a run would do: the
 * planned subgraph with per-task cache verdicts (and *why* a task would
 * re-run, by fingerprint component), input/output glob matches, env schema
 * state, resilience settings, and the backend that would execute the plan.
 * Never runs tasks and never writes to .outdo.
 */

import { loadProjectFromCwd } from "~/cli/load";
import type { GlobalFlags } from "~/cli/parse";
import { prepareEnv, resolveMode } from "~/cli/plan";
import { resolveSingleTask } from "~/cli/resolve-task";
import { usesSequentialBackend } from "~/cli/run";
import { applyDefaults } from "~/core/argspec";
import type { CacheDiagnosis, MissReason } from "~/core/cache";
import { cacheable, diagnoseCache } from "~/core/cache";
import { validateTaskEnv } from "~/core/envresolve";
import { EXIT } from "~/core/errors";
import { allPatternsMatchSomething, expand } from "~/core/globs";
import { applyConditions, applySteps, subgraphFor, topoOrder } from "~/core/graph";
import { bold, dim, green, red, yellow } from "~/core/logger";
import type { Project, Task } from "~/core/model";
import { describeProbe } from "~/core/ready";

type Verdict = "would-run" | "would-skip" | "not-cacheable" | "service";

interface ExplainedTask {
	task: Task;
	verdict: Verdict;
	diagnosis: CacheDiagnosis | undefined;
	envValid: boolean | undefined;
	inputMatches: {
		glob: string;
		matches: number;
	}[];
	outputsPresent: boolean | undefined;
}

export async function explainCommand(taskName: string, flags: GlobalFlags): Promise<number> {
	const loaded = await loadProjectFromCwd(flags.filter);
	const mode = resolveMode(loaded, flags.mode);
	const { envFor } = prepareEnv(loaded, mode);
	const conditioned: Project = {
		...loaded,
		tasks: applyConditions(loaded.tasks, process.env),
	};
	const target = resolveSingleTask(conditioned, taskName);

	const subset = subgraphFor(conditioned.tasks, [
		target.name,
	]);
	const project: Project = {
		...conditioned,
		tasks: applySteps(conditioned.tasks, subset),
	};
	const order = topoOrder(project.tasks, subset);
	const planned = order.map((name) => project.tasks.get(name) as Task);

	// Walk in topo order so dep fingerprints compose exactly like a real run.
	// Explain assumes default args and empty passthrough (documented).
	const fingerprints = new Map<string, string>();
	const outputs = new Map<string, unknown>();
	const explained: ExplainedTask[] = [];
	for (const task of planned) {
		const envCheck = task.env !== undefined ? await validateTaskEnv(task, envFor(task)) : undefined;
		const subsetDeps = task.deps.filter((dep) => subset.has(dep));
		const diagnosis = await diagnoseCache(
			project.rootDir,
			task,
			{
				envOutput: task.env !== undefined ? (envCheck?.value ?? null) : null,
				args: await applyDefaults(task),
				rest: [],
				depFingerprints: subsetDeps.map((dep) => fingerprints.get(dep) ?? ""),
				depOutputs: subsetDeps.map((dep) => JSON.stringify(outputs.get(dep) ?? null)),
			},
			flags.force,
		);
		fingerprints.set(task.name, diagnosis.fingerprint);
		if (diagnosis.hit) {
			outputs.set(task.name, diagnosis.previousOutput);
		}
		const verdict: Verdict = task.persistent
			? "service"
			: !cacheable(task)
				? "not-cacheable"
				: diagnosis.hit
					? "would-skip"
					: "would-run";
		const inputMatches: ExplainedTask["inputMatches"] = [];
		for (const glob of task.inputs) {
			if (glob.startsWith("!")) {
				inputMatches.push({
					glob,
					matches: -1,
				});
				continue;
			}
			inputMatches.push({
				glob,
				matches: (
					await expand(
						[
							glob,
						],
						task.cwd,
					)
				).length,
			});
		}
		explained.push({
			task,
			verdict,
			diagnosis: cacheable(task) ? diagnosis : undefined,
			envValid: envCheck === undefined ? undefined : envCheck.issues.length === 0,
			inputMatches,
			outputsPresent: task.outputs.length > 0 ? await allPatternsMatchSomething(task.outputs, task.cwd) : undefined,
		});
	}

	const sequential = usesSequentialBackend(project.tasks, order, planned, flags);
	const concurrency = flags.concurrency ?? Math.max(1, navigator.hardwareConcurrency ?? 4);

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					task: target.name,
					backend: {
						kind: sequential ? "sequential" : "parallel",
						concurrency: sequential ? 1 : concurrency,
					},
					plan: order,
					tasks: explained.map((e) => ({
						name: e.task.name,
						deps: e.task.deps.filter((dep) => subset.has(dep)),
						...(inactiveDeps(e.task).length > 0
							? {
									inactiveDeps: inactiveDeps(e.task),
								}
							: {}),
						persistent: e.task.persistent,
						cacheable: cacheable(e.task),
						verdict: e.verdict,
						...(e.diagnosis !== undefined
							? {
									reasons: e.diagnosis.hit ? [] : e.diagnosis.reasons,
									fingerprint: e.diagnosis.fingerprint,
								}
							: {}),
						inputs: e.inputMatches.map((m) =>
							m.matches === -1
								? {
										glob: m.glob,
									}
								: m,
						),
						...(e.outputsPresent !== undefined
							? {
									outputs: {
										patterns: e.task.outputs,
										present: e.outputsPresent,
									},
								}
							: {}),
						envSchema: e.task.env !== undefined,
						...(e.envValid !== undefined
							? {
									envValid: e.envValid,
								}
							: {}),
						...(e.task.ready !== undefined
							? {
									ready: e.task.ready,
								}
							: {}),
						...(e.task.retry !== undefined
							? {
									retry: e.task.retry,
								}
							: {}),
						...(e.task.timeoutMs !== undefined
							? {
									timeoutMs: e.task.timeoutMs,
								}
							: {}),
					})),
				},
				null,
				2,
			),
		);
		return EXIT.ok;
	}

	// Human rendering.
	const lines: string[] = [];
	lines.push(`${bold(target.name)}${target.desc !== undefined ? ` ${dim(`— ${target.desc}`)}` : ""}`);
	lines.push(
		dim(
			`backend: ${sequential ? "sequential (in-process)" : `parallel (child processes) · concurrency ${concurrency}`}`,
		),
	);
	lines.push("");
	lines.push(dim("plan (dependencies first):"));
	for (const e of explained) {
		lines.push(
			`  ${verdictSymbol(e.verdict)} ${e.task.name.padEnd(Math.max(...order.map((n) => n.length)))}  ${verdictText(e)}`,
		);
	}
	const targetExplained = explained.find((e) => e.task.name === target.name) as ExplainedTask;
	lines.push("");
	lines.push(dim(`details for ${target.name}:`));
	const detail = renderDetails(targetExplained, subset);
	lines.push(...detail.map((line) => `  ${line}`));
	lines.push("");
	lines.push(dim("explain assumes default args and no passthrough (--) — nothing was run"));
	console.log(lines.join("\n"));
	return EXIT.ok;
}

function inactiveDeps(task: Task): string[] {
	return task.depEdges.map((edge) => edge.task).filter((dep) => !task.deps.includes(dep));
}

function verdictSymbol(verdict: Verdict): string {
	switch (verdict) {
		case "would-skip":
			return green("✓");
		case "would-run":
			return yellow("↻");
		case "service":
			return dim("▸");
		case "not-cacheable":
			return dim("•");
	}
}

function verdictText(e: ExplainedTask): string {
	switch (e.verdict) {
		case "would-skip":
			return dim("would skip (cached)");
		case "service":
			return dim("service (never cached)");
		case "not-cacheable":
			return dim(
				e.task.run === undefined && e.task.command === undefined && e.task.script === undefined
					? "aggregation only (no run)"
					: "not cacheable (no inputs declared)",
			);
		case "would-run": {
			const reasons = e.diagnosis?.reasons ?? [];
			return `would run${reasons.length > 0 ? ` — ${reasons.map(reasonText).join(", ")}` : ""}`;
		}
	}
}

function truncatedList(items: string[]): string {
	const shown = items.slice(0, 3).join(", ");
	return items.length > 3 ? `${shown}, +${items.length - 3} more` : shown;
}

function reasonText(reason: MissReason): string {
	switch (reason.kind) {
		case "no-manifest":
			return "no previous run";
		case "forced":
			return "--force";
		case "def-changed":
			return "task definition changed";
		case "env-changed":
			return "env changed";
		case "args-changed":
			return "args changed";
		case "rest-changed":
			return "passthrough args changed";
		case "deps-changed":
			return "dependency fingerprints changed";
		case "dep-outputs-changed":
			return "dependency outputs changed";
		case "outputs-missing":
			return "declared outputs missing";
		case "inputs-changed": {
			const parts: string[] = [];
			if (reason.modified.length > 0) {
				parts.push(`modified: ${truncatedList(reason.modified)}`);
			}
			if (reason.added.length > 0) {
				parts.push(`added: ${truncatedList(reason.added)}`);
			}
			if (reason.removed.length > 0) {
				parts.push(`removed: ${truncatedList(reason.removed)}`);
			}
			return `inputs changed (${parts.join("; ")})`;
		}
	}
}

function renderDetails(e: ExplainedTask, subset: ReadonlySet<string>): string[] {
	const task = e.task;
	const lines: string[] = [];
	const steps = new Set(task.steps);
	const deps = task.deps.filter((dep) => subset.has(dep) && !steps.has(dep));
	if (deps.length > 0) {
		lines.push(`deps:     ${deps.join(", ")}`);
	}
	if (task.steps.length > 0) {
		lines.push(`steps:    ${task.steps.join(" → ")}`);
	}
	if (task.after.length > 0) {
		lines.push(`after:    ${task.after.join(", ")} ${dim("(step order)")}`);
	}
	if (task.finally.length > 0) {
		lines.push(`finally:  ${task.finally.join(", ")}`);
	}
	if (task.command !== undefined) {
		lines.push(`runs:     ${task.command.join(" && ")}`);
	} else if (task.script !== undefined) {
		lines.push(`runs:     bun run ${task.script} ${dim("(package.json)")}`);
	}
	const inactive = inactiveDeps(task);
	if (inactive.length > 0) {
		lines.push(`inactive: ${inactive.join(", ")} ${dim("(condition not met)")}`);
	}
	if (e.inputMatches.length > 0) {
		lines.push(
			`inputs:   ${e.inputMatches
				.map((m) => (m.matches === -1 ? m.glob : `${m.glob} (${m.matches} file${m.matches === 1 ? "" : "s"})`))
				.join(", ")}`,
		);
	}
	if (task.outputs.length > 0) {
		lines.push(
			`outputs:  ${task.outputs.join(", ")} ${e.outputsPresent === true ? green("(present)") : red("(missing)")}`,
		);
	}
	lines.push(
		`env:      ${task.env === undefined ? dim("no schema") : e.envValid === true ? green("schema valid") : red("schema invalid")}`,
	);
	const argNames = Object.keys(task.args);
	if (argNames.length > 0) {
		lines.push(`args:     ${argNames.map((a) => `--${a}`).join(", ")} ${dim("(defaults assumed)")}`);
	}
	if (task.ready !== undefined) {
		lines.push(`ready:    ${describeProbe(task.ready)}`);
	}
	if (task.retry !== undefined) {
		lines.push(`retry:    up to ${task.retry.attempts} attempts (${task.retry.backoff}, ${task.retry.delayMs}ms)`);
	}
	if (task.timeoutMs !== undefined) {
		lines.push(`timeout:  ${task.timeoutMs}ms per attempt`);
	}
	if (cacheable(task)) {
		const d = e.diagnosis as CacheDiagnosis;
		lines.push(
			`cache:    ${d.hit ? green("hit — would skip") : `miss — ${d.reasons.map(reasonText).join(", ") || "unknown"}`}`,
		);
		lines.push(`          ${dim(`fingerprint ${d.fingerprint}`)}`);
	}
	return lines;
}
