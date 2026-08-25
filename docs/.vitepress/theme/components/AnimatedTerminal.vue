<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

interface Frame {
	delay: number;
	html: string;
}

const PROMPT = '<span class="t-green">❯</span> ';
const COMMAND = "bundo build";

const FRAMES: Frame[] = [
	{
		delay: 420,
		html: '<span class="t-cyan">typecheck</span> <span class="t-dim">|</span> $ bun run typecheck',
	},
	{
		delay: 90,
		html: '<span class="t-magenta">lint</span>      <span class="t-dim">|</span> $ bun run lint',
	},
	{
		delay: 700,
		html: '<span class="t-magenta">lint</span>      <span class="t-dim">|</span> <span class="t-green">✓</span> clean <span class="t-dim">(0.3s)</span>',
	},
	{
		delay: 620,
		html: '<span class="t-cyan">typecheck</span> <span class="t-dim">|</span> <span class="t-green">✓</span> no errors <span class="t-dim">(1.2s)</span>',
	},
	{
		delay: 240,
		html: '<span class="t-yellow">build</span>     <span class="t-dim">|</span> $ bun build src/index.ts --outdir dist',
	},
	{
		delay: 520,
		html: '<span class="t-yellow">build</span>     <span class="t-dim">|</span> <span class="t-green">✓</span> dist/index.js <span class="t-dim">(0.4s)</span>',
	},
	{
		delay: 260,
		html: '<span class="t-green">✓</span> 3 tasks <span class="t-dim">·</span> 1 cached <span class="t-dim">·</span> 1.6s',
	},
];

const HOLD_MS = 3200;
const TYPE_MS = 62;

const typed = ref("");
const lines = ref<string[]>([]);
const showCursor = ref(true);
const reduced = ref(false);

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
		const frame = FRAMES[i];
		schedule(() => {
			lines.value = [
				...lines.value,
				frame.html,
			];
			playFrames(i + 1);
		}, frame.delay);
	} else {
		schedule(restart, HOLD_MS);
	}
}

function restart(): void {
	typed.value = "";
	lines.value = [];
	showCursor.value = true;
	schedule(() => typeCommand(0), 500);
}

onMounted(() => {
	reduced.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (reduced.value) {
		typed.value = COMMAND;
		lines.value = FRAMES.map((f) => f.html);
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
		<pre class="bt-screen"><span class="bt-line" v-html="PROMPT + typed" /><span v-if="showCursor" class="bt-cursor">▊</span><span
			v-for="(line, i) in lines"
			:key="i"
			class="bt-line"
			v-html="'\n' + line"
		/></pre>
	</div>
</template>

<style scoped>
.bundo-terminal {
	width: min(440px, 92vw);
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
}

.bt-chrome {
	display: flex;
	align-items: center;
	gap: 7px;
	padding: 10px 14px;
	background: #1b1816;
	border-bottom: 1px solid #2a2522;
}

.bt-dot {
	width: 11px;
	height: 11px;
	border-radius: 50%;
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
	margin-left: auto;
	margin-right: auto;
	transform: translateX(-22px);
	color: #8a837c;
	font-size: 12px;
}

.bt-screen {
	margin: 0;
	padding: 16px 18px 18px;
	min-height: 218px;
	font-size: 12.5px;
	line-height: 1.75;
	color: #d8d2cb;
	white-space: pre;
	overflow-x: auto;
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
