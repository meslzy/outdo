/**
 * `@meslzy/outdo/compose` — the Docker Compose tasks every stack repo
 * rewrites, as one spread:
 *
 * ```ts
 * import { compose } from "@meslzy/outdo/compose";
 *
 * export default defineTasks({
 *   ...compose({ files: (mode) => ["docker-compose.base.yml", `docker-compose.${mode}.yml`], wait: true }),
 * }, { modes: ["dev", "prod"] });
 * ```
 *
 * Adds: up, down, restart, rebuild, fresh, logs, ps, shell, exec. Commands
 * run with inherited stdio, so `shell`/`exec` are interactive. Service names
 * complete with Tab (from `services`, or read from the compose files).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { task } from "./index";
import type { BuiltEntry, TaskCtx } from "./types";

export interface ComposeOptions {
	/** Compose files, or a function of the active --mode. Default: compose's own lookup. */
	files?: readonly string[] | ((mode: string) => readonly string[]);
	/** Compose project name (`-p`). */
	project?: string;
	/** Extra environment for every compose command (e.g. `{ COMPOSE_BAKE: "true" }`). */
	env?: Readonly<Record<string, string>>;
	/** `--env-file` for compose variable substitution, or a function of the mode. */
	envFile?: string | ((mode: string) => string | undefined);
	/** Service names. Given: flags only accept these. Otherwise read from the files (Tab only). */
	services?: readonly string[];
	/** `up` waits until every service is running/healthy (`docker compose up --wait`). */
	wait?: boolean;
	/** Modes in which `fresh` (wipes volumes) asks first. Default "prod". */
	protect?: string | readonly string[];
	/** Group heading in the task list. Default "Docker". */
	group?: string;
	/** Directory compose runs in, relative to the do.ts. Default: the do.ts directory. */
	cwd?: string;
	/** Shell for `shell <svc>`. Default "sh". */
	shell?: string;
}

/** Top-level service names in a compose file (a tiny scan — no YAML parser). */
export function servicesInFile(text: string): string[] {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => /^services:\s*(#.*)?$/.test(line));
	if (start === -1) {
		return [];
	}
	const out: string[] = [];
	let indent: number | undefined;
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === "" || line.trimStart().startsWith("#")) {
			continue;
		}
		const width = line.length - line.trimStart().length;
		if (width === 0) {
			break; // next top-level key
		}
		indent ??= width;
		const match = /^\s+["']?([A-Za-z0-9._-]+)["']?:\s*(#.*)?$/.exec(line);
		if (width === indent && match !== null) {
			out.push(match[1] as string);
		}
	}
	return out;
}

function filesFor(options: ComposeOptions, mode: string): readonly string[] {
	if (options.files === undefined) {
		return [];
	}
	return typeof options.files === "function" ? options.files(mode) : options.files;
}

function discoverServices(options: ComposeOptions, baseDir: string): string[] {
	const found = new Set<string>();
	let files: readonly string[] = [];
	try {
		files = filesFor(options, process.env.OUTDO_MODE ?? "");
	} catch {
		files = [];
	}
	if (files.length === 0) {
		files = [
			"compose.yaml",
			"compose.yml",
			"docker-compose.yaml",
			"docker-compose.yml",
		];
	}
	for (const file of files) {
		const path = resolve(baseDir, options.cwd ?? ".", file);
		if (existsSync(path)) {
			for (const name of servicesInFile(readFileSync(path, "utf8"))) {
				found.add(name);
			}
		}
	}
	return [
		...found,
	];
}

type Ctx = TaskCtx<Readonly<Record<string, string | undefined>>, Readonly<Record<string, unknown>>>;

