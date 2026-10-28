/**
 * Background runs: `outdo bg start <task>` runs the task as a detached
 * `outdo <task>` whose output goes to `.outdo/bg/<name>.log`, and returns as
 * soon as its services are ready (the run marks its state file) — or right
 * away for plain tasks. `bg ps` / `bg logs` / `bg stop` work from the state
 * files; stop is SIGTERM to the run's process group (it shuts its children
 * down gracefully), escalating to a tree kill. Questions (protect/confirm)
 * are asked here, in the foreground, before anything is spawned.
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadProjectFromCwd } from "~/cli/load";
import type { Command, GlobalFlags } from "~/cli/parse";
import { preparePlan } from "~/cli/plan";
import { EXIT, OutdoError } from "~/core/errors";
import { GRACE_MS } from "~/core/lifecycle";
import { bold, cyan, dim, green, red, yellow } from "~/core/logger";
import { formatMs } from "~/core/report";

type BgStart = Extract<
	Command,
	{
		kind: "bg-start";
	}
>;

interface BgState {
	name: string;
	pid: number;
	startedAt: number;
	cwd: string;
	argv: string[];
	log: string;
	/** Ports the run's services listen on (from ready probes), for `bg ps`. */
	ports: number[];
	ready?: boolean;
}

const SELF = resolve(process.argv[1] as string);

function bgDir(rootDir: string): string {
	return join(rootDir, ".outdo", "bg");
}

function keyFor(names: readonly string[]): string {
	return names.join("+").replaceAll(/[^A-Za-z0-9_.+-]/g, "_");
}

function readState(path: string): BgState | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as BgState;
	} catch {
		return undefined;
	}
}

