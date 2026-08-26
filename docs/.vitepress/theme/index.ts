import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import AnimatedTerminal from "./components/AnimatedTerminal.vue";
import CacheRace from "./components/CacheRace.vue";
import ContextCard from "./components/ContextCard.vue";
import DagDemo from "./components/DagDemo.vue";
import "./custom.css";

export default {
	extends: DefaultTheme,
	Layout: () =>
		h(DefaultTheme.Layout, null, {
			"home-hero-image": () => h(AnimatedTerminal),
		}),
	enhanceApp({ app }) {
		app.component("DagDemo", DagDemo);
		app.component("CacheRace", CacheRace);
		app.component("ContextCard", ContextCard);
	},
} satisfies Theme;
