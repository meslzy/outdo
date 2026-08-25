/** Dependency graph rendering — implemented in M8. */

import type { GlobalFlags } from "~/cli/parse";
import { BundoError } from "~/core/errors";

export async function graphCommand(_dot: boolean, _flags: GlobalFlags): Promise<number> {
	throw new BundoError("usage", "bundo graph is not implemented yet (M8).");
}
