/**
 * Watch mode: run the plan, then re-run the affected subgraph (plus its
 * dependents) whenever watched files change. Services are restarted when
 * their own globs match. New changes supersede an in-flight re-run.
 */

import { relative } from "node:path";
import type { GlobalFlags } from "~/cli/parse";
import { makeStart, type SharedRunState } from "~/cli/run";
import { EXIT } from "~/core/errors";
import { compile, type GlobSet, matches, staticRoots } from "~/core/globs";
import { topoOrder } from "~/core/graph";
import { Lifecycle } from "~/core/lifecycle";
import { dim, yellow } from "~/core/logger";
import type { Task } from "~/core/model";
import { OutputMultiplexer } from "~/core/output";
import { buildReport, formatSummary } from "~/core/report";
import { type ServiceHandle, schedule } from "~/core/scheduler";
import { startWatcher, type WatchTarget } from "~/core/watch";

interface WatchedTask {
	task: Task;
	set: GlobSet;
}

export async function runWatch(state: SharedRunState, flags: GlobalFlags): Promise<number> {
	const concurrency = flags.concurrency ?? Math.max(1, navigator.hardwareConcurrency ?? 4);
	// Watch mode always multiplexes (child backend), streaming by default.
	const logOrder = flags.logOrder === "grouped" ? "grouped" : "stream";
	const mux = new OutputMultiplexer(
		logOrder,
		flags.outputLogs,
		state.planned.map((t) => t.name),
	);

	const servicesLifecycle = new Lifecycle();
	const serviceHandles = new Map<string, ServiceHandle>();
	let currentLifecycle: Lifecycle | undefined;

	const watched: WatchedTask[] = [];
	const targets: WatchTarget[] = [];
	for (const task of state.planned) {
		const globs = task.watch.length > 0 ? task.watch : task.inputs;
		if (globs.length === 0) {
			continue;
		}
		watched.push({
			task,
			set: compile(globs),
		});
		for (const root of staticRoots(globs)) {
			const absRoot = root === "." ? task.cwd : `${task.cwd}/${root}`;
			const existing = targets.find((t) => t.root === absRoot);
			if (existing) {
				existing.patterns = [
					...new Set([
						...existing.patterns,
						...globs,
					]),
				];
			} else {
				targets.push({
					root: absRoot,
					base: task.cwd,
					patterns: globs,
				});
			}
		}
	}

	// Reverse edges within the plan, for the dependents closure.
	const dependentsOf = new Map<string, Set<string>>();
	for (const task of state.planned) {
		for (const dep of task.deps) {
			if (state.subset.has(dep)) {
				let set = dependentsOf.get(dep);
				if (!set) {
					set = new Set();
					dependentsOf.set(dep, set);
				}
				set.add(task.name);
			}
		}
	}
	const withDependents = (names: Set<string>): Set<string> => {
		const out = new Set<string>();
		const visit = (name: string): void => {
			if (out.has(name)) {
				return;
			}
			out.add(name);
			for (const dependent of dependentsOf.get(name) ?? []) {
				visit(dependent);
			}
		};
		for (const name of names) {
			visit(name);
		}
		return out;
	};

	const affectedBy = (paths: Set<string>): Set<string> => {
		const hit = new Set<string>();
		for (const { task, set } of watched) {
			for (const path of paths) {
				const rel = relative(task.cwd, path).replaceAll("\\", "/");
				if (rel.startsWith("..")) {
					continue;
				}
				if (matches(set, rel) || path === task.cwd) {
					hit.add(task.name);
					break;
				}
			}
		}
		return hit;
	};

	let running = false;
	let pendingPaths = new Set<string>();
	let interrupted = false;
	let wake: (() => void) | undefined;

	const byName = new Map(
		state.planned.map((t) => [
			t.name,
			t,
		]),
	);
	const runNames = async (names: readonly string[]): Promise<void> => {
		running = true;
		currentLifecycle = new Lifecycle();
		const lifecycle = currentLifecycle;
		const runStart = performance.now();
		const wallStart = Date.now();
		const outcome = await schedule({
			tasks: state.project.tasks,
			planned: names,
			concurrency,
			continueOnError: flags.continueOnError,
			start: makeStart(state, mux, (task) => (task.persistent ? servicesLifecycle : lifecycle)),
			onAbort: () => lifecycle.shutdown(),
		});
		for (const [name, handle] of outcome.services) {
			serviceHandles.set(name, handle);
			void handle.result.then((result) => {
				if (serviceHandles.get(name) === handle && !interrupted) {
					serviceHandles.delete(name);
					console.error(
						`${yellow("!")} service ${name} exited (${result.error ?? "no error"}) — will restart on the next change`,
					);
				}
			});
		}
		const report = buildReport({
			planned: names.map((name) => byName.get(name) as Task),
			results: outcome.results,
			services: new Set(outcome.services.keys()),
			runStart,
			runEnd: performance.now(),
			wallStart,
		});
		console.error(formatSummary(report));
		running = false;
	};

	const onSigint = (): void => {
		if (interrupted) {
			currentLifecycle?.killAll();
			servicesLifecycle.killAll();
			process.exit(EXIT.interrupted);
		}
		interrupted = true;
		console.error(dim("stopping watch..."));
		wake?.();
	};
	process.on("SIGINT", onSigint);

	const watcher = startWatcher(targets, (paths) => {
		for (const path of paths) {
			pendingPaths.add(path);
		}
		if (running) {
			// Supersede: abort the in-flight re-run; the loop picks up the batch.
			void currentLifecycle?.shutdown();
		}
		wake?.();
	});

	try {
		await runNames(state.planned.map((t) => t.name));
		console.error(dim(`watching ${targets.length} path(s) — Ctrl-C to stop`));

		while (!interrupted) {
			if (pendingPaths.size === 0) {
				await new Promise<void>((resolve) => {
					wake = resolve;
					if (pendingPaths.size > 0 || interrupted) {
						resolve();
					}
				});
				wake = undefined;
				continue;
			}
			const batch = pendingPaths;
			pendingPaths = new Set();
			const affected = withDependents(affectedBy(batch));
			if (affected.size === 0) {
				continue;
			}
			// Restart affected services: stop the old instance first.
			for (const name of affected) {
				const handle = serviceHandles.get(name);
				if (handle !== undefined) {
					serviceHandles.delete(name);
					await handle.stop();
				}
			}
			// Only the affected tasks re-run; their unaffected deps already ran
			// (and would be cache hits anyway).
			const names = topoOrder(state.project.tasks, affected);
			console.error(dim(`\nchanged -> re-running: ${names.join(", ")}`));
			await runNames(names);
		}
	} finally {
		watcher.close();
		process.off("SIGINT", onSigint);
		await Promise.all([
			currentLifecycle?.shutdown(),
			servicesLifecycle.shutdown(),
		]);
	}
	return EXIT.ok;
}
