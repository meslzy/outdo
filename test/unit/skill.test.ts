/** The bundled agent skill: discoverable layout, and its example kept in sync with a type test. */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SKILL = join(ROOT, "skills", "outdo", "SKILL.md");

describe("skills/outdo", () => {
	const text = readFileSync(SKILL, "utf8");

	test("has the frontmatter the skills CLI and Claude Code read", () => {
		const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
		expect(front).toMatch(/^name: outdo$/m);
		const description = /^description: (.+)$/m.exec(front)?.[1] ?? "";
		expect(description.length).toBeGreaterThan(50);
		expect(description.length).toBeLessThan(1024);
	});

	test("every referenced file exists", () => {
		for (const [, rel] of text.matchAll(/\]\((references\/[^)]+)\)/g)) {
			expect(existsSync(join(ROOT, "skills", "outdo", rel as string))).toBe(true);
		}
	});

	test("the do.ts example is the type-checked one in test/types/skill-example.ts", () => {
		const block = /## Writing tasks \(do\.ts\)\n\n```ts\n([\s\S]*?)```/.exec(text)?.[1];
		expect(block).toBeDefined();
		const typed = readFileSync(join(ROOT, "test", "types", "skill-example.ts"), "utf8");
		const body = typed.slice(typed.indexOf("\nimport ") + 1);
		expect(body.replace('from "~/index";', 'from "@meslzy/outdo";')).toBe(block as string);
	});

	test("ships in the npm package", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
			files: string[];
		};
		expect(pkg.files).toContain("skills");
	});
});
