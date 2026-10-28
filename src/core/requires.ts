/**
 * `requires` pre-checks: tools on PATH, env vars, files, and a reachable
 * URL/port. Run right before a task starts (deps may be what brings a service
 * up) and all at once by `outdo doctor`.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { withBinPath } from "~/core/executor";
import type { Requires } from "~/types";

export interface CheckResult {
	ok: boolean;
	/** What was checked, e.g. `bin docker`, `url http://...`. */
	label: string;
}

const NET_TIMEOUT_MS = 2000;

async function urlOk(url: string): Promise<boolean> {
	const aborter = new AbortController();
	const timer = setTimeout(() => aborter.abort(), NET_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: aborter.signal,
		});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

function portOk(host: string, port: number): Promise<boolean> {
	return new Promise((done) => {
		let settled = false;
		const finish = (ok: boolean): void => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				done(ok);
			}
		};
		const timer = setTimeout(() => finish(false), NET_TIMEOUT_MS);
		Bun.connect({
			hostname: host,
			port,
			socket: {
				open(socket) {
					socket.end();
					finish(true);
				},
				data() {},
				connectError() {
					finish(false);
				},
				error() {},
				close() {},
			},
		}).catch(() => finish(false));
	});
}

export async function checkRequires(
	req: Requires,
	cwd: string,
	env: Record<string, string | undefined>,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const pathEnv = withBinPath(env, cwd);
	const pathKey = Object.keys(pathEnv).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	for (const bin of req.bin ?? []) {
		results.push({
			ok:
				Bun.which(bin, {
					PATH: pathEnv[pathKey] ?? "",
				}) !== null,
			label: `bin ${bin}`,
		});
	}
	for (const name of req.env ?? []) {
		results.push({
			ok: (env[name] ?? "") !== "",
			label: `env ${name}`,
		});
	}
	for (const file of req.file ?? []) {
		results.push({
			ok: existsSync(resolve(cwd, file)),
			label: `file ${file}`,
		});
	}
	if (req.url !== undefined) {
		results.push({
			ok: await urlOk(req.url),
			label: `url ${req.url}`,
		});
	}
	if (req.port !== undefined) {
		const host = req.host ?? "127.0.0.1";
		results.push({
			ok: await portOk(host, req.port),
			label: `port ${host}:${req.port}`,
		});
	}
	return results;
}

/** One-line failure for a task's unmet requirements, or undefined when all pass. */
export function requiresFailure(taskName: string, req: Requires, results: readonly CheckResult[]): string | undefined {
	const failed = results.filter((r) => !r.ok).map((r) => r.label);
	if (failed.length === 0) {
		return undefined;
	}
	return `Task "${taskName}" requires ${failed.join(", ")}${req.hint !== undefined ? ` — ${req.hint}` : ""}`;
}
