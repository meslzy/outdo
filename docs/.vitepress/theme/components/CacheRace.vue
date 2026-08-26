<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const COLD_MS = 2400; // animation duration representing 12.4s
const HIT_MS = 180;

const started = ref(false);
const coldDone = ref(false);
const hitDone = ref(false);
const root = ref<HTMLElement>();

let observer: IntersectionObserver | undefined;
let timers: ReturnType<typeof setTimeout>[] = [];

function play(): void {
	started.value = false;
	coldDone.value = false;
	hitDone.value = false;
	timers.push(
		setTimeout(() => {
			started.value = true;
			timers.push(setTimeout(() => (hitDone.value = true), HIT_MS + 80));
			timers.push(setTimeout(() => (coldDone.value = true), COLD_MS + 80));
		}, 60),
	);
}

onMounted(() => {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		started.value = true;
		coldDone.value = true;
		hitDone.value = true;
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
			threshold: 0.5,
		},
	);
	if (root.value) {
		observer.observe(root.value);
	}
});

onBeforeUnmount(() => {
	observer?.disconnect();
	for (const t of timers) {
		clearTimeout(t);
	}
});
</script>

<template>
	<div ref="root" class="cache-race">
		<div class="cr-row">
			<span class="cr-label">first run</span>
			<div class="cr-track">
				<div class="cr-bar cr-cold" :class="{ go: started }" :style="{ transitionDuration: `${COLD_MS}ms` }" />
			</div>
			<span class="cr-time" :class="{ show: coldDone }">12.4s</span>
		</div>
		<div class="cr-row">
			<span class="cr-label">second run</span>
			<div class="cr-track">
				<div class="cr-bar cr-hit" :class="{ go: started }" :style="{ transitionDuration: `${HIT_MS}ms` }" />
			</div>
			<span class="cr-time cr-hit-time" :class="{ show: hitDone }">0.03s <span class="cr-badge">CACHE HIT</span></span>
		</div>
	</div>
</template>

<style scoped>
.cache-race {
	margin: 24px 0;
	padding: 20px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 12px;
	background: var(--vp-c-bg-soft);
	font-family: var(--vp-font-family-mono);
	font-size: 13px;
	display: grid;
	gap: 14px;
}

.cr-row {
	display: grid;
	grid-template-columns: 92px 1fr 150px;
	align-items: center;
	gap: 12px;
}

.cr-label {
	color: var(--vp-c-text-2);
}

.cr-track {
	height: 10px;
	border-radius: 5px;
	background: var(--vp-c-bg);
	border: 1px solid var(--vp-c-divider);
	overflow: hidden;
}

.cr-bar {
	height: 100%;
	width: 0%;
	transition-property: width;
	transition-timing-function: ease-out;
}

.cr-bar.go {
	width: 100%;
}

.cr-cold {
	background: linear-gradient(90deg, var(--vp-c-brand-3), var(--vp-c-brand-1));
}

.cr-hit {
	background: #71d58a;
}

.cr-time {
	opacity: 0;
	transition: opacity 0.25s;
	color: var(--vp-c-text-1);
}

.cr-time.show {
	opacity: 1;
}

.cr-badge {
	display: inline-block;
	margin-left: 6px;
	padding: 1px 7px;
	border-radius: 999px;
	font-size: 10.5px;
	font-weight: 700;
	letter-spacing: 0.04em;
	color: #0f0e0d;
	background: #71d58a;
}

@media (prefers-reduced-motion: reduce) {
	.cr-bar,
	.cr-time {
		transition: none;
	}
}
</style>
