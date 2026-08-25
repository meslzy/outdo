import { describe, expect, test } from "bun:test";
import { expandValue, parseEnvFile } from "~/core/envfile";

describe("parseEnvFile", () => {
	test("basic pairs, comments, blank lines, export prefix", () => {
		const entries = parseEnvFile(
			[
				"# comment",
				"",
				"A=1",
				"export B=two",
				"  C = spaced  ",
			].join("\n"),
		);
		expect(entries.get("A")?.value).toBe("1");
		expect(entries.get("B")?.value).toBe("two");
		expect(entries.get("C")?.value).toBe("spaced");
	});

	test("double quotes unescape and keep expansion on", () => {
		const entries = parseEnvFile('MSG="line1\\nline2 \\"quoted\\""');
		expect(entries.get("MSG")?.value).toBe('line1\nline2 "quoted"');
	});

	test("single quotes parse (expansion applies later, matching Bun)", () => {
		const entries = parseEnvFile("RAW='$HOME here'");
		expect(entries.get("RAW")?.value).toBe("$HOME here");
	});

	test("inline comments only after whitespace", () => {
		const entries = parseEnvFile("URL=http://x#anchor\nPLAIN=value # trailing");
		expect(entries.get("URL")?.value).toBe("http://x#anchor");
		expect(entries.get("PLAIN")?.value).toBe("value");
	});

	test("CRLF input", () => {
		const entries = parseEnvFile("A=1\r\nB=2\r\n");
		expect(entries.get("B")?.value).toBe("2");
	});

	test("later duplicate wins", () => {
		const entries = parseEnvFile("A=1\nA=2");
		expect(entries.get("A")?.value).toBe("2");
	});
});

describe("expandValue", () => {
	const lookup = (name: string) =>
		({
			HOME: "/home/u",
			APP: "bundo",
		})[name];

	test("dollar-var and dollar-brace-var", () => {
		expect(expandValue("$APP at $HOME", lookup)).toBe("bundo at /home/u");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal test input
		expect(expandValue("${APP}-x", lookup)).toBe("bundo-x");
	});

	test("unknown vars become empty", () => {
		expect(expandValue("pre-$NOPE-post", lookup)).toBe("pre--post");
	});

	test("\\$ escapes", () => {
		expect(expandValue("cost \\$5", lookup)).toBe("cost $5");
	});
});
