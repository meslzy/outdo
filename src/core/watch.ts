/**
 * File watching: fs.watch({recursive}) on static glob roots with an 80ms
 * trailing debounce and change coalescing. BUNDO_WATCH_POLL=1 (or an
 * fs.watch failure) switches to a 500ms mtime poller — the escape hatch for
 * Docker volumes, NFS, and other event-less filesystems.
 */

import { type FSWatcher, watch as fsWatch, statSync } from "node:fs";
import { join } from "node:path";
import { expand } from "~/core/globs";
import { debugLog } from "~/core/logger";

export const DEBOUNCE_MS = 80;
export const POLL_MS = 500;

const IGNORED = [
	"node_modules",
	".git",
	".bundo",
];

export interface Watcher {
	close(): void;
}

export interface WatchTarget {
	/** Absolute directory the fs backend observes (narrowed static root). */
	root: string;
	/** Base directory the patterns are relative to (the task cwd). */
	base: string;
	/** Glob patterns (relative to base) used by the poll fallback. */
	patterns: readonly string[];
}

function ignored(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	return IGNORED.some((part) => normalized.includes(`/${part}/`) || normalized.startsWith(`${part}/`));
}

/**
 * Watch the targets; `onBatch` receives coalesced absolute paths. Falls back
 * to polling when fs.watch is unavailable or BUNDO_WATCH_POLL=1.
 */
export function startWatcher(targets: readonly WatchTarget[], onBatch: (paths: Set<string>) => void): Watcher {
	if (process.env.BUNDO_WATCH_POLL === "1") {
		return startPoller(targets, onBatch);
	}
	try {
		return startFsWatcher(targets, onBatch);
	} catch (error) {
		debugLog("fs.watch failed, falling back to polling:", error);
		return startPoller(targets, onBatch);
	}
}

function startFsWatcher(targets: readonly WatchTarget[], onBatch: (paths: Set<string>) => void): Watcher {
	const pending = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = (): void => {
		timer = undefined;
		if (pending.size > 0) {
			const batch = new Set(pending);
			pending.clear();
			onBatch(batch);
		}
	};

	const watchers: FSWatcher[] = [];
	for (const target of targets) {
		const watcher = fsWatch(
			target.root,
			{
				recursive: true,
			},
			(_event, filename) => {
				// A null filename means "something changed" — flag the root itself.
				const abs = filename === null ? target.root : join(target.root, filename.toString());
				if (ignored(abs)) {
					return;
				}
				pending.add(abs.replaceAll("\\", "/"));
				clearTimeout(timer);
				timer = setTimeout(flush, DEBOUNCE_MS);
			},
		);
		watchers.push(watcher);
	}
	return {
		close: () => {
			clearTimeout(timer);
			for (const watcher of watchers) {
				watcher.close();
			}
		},
	};
}

function startPoller(targets: readonly WatchTarget[], onBatch: (paths: Set<string>) => void): Watcher {
	let closed = false;
	const known = new Map<string, number>();
	let primed = false;

	const scan = async (): Promise<void> => {
		const changed = new Set<string>();
		const seen = new Set<string>();
		for (const target of targets) {
			for (const rel of await expand(target.patterns, target.base)) {
				const abs = join(target.base, rel).replaceAll("\\", "/");
				if (ignored(abs)) {
					continue;
				}
				seen.add(abs);
				let mtime: number;
				try {
					mtime = statSync(abs).mtimeMs;
				} catch {
					continue;
				}
				const prior = known.get(abs);
				if (prior === undefined || prior !== mtime) {
					known.set(abs, mtime);
					if (primed) {
						changed.add(abs);
					}
				}
			}
		}
		for (const path of known.keys()) {
			if (!seen.has(path)) {
				known.delete(path);
				if (primed) {
					changed.add(path); // deletion
				}
			}
		}
		primed = true;
		if (changed.size > 0 && !closed) {
			onBatch(changed);
		}
	};

	const loop = async (): Promise<void> => {
		while (!closed) {
			await scan();
			await Bun.sleep(POLL_MS);
		}
	};
	void loop();
	return {
		close: () => {
			closed = true;
		},
	};
}
