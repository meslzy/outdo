<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

type NodeState = "idle" | "running" | "done";

interface DagNode {
	id: string;
	label: string;
	x: number;
	y: number;
	runMs: number;
}

// bundo's own graph: three parallel tasks feeding `check`.
const NODES: DagNode[] = [
	{
		id: "typecheck",
		label: "typecheck",
		x: 30,
		y: 20,
		runMs: 1500,
	},
	{
		id: "lint",
		label: "lint",
		x: 30,
		y: 90,
		runMs: 900,
	},
	{
		id: "test",
		label: "test",
		x: 30,
		y: 160,
		runMs: 2000,
	},
	{
		id: "check",
		label: "check",
		x: 260,
		y: 90,
		runMs: 500,
	},
];

const EDGES: [
	string,
	string,
][] = [
	[
		"typecheck",
		"check",
	],
	[
		"lint",
		"check",
	],
	[
		"test",
		"check",
	],
];

const W = 96;
const H = 40;

const state = ref<Record<string, NodeState>>({});
const running = ref(false);
const root = ref<HTMLElement>();

let timers: ReturnType<typeof setTimeout>[] = [];
let observer: IntersectionObserver | undefined;

function reset(): void {
	const next: Record<string, NodeState> = {};
	for (const node of NODES) {
		next[node.id] = "idle";
	}
	state.value = next;
}

function later(fn: () => void, ms: number): void {
	timers.push(setTimeout(fn, ms));
}

function play(): void {
	if (running.value) {
		return;
	}
	for (const t of timers) {
		clearTimeout(t);
	}
	timers = [];
	reset();
	running.value = true;

	// The three parallel branches start together...
	const parallel = NODES.filter((n) => n.id !== "check");
	let slowest = 0;
	later(() => {
		for (const node of parallel) {
			state.value = {
				...state.value,
				[node.id]: "running",
			};
		}
	}, 300);
	for (const node of parallel) {
		slowest = Math.max(slowest, node.runMs);
		later(() => {
			state.value = {
				...state.value,
				[node.id]: "done",
			};
		}, 300 + node.runMs);
	}
	// ...and `check` unblocks only when the slowest finishes.
	later(
		() => {
			state.value = {
				...state.value,
				check: "running",
			};
		},
		300 + slowest + 150,
	);
	later(
		() => {
			state.value = {
				...state.value,
				check: "done",
			};
			running.value = false;
		},
		300 + slowest + 150 + 500,
	);
}

function finishInstantly(): void {
	const next: Record<string, NodeState> = {};
	for (const node of NODES) {
		next[node.id] = "done";
	}
	state.value = next;
}

onMounted(() => {
	reset();
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		finishInstantly();
		return;
	}
	observer = new IntersectionObserver(
		(entries) => {
			if (entries.some((e) => e.isIntersecting)) {
				play();
				observer?.disconnect();
			}
		},
		{
			threshold: 0.4,
		},
	);
	if (root.value) {
		observer.observe(root.value);
	}
});

onBeforeUnmount(() => {
	for (const t of timers) {
		clearTimeout(t);
	}
	observer?.disconnect();
});
</script>

<template>
	<div ref="root" class="dag-demo">
		<svg viewBox="0 0 390 220" role="img" aria-label="Diagram: typecheck, lint and test run in parallel, then check runs">
			<g v-for="[from, to] in EDGES" :key="from + to">
				<line
					class="dag-edge"
					:class="{ lit: state[from] === 'done' }"
					:x1="(NODES.find((n) => n.id === from)?.x ?? 0) + W"
					:y1="(NODES.find((n) => n.id === from)?.y ?? 0) + H / 2"
					:x2="NODES.find((n) => n.id === to)?.x ?? 0"
					:y2="(NODES.find((n) => n.id === to)?.y ?? 0) + H / 2"
				/>
			</g>
			<g v-for="node in NODES" :key="node.id" :class="['dag-node', state[node.id]]">
				<rect :x="node.x" :y="node.y" :width="W" :height="H" rx="9" />
				<text :x="node.x + 14" :y="node.y + H / 2 + 4">{{ node.label }}</text>
				<text v-if="state[node.id] === 'done'" class="dag-check" :x="node.x + W - 20" :y="node.y + H / 2 + 4">✓</text>
			</g>
		</svg>
		<button type="button" class="dag-replay" :disabled="running" @click="play">↺ replay</button>
	</div>
</template>

<style scoped>
.dag-demo {
	position: relative;
	margin: 24px 0;
	padding: 12px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 12px;
	background: var(--vp-c-bg-soft);
}

svg {
	display: block;
	width: 100%;
	max-width: 460px;
	margin: 0 auto;
	font-family: var(--vp-font-family-mono);
	font-size: 13px;
}

.dag-edge {
	stroke: var(--vp-c-divider);
	stroke-width: 1.6;
	transition: stroke 0.35s;
}

.dag-edge.lit {
	stroke: var(--vp-c-brand-1);
}

.dag-node rect {
	fill: var(--vp-c-bg);
	stroke: var(--vp-c-divider);
	stroke-width: 1.5;
	transition:
		stroke 0.3s,
		fill 0.3s;
}

.dag-node text {
	fill: var(--vp-c-text-2);
	transition: fill 0.3s;
}

.dag-node.running rect {
	stroke: var(--vp-c-brand-1);
	animation: dag-pulse 0.9s ease-in-out infinite;
}

.dag-node.running text {
	fill: var(--vp-c-text-1);
}

.dag-node.done rect {
	stroke: var(--vp-c-brand-1);
	fill: var(--vp-c-brand-soft);
}

.dag-node.done text {
	fill: var(--vp-c-text-1);
}

.dag-check {
	fill: #71d58a !important;
	font-weight: 700;
}

@keyframes dag-pulse {
	50% {
		stroke-opacity: 0.35;
	}
}

.dag-replay {
	position: absolute;
	top: 10px;
	right: 12px;
	font-size: 12px;
	color: var(--vp-c-text-2);
	border: 1px solid var(--vp-c-divider);
	border-radius: 6px;
	padding: 2px 8px;
	background: var(--vp-c-bg);
	cursor: pointer;
	transition:
		color 0.2s,
		border-color 0.2s;
}

.dag-replay:hover:not(:disabled) {
	color: var(--vp-c-brand-1);
	border-color: var(--vp-c-brand-1);
}

.dag-replay:disabled {
	opacity: 0.5;
	cursor: default;
}

@media (prefers-reduced-motion: reduce) {
	.dag-node.running rect {
		animation: none;
	}
}
</style>
