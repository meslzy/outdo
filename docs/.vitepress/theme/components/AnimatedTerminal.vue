<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * Home-hero terminal. Lines are structured (prefix column + text) instead of
 * space-padded strings so alignment survives any font size, and every metric
 * is em/ch-based so the whole thing scales down cleanly on small screens.
 */

interface Frame {
	delay: number;
	/** Multiplex prefix (task name) — omitted for the summary line. */
	prefix?: string;
	/** Palette class for the prefix. */
	color?: string;
	/** Line body; may contain palette spans. */
	html: string;
}

const COMMAND = "bundo build";

const FRAMES: Frame[] = [
	{
		delay: 420,
		prefix: "typecheck",
		color: "t-cyan",
		html: "$ bun run typecheck",
	},
	{
		delay: 90,
		prefix: "lint",
		color: "t-magenta",
		html: "$ bun run lint",
	},
	{
		delay: 700,
		prefix: "lint",
		color: "t-magenta",
		html: '<span class="t-green">✓</span> clean <span class="t-dim">(0.3s)</span>',
	},
	{
		delay: 620,
		prefix: "typecheck",
		color: "t-cyan",
		html: '<span class="t-green">✓</span> no errors <span class="t-dim">(1.2s)</span>',
	},
	{
		delay: 240,
		prefix: "build",
		color: "t-yellow",
		html: "$ bun build src/index.ts",
	},
	{
		delay: 520,
		prefix: "build",
		color: "t-yellow",
		html: '<span class="t-green">✓</span> dist/index.js <span class="t-dim">(0.4s)</span>',
	},
	{
		delay: 260,
		html: '<span class="t-green">✓</span> 3 tasks <span class="t-dim">·</span> 1 cached <span class="t-dim">·</span> 1.6s',
	},
];

const HOLD_MS = 3200;
const TYPE_MS = 62;

const typed = ref("");
const shown = ref(0);
const showCursor = ref(true);

let timer: ReturnType<typeof setTimeout> | undefined;

function schedule(fn: () => void, ms: number): void {
	timer = setTimeout(fn, ms);
}

function typeCommand(i: number): void {
	if (i <= COMMAND.length) {
		typed.value = COMMAND.slice(0, i);
		schedule(() => typeCommand(i + 1), TYPE_MS);
	} else {
		showCursor.value = false;
		playFrames(0);
	}
}

function playFrames(i: number): void {
	if (i < FRAMES.length) {
		schedule(() => {
			shown.value = i + 1;
			playFrames(i + 1);
		}, FRAMES[i].delay);
	} else {
		schedule(restart, HOLD_MS);
	}
}

function restart(): void {
	typed.value = "";
	shown.value = 0;
	showCursor.value = true;
	schedule(() => typeCommand(0), 500);
}

onMounted(() => {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		typed.value = COMMAND;
		shown.value = FRAMES.length;
		showCursor.value = false;
		return;
	}
	schedule(() => typeCommand(0), 600);
});

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
	<div class="bundo-terminal" aria-hidden="true">
		<div class="bt-chrome">
			<span class="bt-dot bt-red" />
			<span class="bt-dot bt-yellow" />
			<span class="bt-dot bt-green" />
			<span class="bt-title">bundo</span>
		</div>
		<div class="bt-screen">
			<div class="bt-line">
				<span class="t-green">❯</span>&nbsp;<span>{{ typed }}</span><span v-if="showCursor" class="bt-cursor">▊</span>
			</div>
			<div v-for="(frame, i) in FRAMES.slice(0, shown)" :key="i" class="bt-line">
				<template v-if="frame.prefix">
					<span class="bt-prefix" :class="frame.color">{{ frame.prefix }}</span>
					<span class="bt-sep">|</span>
				</template>
				<span class="bt-body" v-html="frame.html" />
			</div>
		</div>
	</div>
</template>

<style scoped>
.bundo-terminal {
	/* The hero slot (see custom.css) gives us the width; fill it. */
	width: 100%;
	max-width: 460px;
	margin-inline: auto;
	border-radius: 12px;
	overflow: hidden;
	background: #131110;
	border: 1px solid #2a2522;
	box-shadow:
		0 0 0 1px rgba(244, 162, 107, 0.08),
		0 18px 60px -18px rgba(244, 162, 107, 0.25),
		0 30px 90px -30px rgba(181, 107, 244, 0.2);
	text-align: left;
	font-family: var(--vp-font-family-mono);
	/* One knob scales every internal metric. */
	font-size: clamp(10.5px, 2.9vw, 12.5px);
}

.bt-chrome {
	position: relative;
	display: flex;
	align-items: center;
	gap: 0.55em;
	padding: 0.8em 1.1em;
	background: #1b1816;
	border-bottom: 1px solid #2a2522;
}

.bt-dot {
	width: 0.85em;
	height: 0.85em;
	border-radius: 50%;
	flex: none;
}
.bt-red {
	background: #f2707a;
}
.bt-yellow {
	background: #e8c56b;
}
.bt-green {
	background: #71d58a;
}

.bt-title {
	/* True centering, independent of the dots. */
	position: absolute;
	left: 50%;
	transform: translateX(-50%);
	color: #8a837c;
	font-size: 0.92em;
}

.bt-screen {
	padding: 1.2em 1.35em 1.35em;
	/* Reserve the full animation height so the box never jumps: command line
	   + 7 output lines at 1.75 line-height, in em so it scales with the font. */
	min-height: calc(8 * 1.75em + 2.55em);
	line-height: 1.75;
	color: #d8d2cb;
}

.bt-line {
	display: flex;
	align-items: baseline;
	white-space: nowrap;
	overflow: hidden;
	min-height: 1.75em;
}

.bt-prefix {
	/* Structural column instead of space padding — aligned at every size. */
	flex: none;
	width: 9.5ch;
}

.bt-sep {
	flex: none;
	color: #8a837c;
	margin-right: 1ch;
}

.bt-body {
	overflow: hidden;
	text-overflow: ellipsis;
}

.bt-cursor {
	animation: bt-blink 1s steps(1) infinite;
	color: #f4a26b;
}

@keyframes bt-blink {
	50% {
		opacity: 0;
	}
}

@media (prefers-reduced-motion: reduce) {
	.bt-cursor {
		animation: none;
	}
}
</style>
