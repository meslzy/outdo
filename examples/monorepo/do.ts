/** Workspace-root tasks. Run `bundo build` here to fan out to every member. */

import { defineTasks } from "bundo";

export default defineTasks({
	"fmt:check": {
		desc: "Repo-wide format check",
		run: async ({ $ }) => {
			await $`bunx biome check .`;
		},
	},
});
