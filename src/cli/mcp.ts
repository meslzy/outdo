/**
 * `outdo mcp` — a Model Context Protocol server over stdio (newline-delimited
 * JSON-RPC 2.0). Every runnable task becomes a tool: its flags are the input
 * schema (schema flags bring their own JSON Schema), `readonly`/`destructive`
 * map to readOnlyHint/destructiveHint, and a call runs `outdo run <task>` in
 * a child process and returns its output. Services are left out (they never
 * finish), and under OUTDO_READONLY=1 only readonly tasks are offered.
 * A task that asks for confirmation gets a `yes` input that must be set
 * explicitly — only after the user agreed.
 */

import { resolve } from "node:path";
import { loadProjectFromCwd } from "~/cli/load";
import { EXIT } from "~/core/errors";
import { hasBody } from "~/core/executor";
import { readonlyMode } from "~/core/guard";
import type { Project, Task } from "~/core/model";

const SELF = resolve(process.argv[1] as string);
const MAX_OUTPUT_CHARS = 30_000;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: number | string | null;
	method: string;
	params?: Record<string, unknown>;
}

interface ToolEntry {
	tool: Record<string, unknown>;
	task: Task;
	asks: boolean;
}

export function toolName(task: string, taken: Set<string>): string {
	const base = task.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "task";
	let name = base;
	for (let i = 2; taken.has(name); i++) {
		name = `${base}_${i}`;
	}
	taken.add(name);
	return name;
}

function argSchema(task: Task): {
	properties: Record<string, unknown>;
	required: string[];
} {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const [flag, def] of Object.entries(task.args)) {
		const base =
			def.jsonSchema !== undefined
				? {
						...def.jsonSchema,
					}
				: {
						type: def.type === "boolean" ? "boolean" : "string",
						...(def.choices !== undefined
							? {
									enum: def.choices,
								}
							: {}),
						...(def.default !== undefined
							? {
									default: def.default,
								}
							: {}),
					};
		properties[flag] = {
			...base,
			...(def.description !== undefined
				? {
						description: def.description,
					}
				: {}),
		};
		if (def.required) {
			required.push(flag);
		}
	}
	return {
		properties,
		required,
	};
}

export function buildTools(project: Project): Map<string, ToolEntry> {
	const readonly = readonlyMode();
	const taken = new Set<string>();
	const out = new Map<string, ToolEntry>();
	for (const task of project.tasks.values()) {
		if (task.kind === "hook" || task.persistent) {
			continue;
		}
		if (!hasBody(task) && task.deps.length === 0) {
			continue;
		}
		if (readonly && !task.readonly) {
			continue;
		}
		const asks = task.confirm !== undefined || task.protect.length > 0;
		const { properties, required } = argSchema(task);
		if (project.modes.length > 0 && !("mode" in properties)) {
			properties.mode = {
				type: "string",
				enum: project.modes,
				description: `outdo mode (default ${project.modes[0]})`,
			};
		}
		if (asks && !("yes" in properties)) {
			properties.yes = {
				type: "boolean",
				description: "This task asks for confirmation. Set true ONLY after the user explicitly agreed to run it now.",
			};
		}
		properties.rest = {
			type: "array",
			items: {
				type: "string",
			},
			description: "Extra arguments passed after `--`.",
		};
		const name = toolName(task.name, taken);
		const notes = [
			task.desc ?? `Runs the "${task.name}" task.`,
			task.command !== undefined ? `Runs: ${task.command.join(" && ")}` : undefined,
			task.script !== undefined ? `Runs the package.json script "${task.script}".` : undefined,
			asks ? "Asks for confirmation before running." : undefined,
		].filter((n) => n !== undefined);
		out.set(name, {
			task,
			asks,
			tool: {
				name,
				title: task.name,
				description: notes.join("\n"),
				inputSchema: {
					type: "object",
					properties,
					...(required.length > 0
						? {
								required,
							}
						: {}),
					additionalProperties: false,
				},
				annotations: {
					title: task.name,
					readOnlyHint: task.readonly,
					destructiveHint: task.destructive || asks,
					openWorldHint: false,
				},
			},
		});
	}
	return out;
}

