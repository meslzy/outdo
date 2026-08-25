/** Retry policy helpers, shared by both execution backends. */

import type { RetrySpec } from "~/types";

/** Delay before retry number `attempt` (1-based: the delay after attempt N failing). */
export function retryDelayMs(retry: Required<RetrySpec>, attempt: number): number {
	if (retry.backoff === "exponential") {
		return retry.delayMs * 2 ** (attempt - 1);
	}
	return retry.delayMs;
}

/**
 * Clearable-setTimeout sleep that resolves early (false) when the signal
 * aborts — never Bun.sleep, which would hold the event loop in a race.
 */
export function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve(false);
		};
		signal.addEventListener("abort", onAbort, {
			once: true,
		});
	});
}
