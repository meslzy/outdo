/** Env explain mode — implemented in M2. */

import type { GlobalFlags } from "~/cli/parse";
import { BundoError } from "~/core/errors";

export async function printEnvCommand(_task: string, _flags: GlobalFlags): Promise<number> {
	throw new BundoError("usage", "--print-env is not implemented yet (M2).");
}
