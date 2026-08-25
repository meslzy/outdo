import { defineConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

export default defineConfig({
	title: "bundo",
	description: "The typed task runner for Bun — tasks in a typed do.ts, zero runtime dependencies.",
	base: "/bundo/",
	appearance: "dark",
	lastUpdated: true,
	vite: {
		plugins: [
			// Emits llms.txt (index) + llms-full.txt (full docs) into the built
			// site so AI agents can ingest the documentation in one request.
			llmstxt({
				// The plugin appends the site `base` (/bundo/) itself.
				domain: "https://meslzy.github.io",
			}),
		],
	},
	head: [
		[
			"link",
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/bundo/logo.svg",
			},
		],
		[
			"link",
			{
				rel: "preconnect",
				href: "https://fonts.googleapis.com",
			},
		],
		[
			"link",
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossorigin: "",
			},
		],
		[
			"link",
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400..700;1,400..700&display=swap",
			},
		],
		[
			"meta",
			{
				property: "og:title",
				content: "bundo — the typed task runner for Bun",
			},
		],
		[
			"meta",
			{
				property: "og:description",
				content:
					"Tasks in a typed do.ts. Compile-time dependency checking, schema-validated env, parallel DAG scheduler, caching, watch mode, workspaces.",
			},
		],
		[
			"meta",
			{
				property: "og:type",
				content: "website",
			},
		],
	],
	themeConfig: {
		logo: "/logo.svg",
		search: {
			provider: "local",
		},
		nav: [
			{
				text: "Guide",
				link: "/guide/getting-started",
				activeMatch: "/guide/",
			},
			{
				text: "Reference",
				link: "/reference/cli",
				activeMatch: "/reference/",
			},
			{
				text: "v0.0.1",
				link: "https://github.com/meslzy/bundo/releases",
			},
		],
		sidebar: [
			{
				text: "Guide",
				items: [
					{
						text: "Getting Started",
						link: "/guide/getting-started",
					},
					{
						text: "Why bundo?",
						link: "/guide/why-bundo",
					},
					{
						text: "Tasks & Dependencies",
						link: "/guide/tasks-and-deps",
					},
					{
						text: "Execution Model",
						link: "/guide/execution",
					},
					{
						text: "Environment",
						link: "/guide/env",
					},
					{
						text: "Args & Flags",
						link: "/guide/args-and-flags",
					},
					{
						text: "Caching",
						link: "/guide/caching",
					},
					{
						text: "Watch & Services",
						link: "/guide/watch-and-services",
					},
					{
						text: "Workspaces",
						link: "/guide/workspaces",
					},
				],
			},
			{
				text: "Reference",
				items: [
					{
						text: "CLI",
						link: "/reference/cli",
					},
					{
						text: "Task API",
						link: "/reference/task-api",
					},
					{
						text: "Exit Codes & JSON",
						link: "/reference/exit-codes-and-json",
					},
					{
						text: "For AI Agents",
						link: "/reference/ai-agents",
					},
				],
			},
		],
		socialLinks: [
			{
				icon: "github",
				link: "https://github.com/meslzy/bundo",
			},
		],
		editLink: {
			pattern: "https://github.com/meslzy/bundo/edit/main/docs/:path",
			text: "Edit this page on GitHub",
		},
		footer: {
			message: "Released under the MIT License.",
			copyright: "Copyright © 2026 meslzy",
		},
	},
});
