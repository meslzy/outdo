import { afterEach, describe, expect, test } from "bun:test";
import { colorsEnabled, dim, prefixColor, red, resolveColor, setColorMode } from "~/core/logger";

const ENV_KEYS = [
	"FORCE_COLOR",
	"NO_COLOR",
	"TERM",
] as const;
const saved = new Map<string, string | undefined>(
	ENV_KEYS.map((key) => [
		key,
		process.env[key],
	]),
);

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = saved.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	setColorMode("auto");
});

describe("resolveColor precedence", () => {
	test("explicit mode beats everything", () => {
		process.env.NO_COLOR = "1";
		expect(resolveColor("always")).toBe(true);
		process.env.FORCE_COLOR = "1";
		expect(resolveColor("never")).toBe(false);
	});

	test("FORCE_COLOR wins over NO_COLOR in auto mode", () => {
		process.env.FORCE_COLOR = "1";
		process.env.NO_COLOR = "1";
		expect(resolveColor("auto")).toBe(true);
	});

	test("FORCE_COLOR=0 does not force colors on", () => {
		delete process.env.NO_COLOR;
		process.env.FORCE_COLOR = "0";
		process.env.TERM = "dumb";
		expect(resolveColor("auto")).toBe(false);
	});

	test("NO_COLOR disables in auto mode", () => {
		delete process.env.FORCE_COLOR;
		process.env.NO_COLOR = "1";
		expect(resolveColor("auto")).toBe(false);
	});

	test("TERM=dumb disables when nothing else decides", () => {
		delete process.env.FORCE_COLOR;
		delete process.env.NO_COLOR;
		process.env.TERM = "dumb";
		expect(resolveColor("auto")).toBe(false);
	});
});

describe("styles", () => {
	test("wrap with ANSI codes only when colors are on", () => {
		setColorMode("always");
		expect(colorsEnabled()).toBe(true);
		expect(red("x")).toBe("\x1b[31mx\x1b[39m");
		expect(dim("x")).toBe("\x1b[2mx\x1b[22m");

		setColorMode("never");
		expect(colorsEnabled()).toBe(false);
		expect(red("x")).toBe("x");
		expect(dim("x")).toBe("x");
	});
});

describe("prefixColor", () => {
	test("is stable per name", () => {
		expect(prefixColor("build")).toBe(prefixColor("build"));
	});

	test("colors the text when enabled", () => {
		setColorMode("always");
		const colored = prefixColor("build")("build");
		expect(colored).toContain("\x1b[");
		expect(colored).toContain("build");
	});
});
