import { defineTasks } from "../../../src/index";

const port = Number(process.env.BUNDO_TEST_PORT ?? "0") || 65_001;
const url = process.env.BUNDO_TEST_URL ?? "http://127.0.0.1:65002/health";
const urlPort = Number(new URL(url).port) || 65_002;

const holdUntilAbort = (signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		signal.addEventListener("abort", () => resolve(), {
			once: true,
		});
	});

export default defineTasks({
	"svc:log": {
		persistent: true,
		ready: {
			log: "SVC READY",
		},
		run: async ({ signal }) => {
			console.log("warming up");
			await Bun.sleep(200);
			console.log("SVC READY");
			await holdUntilAbort(signal);
		},
	},
	"uses:log": {
		deps: [
			"svc:log",
		],
		run: () => {
			console.log("LOG DEPENDENT RAN");
		},
	},
	"svc:never": {
		persistent: true,
		ready: {
			log: "WILL NEVER PRINT",
			timeoutMs: 600,
		},
		run: async ({ signal }) => {
			console.log("some other line");
			await holdUntilAbort(signal);
		},
	},
	"uses:never": {
		deps: [
			"svc:never",
		],
		run: () => {
			console.log("NEVER DEPENDENT RAN");
		},
	},
	"svc:port": {
		persistent: true,
		ready: {
			port,
		},
		run: async ({ signal }) => {
			await Bun.sleep(150);
			const server = Bun.listen({
				hostname: "127.0.0.1",
				port,
				socket: {
					data() {},
				},
			});
			await holdUntilAbort(signal);
			server.stop(true);
		},
	},
	"uses:port": {
		deps: [
			"svc:port",
		],
		run: () => {
			console.log("PORT DEPENDENT RAN");
		},
	},
	"svc:url": {
		persistent: true,
		ready: {
			url,
		},
		run: async ({ signal }) => {
			await Bun.sleep(150);
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: urlPort,
				fetch: () => new Response("ok"),
			});
			await holdUntilAbort(signal);
			await server.stop(true);
		},
	},
	"uses:url": {
		deps: [
			"svc:url",
		],
		run: () => {
			console.log("URL DEPENDENT RAN");
		},
	},
});
