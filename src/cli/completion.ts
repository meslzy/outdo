/** Shell completion scripts — implemented in M8. */

import { BundoError } from "~/core/errors";

export async function completionCommand(_shell: string | undefined): Promise<number> {
	throw new BundoError("usage", "bundo completion is not implemented yet (M8).");
}
