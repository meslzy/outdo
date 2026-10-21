/** `outdo bg`: start a service detached, see it, read its log, stop it. */

import { describe, expect, test } from "bun:test";
import { copyFixture, runCli } from "./helpers";

async function freePort(): Promise<number> {
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data() {},
		},
	});
	const port = server.port;
	server.stop(true);
	return port;
}

async function reachable(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/`, {
			signal: AbortSignal.timeout(1000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

describe("bg", () => {
	test("start returns once ready; ps, logs, stop", async () => {
		const dir = copyFixture("release");
		const port = await freePort();
		const env = {
			OUTDO_TEST_PORT: String(port),
		};
		const start = await runCli(
			dir,
			[
				"bg",
				"start",
				"server",
			],
			env,
		);
		try {
			expect(start.exitCode).toBe(0);
			expect(start.stdout).toContain("server ready");
			expect(await reachable(port)).toBe(true);

			const ps = await runCli(dir, [
				"bg",
				"ps",
				"--json",
			]);
			const entries = JSON.parse(ps.stdout) as {
				name: string;
				running: boolean;
				ports: number[];
			}[];
			expect(entries).toHaveLength(1);
			expect(entries[0]?.running).toBe(true);
			expect(entries[0]?.ports).toEqual([
				port,
			]);

			const logs = await runCli(dir, [
				"bg",
				"logs",
				"server",
			]);
			expect(logs.stdout).toContain(`SERVER UP ${port}`);

			const again = await runCli(
				dir,
				[
					"bg",
					"start",
					"server",
				],
				env,
			);
			expect(again.exitCode).toBe(2);
			expect(again.stderr).toContain("already running");
		} finally {
			const stop = await runCli(dir, [
				"bg",
				"stop",
			]);
			expect(stop.exitCode).toBe(0);
		}
		const deadline = Date.now() + 10_000;
		while ((await reachable(port)) && Date.now() < deadline) {
			await Bun.sleep(100);
		}
		expect(await reachable(port)).toBe(false);
		const ps = await runCli(dir, [
			"bg",
			"ps",
		]);
		expect(ps.stdout).toContain("nothing running");
	}, 60_000);

	test("a plain task just runs in the background", async () => {
		const dir = copyFixture("release");
		const r = await runCli(dir, [
			"bg",
			"start",
			"hello",
		]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("running in the background");
		const deadline = Date.now() + 10_000;
		let log = "";
		while (!log.includes("hello-from-command") && Date.now() < deadline) {
			await Bun.sleep(100);
			log = (
				await runCli(dir, [
					"bg",
					"logs",
					"hello",
				])
			).stdout;
		}
		expect(log).toContain("hello-from-command");
	}, 30_000);
});
