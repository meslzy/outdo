import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const CLI = join(REPO, "src", "cli.ts");
const FIXTURE = join(REPO, "test", "fixtures", "watch");
const INDEX = join(REPO, "src", "index.ts").replaceAll("\\", "/");

async function makeDir(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "outdo-watch-"));
	cpSync(FIXTURE, dir, {
		recursive: true,
	});
	const doTs = join(dir, "do.ts");
	writeFileSync(doTs, (await Bun.file(doTs).text()).replace("../../../src/index", INDEX));
	return dir;
}

interface WatchSession {
	output(): string;
	waitFor(needle: string, ms: number): Promise<void>;
	stop(): Promise<void>;
}

function startWatch(dir: string, args: string[], env?: Record<string, string>): WatchSession {
	const proc = Bun.spawn(
		[
			process.execPath,
			CLI,
			"--color=never",
			"--watch",
			...args,
		],
		{
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
				...env,
			},
		},
	);
	let out = "";
	const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		for await (const chunk of stream) {
			out += new TextDecoder().decode(chunk);
		}
	};
	void collect(proc.stdout as ReadableStream<Uint8Array>);
	void collect(proc.stderr as ReadableStream<Uint8Array>);
	return {
		output: () => out,
		waitFor: async (needle, ms) => {
			const deadline = Date.now() + ms;
			while (!out.includes(needle)) {
				if (Date.now() > deadline) {
					throw new Error(`timeout waiting for ${JSON.stringify(needle)}\n--- output ---\n${out}`);
				}
				await Bun.sleep(50);
			}
		},
		stop: async () => {
			proc.kill();
			await proc.exited;
		},
	};
}

describe("watch mode", () => {
	test("file change re-runs the affected task and its dependents", async () => {
		const dir = await makeDir();
		const session = startWatch(dir, [
			"report",
		]);
		try {
			await session.waitFor("watching", 20_000);
			await Bun.sleep(300);
			writeFileSync(join(dir, "src", "input.txt"), "v2\n");
			await session.waitFor("BUILT content=v2", 20_000);
			// wait for the SECOND "REPORTED" — the first came from the initial run
			const deadline = Date.now() + 20_000;
			for (;;) {
				const count = session.output().split("REPORTED").length - 1;
				if (count >= 2) {
					break;
				}
				if (Date.now() > deadline) {
					throw new Error(`dependent did not re-run\n${session.output()}`);
				}
				await Bun.sleep(50);
			}
			expect(session.output().split("REPORTED").length - 1).toBeGreaterThanOrEqual(2);
		} finally {
			await session.stop();
		}
	}, 45_000);

	test("poll fallback backend re-runs too", async () => {
		const dir = await makeDir();
		const session = startWatch(
			dir,
			[
				"build",
			],
			{
				OUTDO_WATCH_POLL: "1",
			},
		);
		try {
			await session.waitFor("watching", 20_000);
			await Bun.sleep(700); // let the poller prime
			writeFileSync(join(dir, "src", "input.txt"), "v3\n");
			await session.waitFor("BUILT content=v3", 20_000);
		} finally {
			await session.stop();
		}
	}, 45_000);

	test("service restarts when its watch globs match", async () => {
		const dir = await makeDir();
		const session = startWatch(dir, [
			"server",
		]);
		try {
			await session.waitFor("SERVER up pid=", 20_000);
			const firstPid = /SERVER up pid=(\d+)/.exec(session.output())?.[1];
			await session.waitFor("watching", 20_000);
			await Bun.sleep(300);
			writeFileSync(join(dir, "src", "input.txt"), "restart\n");
			await session.waitFor("SERVER stopping", 20_000);
			const deadline = Date.now() + 20_000;
			for (;;) {
				const pids = [
					...session.output().matchAll(/SERVER up pid=(\d+)/g),
				].map((m) => m[1]);
				if (pids.length >= 2 && pids.at(-1) !== firstPid) {
					break;
				}
				if (Date.now() > deadline) {
					throw new Error(`service did not restart\n${session.output()}`);
				}
				await Bun.sleep(100);
			}
		} finally {
			await session.stop();
		}
	}, 60_000);
});
