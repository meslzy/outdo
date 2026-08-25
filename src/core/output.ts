/**
 * Multiplexed child output. `stream` prefixes lines live; `grouped` buffers
 * per task and flushes atomically on completion (failures always flush,
 * unless --output-logs=none).
 */

import { dim, prefixColor } from "~/core/logger";

export type LogOrder = "stream" | "grouped";
export type OutputLogs = "full" | "errors-only" | "none";

export interface TaskSink {
	stdout(chunk: Uint8Array): void;
	stderr(chunk: Uint8Array): void;
	/** Flush buffered output (grouped mode). ok=false always flushes. */
	finish(ok: boolean): void;
}

export class OutputMultiplexer {
	readonly #order: LogOrder;
	readonly #logs: OutputLogs;
	readonly #labelWidth: number;

	constructor(order: LogOrder, logs: OutputLogs, taskNames: readonly string[]) {
		this.#order = order;
		this.#logs = logs;
		this.#labelWidth = Math.max(0, ...taskNames.map((name) => name.length));
	}

	sink(name: string): TaskSink {
		const color = prefixColor(name);
		const prefix = `${color(`${name.padEnd(this.#labelWidth)} |`)} `;
		const decoder = new TextDecoder();
		let outTail = "";
		let errTail = "";
		const buffered: string[] = [];

		const emit = (line: string, isErr: boolean): void => {
			const text = `${prefix}${line}\n`;
			if (this.#order === "stream") {
				if (this.#logs !== "none") {
					(isErr ? process.stderr : process.stdout).write(text);
				}
			} else {
				buffered.push(text);
			}
		};

		const push = (chunk: Uint8Array, isErr: boolean): void => {
			const text = (isErr ? errTail : outTail) + decoder.decode(chunk);
			const lines = text.split("\n");
			const tail = lines.pop() ?? "";
			if (isErr) {
				errTail = tail;
			} else {
				outTail = tail;
			}
			for (const line of lines) {
				emit(line.endsWith("\r") ? line.slice(0, -1) : line, isErr);
			}
		};

		return {
			stdout: (chunk) => push(chunk, false),
			stderr: (chunk) => push(chunk, true),
			finish: (ok) => {
				if (outTail !== "") {
					emit(outTail, false);
					outTail = "";
				}
				if (errTail !== "") {
					emit(errTail, true);
					errTail = "";
				}
				if (this.#order === "grouped" && buffered.length > 0) {
					const show = this.#logs === "full" || (!ok && this.#logs !== "none");
					if (show) {
						process.stdout.write(buffered.join(""));
					}
					buffered.length = 0;
				}
			},
		};
	}

	/** Consume a ReadableStream into a sink channel. */
	static async pipe(stream: ReadableStream<Uint8Array>, write: (chunk: Uint8Array) => void): Promise<void> {
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value !== undefined) {
				write(value);
			}
		}
	}
}

export function statusLine(ok: boolean, name: string, ms: number, symbolOk: string, symbolFail: string): string {
	return `${ok ? symbolOk : symbolFail} ${name} ${dim(`(${ms}ms)`)}`;
}
