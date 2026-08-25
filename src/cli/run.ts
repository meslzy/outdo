/** Run pipeline — implemented in M2/M3. */

import type { Command, GlobalFlags } from "~/cli/parse";
import { BundoError } from "~/core/errors";

export async function runCommand(
	_command: Extract<
		Command,
		{
			kind: "run";
		}
	>,
	_flags: GlobalFlags,
): Promise<number> {
	throw new BundoError("usage", "Task execution is not implemented yet (M2).");
}
