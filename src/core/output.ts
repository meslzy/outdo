/**
 * Multiplexed child output. `stream` prefixes lines live; `grouped` buffers
 * per task and flushes atomically on completion (failures always flush,
 * unless --output-logs=none).
 */

import { dim, prefixColor } from "~/core/logger";

export type LogOrder = "stream" | "grouped";
export type OutputLogs = "full" | "errors-only" | "none";

/** Buffer cap per task (services never finish; sessions can run for days). */
const MAX_BUFFERED_LINES = 10_000;

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
	readonly #dest: NodeJS.WriteStream;

	constructor(
		order: LogOrder,
		logs: OutputLogs,
		taskNames: readonly string[],
		dest: NodeJS.WriteStream = process.stdout,
	) {
		this.#order = order;
		this.#logs = logs;
		this.#labelWidth = Math.max(0, ...taskNames.map((name) => name.length));
		// Task-stdout destination — redirected to stderr under `--json` so
		// stdout carries exactly one machine-readable document.
		this.#dest = dest;
	}

	sink(name: string, onLine?: (line: string) => void): TaskSink {
		const color = prefixColor(name);
		const prefix = `${color(`${name.padEnd(this.#labelWidth)} |`)} `;
		// One STREAMING decoder per channel: a multi-byte character split across
		// chunks (or interleaved between stdout/stderr) must not become U+FFFD —
		// a readiness log probe matching a non-ASCII needle depends on this.
		const outDecoder = new TextDecoder();
		const errDecoder = new TextDecoder();
		let outTail = "";
		let errTail = "";
		// errors-only must buffer even in stream order — whether to show output
		// is only known once the task settles.
		const buffering = this.#order === "grouped" || this.#logs === "errors-only";
		const buffered: {
			text: string;
			isErr: boolean;
		}[] = [];
		let truncated = false;

		const emit = (line: string, isErr: boolean): void => {
			// Observers (readiness log probes) see every raw line regardless of
			// grouping or --output-logs.
			onLine?.(line);
			if (this.#logs === "none") {
				return;
			}
			const text = `${prefix}${line}\n`;
			if (buffering) {
				buffered.push({
					text,
					isErr,
				});
				// A persistent service never "finishes" — cap the buffer so it
				// cannot grow without bound over a long session.
				if (buffered.length > MAX_BUFFERED_LINES) {
					buffered.shift();
					truncated = true;
				}
			} else {
				(isErr ? process.stderr : this.#dest).write(text);
			}
		};

		const push = (chunk: Uint8Array, isErr: boolean): void => {
			const decoder = isErr ? errDecoder : outDecoder;
			const text =
				(isErr ? errTail : outTail)
				+ decoder.decode(chunk, {
					stream: true,
				});
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
				// Flush any bytes still held by the streaming decoders.
				outTail += outDecoder.decode();
				errTail += errDecoder.decode();
				if (outTail !== "") {
					emit(outTail, false);
					outTail = "";
				}
				if (errTail !== "") {
					emit(errTail, true);
					errTail = "";
				}
				if (buffering && buffered.length > 0) {
					const show = this.#logs === "full" || (!ok && this.#logs !== "none");
					if (show) {
						if (truncated) {
							this.#dest.write(`${prefix}${dim("[earlier output truncated]")}\n`);
						}
						// Preserve fd routing on flush, matching stream order.
						for (const entry of buffered) {
							(entry.isErr ? process.stderr : this.#dest).write(entry.text);
						}
					}
					buffered.length = 0;
					truncated = false;
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
