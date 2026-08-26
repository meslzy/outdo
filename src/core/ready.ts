/**
 * Service readiness probes. A persistent task with `ready` unblocks its
 * dependents only once the probe passes:
 *   log  — substring match on the service's own output lines
 *   url  — HTTP GET returns 2xx (polled)
 *   port — TCP connect succeeds (polled)
 *
 * Every timer here is a clearable setTimeout raced with clear-on-settle —
 * never Bun.sleep (a pending sleep would hold the event loop open).
 */

import type { ReadyProbe } from "~/types";

export const READY_TIMEOUT_MS = 30_000;
export const READY_POLL_MS = 250;

export interface ReadyWait {
	/** Resolves true when ready; false on timeout or abort. Never rejects. */
	done: Promise<boolean>;
	/** Present only for log probes — feed one output line. */
	onLine?: (line: string) => void;
	/** Human description for errors, e.g. `log "READY"` or `port 3000`. */
	describe: string;
}

export function describeProbe(probe: ReadyProbe): string {
	if (probe.log !== undefined) {
		return `log "${probe.log}"`;
	}
	if (probe.url !== undefined) {
		return probe.url;
	}
	return `port ${probe.port}${probe.host !== undefined ? ` on ${probe.host}` : ""}`;
}

export function startReadyWait(probe: ReadyProbe, signal: AbortSignal): ReadyWait {
	const budget = probe.timeoutMs ?? READY_TIMEOUT_MS;
	let settle: (ready: boolean) => void = () => {};
	let settled = false;
	const cleanups: (() => void)[] = [];

	const done = new Promise<boolean>((resolve) => {
		settle = (ready) => {
			if (settled) {
				return;
			}
			settled = true;
			for (const cleanup of cleanups) {
				cleanup();
			}
			resolve(ready);
		};
	});

	const deadline = setTimeout(() => settle(false), budget);
	cleanups.push(() => clearTimeout(deadline));
	const onAbort = (): void => settle(false);
	signal.addEventListener("abort", onAbort, {
		once: true,
	});
	cleanups.push(() => signal.removeEventListener("abort", onAbort));
	if (signal.aborted) {
		settle(false);
	}

	let onLine: ((line: string) => void) | undefined;
	if (probe.log !== undefined) {
		const needle = probe.log;
		onLine = (line) => {
			if (line.includes(needle)) {
				settle(true);
			}
		};
	} else if (probe.url !== undefined) {
		pollUrl(probe.url, () => settled, settle, cleanups);
	} else if (probe.port !== undefined) {
		pollPort(probe.host ?? "127.0.0.1", probe.port, () => settled, settle, cleanups);
	}

	return {
		done,
		...(onLine !== undefined
			? {
					onLine,
				}
			: {}),
		describe: describeProbe(probe),
	};
}

function scheduleRetry(fn: () => void, isSettled: () => boolean, cleanups: (() => void)[]): void {
	const timer = setTimeout(() => {
		if (!isSettled()) {
			fn();
		}
	}, READY_POLL_MS);
	cleanups.push(() => clearTimeout(timer));
}

function pollUrl(
	url: string,
	isSettled: () => boolean,
	settle: (ready: boolean) => void,
	cleanups: (() => void)[],
): void {
	const attempt = (): void => {
		const perAttempt = new AbortController();
		const timer = setTimeout(() => perAttempt.abort(), 1000);
		cleanups.push(() => {
			clearTimeout(timer);
			perAttempt.abort();
		});
		fetch(url, {
			signal: perAttempt.signal,
		})
			.then((res) => {
				clearTimeout(timer);
				if (isSettled()) {
					return;
				}
				if (res.ok) {
					settle(true);
				} else {
					scheduleRetry(attempt, isSettled, cleanups);
				}
			})
			.catch(() => {
				clearTimeout(timer);
				if (!isSettled()) {
					scheduleRetry(attempt, isSettled, cleanups);
				}
			});
	};
	attempt();
}

function pollPort(
	host: string,
	port: number,
	isSettled: () => boolean,
	settle: (ready: boolean) => void,
	cleanups: (() => void)[],
): void {
	const attempt = (): void => {
		Bun.connect({
			hostname: host,
			port,
			socket: {
				open(socket) {
					socket.end();
					settle(true);
				},
				data() {},
				connectError() {
					if (!isSettled()) {
						scheduleRetry(attempt, isSettled, cleanups);
					}
				},
				error() {},
				close() {},
			},
		}).catch(() => {
			if (!isSettled()) {
				scheduleRetry(attempt, isSettled, cleanups);
			}
		});
	};
	attempt();
}