/** CLI argv for a tool call: `outdo run <task> --flag value ... -- rest`. */
export function callArgv(entry: ToolEntry, input: Record<string, unknown>): string[] {
	const argv = [
		"--color=never",
	];
	const { task } = entry;
	if (typeof input.mode === "string" && !("mode" in task.args)) {
		argv.push(`--mode=${input.mode}`);
	}
	if (input.yes === true && entry.asks && !("yes" in task.args)) {
		argv.push("--yes");
	}
	argv.push("run", task.name);
	for (const [flag, value] of Object.entries(input)) {
		if (!(flag in task.args) || value === undefined || value === null) {
			continue;
		}
		if (value === true) {
			argv.push(`--${flag}`);
		} else if (value === false) {
		} else if (Array.isArray(value)) {
			for (const item of value) {
				argv.push(`--${flag}=${String(item)}`);
			}
		} else {
			argv.push(`--${flag}=${String(value)}`);
		}
	}
	const rest = Array.isArray(input.rest) ? input.rest.map(String) : [];
	if (rest.length > 0) {
		argv.push("--", ...rest);
	}
	return argv;
}

async function runTool(entry: ToolEntry, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
	const proc = Bun.spawn(
		[
			process.execPath,
			SELF,
			...callArgv(entry, input),
		],
		{
			cwd: process.cwd(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
			},
		},
	);
	const onAbort = (): void => proc.kill();
	signal.addEventListener("abort", onAbort, {
		once: true,
	});
	let output = "";
	const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			output += decoder.decode(chunk, {
				stream: true,
			});
		}
	};
	const [, , code] = await Promise.all([
		collect(proc.stdout),
		collect(proc.stderr),
		proc.exited,
	]);
	signal.removeEventListener("abort", onAbort);
	const text = output.length > MAX_OUTPUT_CHARS ? `…(earlier output cut)\n${output.slice(-MAX_OUTPUT_CHARS)}` : output;
	return {
		content: [
			{
				type: "text",
				text: `${text.trimEnd()}\n\n[outdo ${entry.task.name}: exit code ${code}]`,
			},
		],
		isError: code !== 0,
	};
}

export async function mcpCommand(): Promise<number> {
	const { default: pkg } = await import("../../package.json");
	let tools: Map<string, ToolEntry> | undefined;
	const loadTools = async (): Promise<Map<string, ToolEntry>> => {
		tools ??= buildTools(await loadProjectFromCwd());
		return tools;
	};
	const inflight = new Map<string | number, AbortController>();

	const send = (message: Record<string, unknown>): void => {
		process.stdout.write(`${JSON.stringify(message)}\n`);
	};
	const reply = (id: JsonRpcRequest["id"], result: unknown): void => {
		send({
			jsonrpc: "2.0",
			id: id ?? null,
			result,
		});
	};
	const fail = (id: JsonRpcRequest["id"], code: number, message: string): void => {
		send({
			jsonrpc: "2.0",
			id: id ?? null,
			error: {
				code,
				message,
			},
		});
	};

	const handle = async (request: JsonRpcRequest): Promise<void> => {
		const { id, method, params } = request;
		const isNotification = id === undefined;
		try {
			switch (method) {
				case "initialize":
					reply(id, {
						protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
						capabilities: {
							tools: {
								listChanged: false,
							},
						},
						serverInfo: {
							name: "outdo",
							version: pkg.version,
						},
						instructions:
							"Each tool runs one task from this repo's do.ts / package.json via outdo. Prefer tools marked read-only; ask the user before anything destructive.",
					});
					return;
				case "ping":
					reply(id, {});
					return;
				case "tools/list":
					reply(id, {
						tools: [
							...(await loadTools()).values(),
						].map((entry) => entry.tool),
					});
					return;
				case "tools/call": {
					const name = String(params?.name ?? "");
					const entry = (await loadTools()).get(name);
					if (entry === undefined) {
						fail(id, -32_602, `Unknown tool "${name}".`);
						return;
					}
					const aborter = new AbortController();
					if (id !== undefined && id !== null) {
						inflight.set(id, aborter);
					}
					try {
						reply(id, await runTool(entry, (params?.arguments ?? {}) as Record<string, unknown>, aborter.signal));
					} finally {
						if (id !== undefined && id !== null) {
							inflight.delete(id);
						}
					}
					return;
				}
				case "notifications/cancelled": {
					const target = params?.requestId as string | number | undefined;
					if (target !== undefined) {
						inflight.get(target)?.abort();
					}
					return;
				}
				default:
					if (!isNotification) {
						fail(id, -32_601, `Method not found: ${method}`);
					}
			}
		} catch (error) {
			if (!isNotification) {
				fail(id, -32_603, error instanceof Error ? error.message : String(error));
			}
		}
	};

	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of process.stdin) {
		buffer += decoder.decode(chunk as Uint8Array, {
			stream: true,
		});
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim() === "") {
				continue;
			}
			let request: JsonRpcRequest;
			try {
				request = JSON.parse(line) as JsonRpcRequest;
			} catch {
				fail(null, -32_700, "Parse error");
				continue;
			}
			void handle(request);
		}
	}
	return EXIT.ok;
}
