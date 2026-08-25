/**
 * Compile-time assertions for conditional/optional deps and typed data
 * outputs (ctx.deps / from()). Gated by `tsc --noEmit`.
 */

import { defineTasks, from, optional, task } from "~/index";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare function assertTrue<T extends true>(): void;

// --- 1. object dep entries are name-checked ----------------------------------
defineTasks({
	build: {},
	ship: {
		deps: [
			"build",
			{
				task: "build",
				if: "CI",
			},
		],
	},
});

defineTasks({
	build: {},
	broken: {
		// @ts-expect-error — "biuld" is not a task name (object entry)
		deps: [
			{
				task: "biuld",
				if: "CI",
			},
		],
	},
});

// --- 2. optional deps may name absent tasks ----------------------------------
defineTasks({
	build: {},
	ship: {
		deps: [
			"build",
			optional("notify"), // not defined anywhere — fine
		],
	},
});

// --- 3. condition predicates see the raw env ---------------------------------
defineTasks({
	test: {},
	deploy: {
		deps: [
			{
				task: "test",
				if: (env) => {
					assertTrue<Equal<typeof env, Readonly<Record<string, string | undefined>>>>();
					return env.CI !== undefined;
				},
			},
		],
	},
});

// --- 4. from() carries the producer's run() return type into ctx.deps --------
const version = task({
	run: () => ({
		tag: "1.2.3",
		build: 42,
	}),
});

const release = task({
	deps: [
		from("version", version),
	],
	run: ({ deps }) => {
		assertTrue<Equal<typeof deps.version.tag, string>>();
		assertTrue<Equal<typeof deps.version.build, number>>();
		// @ts-expect-error — nope is not part of the producer's output
		deps.version.nope;
	},
});

defineTasks({
	version,
	release,
});

// --- 5. async producers are awaited -------------------------------------------
const fetcher = task({
	run: async () => "payload",
});

defineTasks({
	fetcher,
	consume: task({
		deps: [
			from("fetcher", fetcher),
		],
		run: ({ deps }) => {
			assertTrue<Equal<typeof deps.fetcher, string>>();
		},
	}),
});

// --- 6. conditional/optional from() entries widen with undefined --------------
const maybe = task({
	run: () => 7,
});

defineTasks({
	maybe,
	uses: task({
		deps: [
			{
				...from("maybe", maybe),
				if: "CI",
			},
		],
		run: ({ deps }) => {
			assertTrue<Equal<typeof deps.maybe, number | undefined>>();
		},
	}),
});

// --- 7. plain string deps give unknown outputs --------------------------------
defineTasks({
	a: {
		run: () => 1,
	},
	b: task({
		deps: [
			"a",
		],
		run: ({ deps }) => {
			assertTrue<Equal<typeof deps.a, unknown>>();
		},
	}),
});

// --- 8. from() still name-checks through DepsCheck ----------------------------
defineTasks({
	version,
	// @ts-expect-error — "verison" is not a task name
	broken: task({
		deps: [
			from("verison", version),
		],
	}),
});

// --- 9. resilience fields typecheck -------------------------------------------
defineTasks({
	flaky: {
		retry: 3,
		timeoutMs: 5000,
		run: () => {},
	},
	careful: task({
		retry: {
			attempts: 3,
			delayMs: 100,
			backoff: "exponential",
		},
		run: () => {},
	}),
	server: {
		persistent: true,
		ready: {
			log: "listening",
			timeoutMs: 10_000,
		},
		run: () => {},
	},
	db: {
		persistent: true,
		ready: {
			port: 5432,
			host: "127.0.0.1",
		},
		run: () => {},
	},
	web: {
		persistent: true,
		ready: {
			url: "http://localhost:3000/health",
		},
		run: () => {},
	},
	bad: {
		ready: {
			// @ts-expect-error — bogus probe kind
			socket: 1,
		},
	},
});