/** The ready marker the run writes (separate file, so the starter's record stays intact). */
function readyFile(statePath: string): string {
	return statePath.replace(/\.json$/, ".ready");
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: exists but not ours to signal — still alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function rootDir(): Promise<string> {
	return (await loadProjectFromCwd()).rootDir;
}

function tail(path: string, lines = 20): string {
	try {
		return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n").trimEnd();
	} catch {
		return "";
	}
}

/** Global flags to forward to the background run. */
function forwardedFlags(flags: GlobalFlags): string[] {
	const out: string[] = [];
	if (flags.mode !== undefined) {
		out.push(`--mode=${flags.mode}`);
	}
	if (flags.force) {
		out.push("--force");
	}
	if (flags.concurrency !== undefined) {
		out.push(`--concurrency=${flags.concurrency}`);
	}
	for (const filter of flags.filter) {
		out.push(`--filter=${filter}`);
	}
	return out;
}

export async function bgStart(command: BgStart, flags: GlobalFlags): Promise<number> {
	if (flags.watch || flags.dry !== false || flags.json) {
		throw new OutdoError("usage", "bg start cannot be combined with --watch, --dry or --json.");
	}
	// Plan in the foreground: unknown tasks, bad flags, env schemas and
	// confirmation questions all surface here, not in a log file.
	const plan = await preparePlan(
		{
			words: command.tasks,
			taskArgv: command.taskArgv,
			rest: command.rest,
		},
		flags,
	);
	if (plan.kind !== "plan") {
		throw new OutdoError("usage", "bg start needs a task to run.");
	}
	const { state } = plan;
	const dir = bgDir(state.project.rootDir);
	mkdirSync(dir, {
		recursive: true,
	});
	const name = keyFor([
		...state.requestedNames,
	]);
	const statePath = join(dir, `${name}.json`);
	const existing = readState(statePath);
	if (existing !== undefined && alive(existing.pid)) {
		throw new OutdoError(
			"usage",
			`"${name}" is already running (pid ${existing.pid}). Stop it with "outdo bg stop ${name}".`,
		);
	}
	rmSync(readyFile(statePath), {
		force: true,
	});

	const logPath = join(dir, `${name}.log`);
	const argv = [
		process.execPath,
		SELF,
		"--color=never",
		"--log-order=stream",
		"--yes", // already confirmed above
		...forwardedFlags(flags),
		...command.tasks,
		...command.taskArgv,
		...(command.rest.length > 0
			? [
					"--",
					...command.rest,
				]
			: []),
	];
	const fd = openSync(logPath, "w");
	const proc = Bun.spawn(argv, {
		cwd: process.cwd(),
		stdin: "ignore",
		stdout: fd,
		stderr: fd,
		detached: true,
		env: {
			...process.env,
			OUTDO_BG_STATE: readyFile(statePath),
			OUTDO_VIA: "bg",
			NO_COLOR: "1",
		},
	});
	closeSync(fd);
	const services = state.planned.filter((t) => t.persistent);
	const record: BgState = {
		name,
		pid: proc.pid,
		startedAt: Date.now(),
		cwd: process.cwd(),
		argv: argv.slice(2),
		log: logPath,
		ports: services.flatMap((t) =>
			t.ready?.port !== undefined
				? [
						t.ready.port,
					]
				: [],
		),
	};
	await Bun.write(statePath, JSON.stringify(record, null, 2));
	const shownLog = relative(process.cwd(), logPath).replaceAll("\\", "/");

	// Only a requested service keeps the run alive; anything else just runs to completion.
	const waitsForReady = [
		...state.requestedNames,
	].some((n) => state.project.tasks.get(n)?.persistent === true);
	if (!waitsForReady) {
		proc.unref();
		console.log(`${green("▸")} ${bold(name)} running in the background ${dim(`(pid ${proc.pid}, log ${shownLog})`)}`);
		return EXIT.ok;
	}

	// Wait for readiness: the run writes the ready file once its services are up.
	const budget = Math.max(...services.map((t) => t.ready?.timeoutMs ?? 30_000)) + 10_000;
	const startedAt = Date.now();
	for (;;) {
		if (existsSync(readyFile(statePath))) {
			proc.unref();
			const ports = record.ports.length > 0 ? ` · port ${record.ports.join(", ")}` : "";
			console.log(
				`${green("✓")} ${bold(name)} ready in ${formatMs(Date.now() - startedAt)} ${dim(`(pid ${proc.pid}${ports}, log ${shownLog})`)}`,
			);
			return EXIT.ok;
		}
		if (proc.exitCode !== null || proc.signalCode !== null) {
			rmSync(statePath, {
				force: true,
			});
			const out = tail(logPath);
			throw new OutdoError(
				"task-failed",
				`"${name}" exited before it was ready (code ${proc.exitCode ?? proc.signalCode}).${out !== "" ? `\n${out}` : ""}`,
			);
		}
		if (Date.now() - startedAt > budget) {
			await stopPid(proc.pid);
			rmSync(statePath, {
				force: true,
			});
			throw new OutdoError(
				"task-failed",
				`"${name}" was not ready after ${formatMs(budget)} — stopped. Log: ${shownLog}`,
			);
		}
		await new Promise<void>((done) => setTimeout(done, 100));
	}
}

function listStates(dir: string): {
	path: string;
	state: BgState;
}[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.flatMap((file) => {
			const path = join(dir, file);
			const state = readState(path);
			return state === undefined
				? []
				: [
						{
							path,
							state,
						},
					];
		});
}

export async function bgPs(flags: GlobalFlags): Promise<number> {
	const dir = bgDir(await rootDir());
	const entries = listStates(dir).map(({ path, state }) => ({
		path,
		state,
		running: alive(state.pid),
		ready: existsSync(readyFile(path)),
	}));
	if (flags.json) {
		console.log(
			JSON.stringify(
				entries.map((e) => ({
					...e.state,
					running: e.running,
					ready: e.ready,
				})),
				null,
				2,
			),
		);
	} else if (entries.length === 0) {
		console.log(dim('nothing running in the background — start something with "outdo bg start <task>"'));
	} else {
		const width = Math.max(...entries.map((e) => e.state.name.length));
		for (const e of entries) {
			const status = e.running
				? e.ready || e.state.ports.length === 0
					? green("running")
					: yellow("starting")
				: red("exited");
			const ports = e.state.ports.length > 0 ? `  port ${e.state.ports.join(", ")}` : "";
			console.log(
				`  ${cyan(e.state.name.padEnd(width))}  ${status}  ${dim(`pid ${e.state.pid} · up ${formatMs(Date.now() - e.state.startedAt)}${ports}`)}`,
			);
		}
	}
	// Forget runs that are gone (after showing them once).
	for (const e of entries) {
		if (!e.running) {
			rmSync(e.path, {
				force: true,
			});
			rmSync(readyFile(e.path), {
				force: true,
			});
		}
	}
	return EXIT.ok;
}

export async function bgLogs(name: string, follow: boolean): Promise<number> {
	const dir = bgDir(await rootDir());
	const logPath = join(
		dir,
		`${keyFor([
			name,
		])}.log`,
	);
	if (!existsSync(logPath)) {
		throw new OutdoError("usage", `No background log for "${name}". See "outdo bg ps".`);
	}
	const file = Bun.file(logPath);
	let offset = 0;
	const print = async (): Promise<void> => {
		const size = statSync(logPath).size;
		if (size > offset) {
			process.stdout.write(await file.slice(offset, size).text());
			offset = size;
		}
	};
	await print();
	if (!follow) {
		return EXIT.ok;
	}
	let stop = false;
	process.on("SIGINT", () => {
		stop = true;
	});
	while (!stop) {
		await new Promise<void>((done) => setTimeout(done, 250));
		if (existsSync(logPath)) {
			await print();
		}
	}
	return EXIT.ok;
}

/** SIGTERM the run's process group, then tree-kill whatever is left after the grace period. */
async function stopPid(pid: number): Promise<void> {
	if (process.platform === "win32") {
		const killer = Bun.spawn(
			[
				"taskkill",
				"/T",
				"/F",
				"/PID",
				String(pid),
			],
			{
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		await killer.exited;
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			return;
		}
	}
	const deadline = Date.now() + GRACE_MS + 2000;
	while (alive(pid) && Date.now() < deadline) {
		await new Promise<void>((done) => setTimeout(done, 100));
	}
	if (alive(pid)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			process.kill(pid, "SIGKILL");
		}
	}
}

export async function bgStop(names: readonly string[]): Promise<number> {
	const dir = bgDir(await rootDir());
	const entries = listStates(dir);
	const wanted =
		names.length === 0
			? entries
			: entries.filter((e) =>
					names
						.map((n) =>
							keyFor([
								n,
							]),
						)
						.includes(e.state.name),
				);
	if (names.length > 0 && wanted.length === 0) {
		throw new OutdoError(
			"usage",
			`Nothing called ${names.map((n) => `"${n}"`).join(", ")} is running. See "outdo bg ps".`,
		);
	}
	if (wanted.length === 0) {
		console.log(dim("nothing running in the background"));
		return EXIT.ok;
	}
	for (const { path, state } of wanted) {
		if (alive(state.pid)) {
			await stopPid(state.pid);
			console.log(`${green("✓")} stopped ${state.name}`);
		} else {
			console.log(dim(`${state.name} had already exited`));
		}
		rmSync(path, {
			force: true,
		});
		rmSync(readyFile(path), {
			force: true,
		});
	}
	return EXIT.ok;
}
