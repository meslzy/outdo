import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CLI, copyFixture, runCli } from "./helpers";

const READY_FIXTURE = join(import.meta.dir, "..", "fixtures", "ready");
const INVALID_READY_FIXTURE = join(import.meta.dir, "..", "fixtures", "invalid-ready");
const TIMEOUT_FIXTURE = join(import.meta.dir, "..", "fixtures", "timeout");

interface Session {
	output(): string;
	waitFor(needle: string, ms: number): Promise<void>;
	stop(): Promise<void>;
}

function startSession(dir: string, args: string[], env?: Record<string, string>): Session {
	const proc = Bun.spawn(
		[
			process.execPath,
			CLI,
			"--color=never",
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

/** Grab an OS-assigned free port, then release it for the fixture to claim. */
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

describe("service readiness", () => {
	test("log probe: dependent starts only after the ready line", async () => {
		// Stream order: grouped output would hold the service's lines until it exits.
		const session = startSession(READY_FIXTURE, [
			"--log-order=stream",
			"uses:log",
		]);
		try {
			await session.waitFor("LOG DEPENDENT RAN", 20_000);
			expect(session.output()).toContain("SVC READY");
			const out = session.output();
			expect(out.indexOf("SVC READY")).toBeLessThan(out.indexOf("LOG DEPENDENT RAN"));
		} finally {
			await session.stop();
		}
	}, 30_000);

	test("port probe: dependent waits for the TCP listener", async () => {
		const port = await freePort();
		const session = startSession(
			READY_FIXTURE,
			[
				"uses:port",
			],
			{
				OUTDO_TEST_PORT: String(port),
			},
		);
		try {
			await session.waitFor("PORT DEPENDENT RAN", 20_000);
		} finally {
			await session.stop();
		}
	}, 30_000);

	test("url probe: dependent waits for a 2xx response", async () => {
		const port = await freePort();
		const session = startSession(
			READY_FIXTURE,
			[
				"uses:url",
			],
			{
				OUTDO_TEST_URL: `http://127.0.0.1:${port}/health`,
			},
		);
		try {
			await session.waitFor("URL DEPENDENT RAN", 20_000);
		} finally {
			await session.stop();
		}
	}, 30_000);

	test("probe timeout fails the service and skips dependents", async () => {
		const startedAt = Date.now();
		const result = await runCli(READY_FIXTURE, [
			"uses:never",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not ready after 600ms");
		expect(result.stdout).not.toContain("NEVER DEPENDENT RAN");
		// Proves the custom 600ms budget applied (default is 30s).
		expect(Date.now() - startedAt).toBeLessThan(25_000);
	}, 30_000);

	test("ready on a non-persistent task is a config error", async () => {
		const result = await runCli(INVALID_READY_FIXTURE, [
			"notaservice",
		]);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("persistent");
	});
});

describe("retry", () => {
	test("succeeds on attempt 3 and caches; next run is a hit", async () => {
		const dir = copyFixture("retry");
		const result = await runCli(dir, [
			"flaky",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("FLAKY attempt=1");
		expect(result.stdout).toContain("FLAKY attempt=2");
		expect(result.stdout).toContain("FLAKY attempt=3");
		expect(result.stderr).toContain("retrying");
		expect(result.stderr).toContain("3 attempts");

		const second = await runCli(dir, [
			"flaky",
		]);
		expect(second.stderr).toContain("(cached)");
		expect(second.stdout).not.toContain("FLAKY");
	});

	test("retry works identically on the child backend", async () => {
		const dir = copyFixture("retry");
		const result = await runCli(dir, [
			"--isolate",
			"flaky",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("FLAKY attempt=3");
		expect(result.stderr).toContain("3 attempts");
	});

	test("exhausted retries fail with the final error", async () => {
		const dir = copyFixture("retry");
		const result = await runCli(dir, [
			"hopeless",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("HOPELESS attempt=2");
		expect(result.stdout).not.toContain("HOPELESS attempt=3");
		expect(result.stderr).toContain("always fails");
	});

	test("fail-fast abort cancels a pending retry delay", async () => {
		const dir = copyFixture("retry");
		const startedAt = Date.now();
		const result = await runCli(dir, [
			"slow-retry",
			"quick-fail",
		]);
		expect(result.exitCode).toBe(1);
		// slow-retry's 5s delay must be cancelled by quick-fail's fail-fast.
		expect(Date.now() - startedAt).toBeLessThan(4500);
		const attempts = result.stdout.split("SLOW-RETRY ATTEMPT").length - 1;
		expect(attempts).toBe(1);
	}, 20_000);
});

describe("timeout", () => {
	test("sequential backend: task fails after its budget", async () => {
		const startedAt = Date.now();
		const result = await runCli(TIMEOUT_FIXTURE, [
			"slow",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("timed out after 300ms");
		expect(result.stdout).not.toContain("SLOW FINISHED");
		expect(Date.now() - startedAt).toBeLessThan(10_000);
	}, 20_000);

	test("child backend: same semantics under --isolate", async () => {
		const result = await runCli(TIMEOUT_FIXTURE, [
			"--isolate",
			"slow",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("timed out after 300ms");
	}, 20_000);

	test("a task inside its budget passes", async () => {
		const result = await runCli(TIMEOUT_FIXTURE, [
			"quick",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("QUICK DONE");
	});
});
