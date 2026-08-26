/** Workspace-root tasks. Run `outdo build` here to fan out to every member. */

import { defineTasks } from "outdo";

export default defineTasks({
	"fmt:check": {
		desc: "Repo-wide format check",
		run: async ({ $ }) => {
			await $`bunx biome check .`;
		},
	},
});
