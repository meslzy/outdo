/**
 * Shared integration-test helpers. Lives OUTSIDE any *.test.ts file on
 * purpose: importing a test file re-registers its describe blocks in the
 * importer, which duplicates tests and races snapshots under `bun test
 * --parallel`.
 */

import { join } from "node:path";

export const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

export interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export async function runCli(cwd: string, args: string[], env?: Record<string, string>): Promise<CliResult> {
	const proc = Bun.spawn(
		[
			process.execPath,
			CLI,
			"--color=never",
			...args,
		],
		{
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
				...env,
			},
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		exitCode,
		stdout,
		stderr,
	};
}