/** `docker compose <global flags> <args>` with inherited stdio. Rejects on a non-zero exit. */
export async function runCompose(options: ComposeOptions, ctx: Ctx, args: readonly string[]): Promise<void> {
	const global: string[] = [];
	for (const file of filesFor(options, ctx.mode)) {
		global.push("-f", file);
	}
	if (options.project !== undefined) {
		global.push("-p", options.project);
	}
	const envFile = typeof options.envFile === "function" ? options.envFile(ctx.mode) : options.envFile;
	if (envFile !== undefined) {
		global.push("--env-file", envFile);
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(ctx.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	const proc = Bun.spawn(
		[
			"docker",
			"compose",
			...global,
			...args,
		],
		{
			cwd: options.cwd === undefined ? ctx.cwd : resolve(ctx.cwd, options.cwd),
			env: {
				...env,
				...options.env,
			},
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const onAbort = (): void => proc.kill();
	ctx.signal.addEventListener("abort", onAbort, {
		once: true,
	});
	const code = await proc.exited;
	ctx.signal.removeEventListener("abort", onAbort);
	if (code !== 0) {
		throw new Error(`docker compose ${args.join(" ")} exited with code ${code}`);
	}
}

export interface ComposeTasks {
	up: BuiltEntry;
	down: BuiltEntry;
	restart: BuiltEntry;
	rebuild: BuiltEntry;
	fresh: BuiltEntry;
	logs: BuiltEntry;
	ps: BuiltEntry;
	shell: BuiltEntry;
	exec: BuiltEntry;
}

/** The compose task set. Spread it into `defineTasks`; rename or drop keys freely. */
export function compose(options: ComposeOptions = {}, baseDir: string = process.cwd()): ComposeTasks {
	const group = options.group ?? "Docker";
	const known = options.services;
	const suggested = known === undefined ? discoverServices(options, baseDir) : undefined;
	const svc = (description: string, required: boolean) =>
		({
			type: "string",
			description,
			...(required
				? {
						required: true,
					}
				: {}),
			...(known !== undefined
				? {
						choices: known,
					}
				: {
						suggest: suggested,
					}),
		}) as const;
	const svcList = (ctx: Ctx): string[] => {
		const value = ctx.args.svc;
		return typeof value === "string" && value !== ""
			? [
					value,
				]
			: [];
	};
	const wait =
		options.wait === true
			? [
					"--wait",
				]
			: [];
	const up = (ctx: Ctx, extra: readonly string[] = []) =>
		runCompose(options, ctx, [
			"up",
			"-d",
			...extra,
			...wait,
			...svcList(ctx),
		]);
	const run = (fn: (ctx: Ctx) => Promise<void>) => (ctx: unknown) => fn(ctx as Ctx);

	return {
		up: task({
			group,
			desc: `Start the stack in the background${options.wait === true ? " and wait until it is healthy" : ""}`,
			args: {
				svc: svc("only this service", false),
			},
			positional: [
				"svc",
			],
			run: run((ctx) => up(ctx)),
		}),
		down: task({
			group,
			desc: "Stop and remove the stack's containers",
			run: run((ctx) =>
				runCompose(options, ctx, [
					"down",
				]),
			),
		}),
		restart: task({
			group,
			desc: "Stop the stack and start it again",
			run: run(async (ctx) => {
				await runCompose(options, ctx, [
					"down",
				]);
				await up(ctx);
			}),
		}),
		rebuild: task({
			group,
			desc: "Rebuild images and recreate the containers",
			args: {
				svc: svc("only this service", false),
			},
			positional: [
				"svc",
			],
			run: run((ctx) =>
				up(ctx, [
					"--build",
					"--force-recreate",
				]),
			),
		}),
		fresh: task({
			group,
			desc: "Wipe containers and volumes, then rebuild and start",
			destructive: true,
			protect: options.protect ?? "prod",
			run: run(async (ctx) => {
				await runCompose(options, ctx, [
					"down",
					"-v",
					"--remove-orphans",
				]);
				await up(ctx, [
					"--build",
				]);
			}),
		}),
		logs: task({
			group,
			desc: "Show service logs (-f to follow)",
			readonly: true,
			args: {
				svc: svc("only this service", false),
				follow: {
					type: "boolean",
					short: "f",
					description: "keep following",
				},
				tail: {
					type: "string",
					default: "200",
					description: "lines from the end",
				},
			},
			positional: [
				"svc",
			],
			run: run((ctx) =>
				runCompose(options, ctx, [
					"logs",
					`--tail=${String(ctx.args.tail)}`,
					...(ctx.args.follow === true
						? [
								"--follow",
							]
						: []),
					...svcList(ctx),
				]),
			),
		}),
		ps: task({
			group,
			desc: "List the stack's containers",
			readonly: true,
			run: run((ctx) =>
				runCompose(options, ctx, [
					"ps",
				]),
			),
		}),
		shell: task({
			group,
			desc: `Open a shell (${options.shell ?? "sh"}) in a running service`,
			args: {
				svc: svc("service", true),
			},
			positional: [
				"svc",
			],
			run: run((ctx) =>
				runCompose(options, ctx, [
					"exec",
					...svcList(ctx),
					options.shell ?? "sh",
				]),
			),
		}),
		exec: task({
			group,
			desc: "Run a command in a running service: outdo exec <svc> -- <cmd>",
			args: {
				svc: svc("service", true),
			},
			positional: [
				"svc",
			],
			run: run((ctx) =>
				runCompose(options, ctx, [
					"exec",
					...svcList(ctx),
					...ctx.rest,
				]),
			),
		}),
	};
}
