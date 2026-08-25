<script setup lang="ts">
defineProps<{
	/** The ctx field name shown as inline code. */
	name: string;
	/** Its TypeScript type. */
	type: string;
	/** One-line description shown in the hover card. */
	info: string;
}>();
</script>

<template>
	<span class="ctx-card" tabindex="0">
		<code class="ctx-name">{{ name }}</code>
		<span class="ctx-pop" role="tooltip">
			<code class="ctx-type">{{ type }}</code>
			<span class="ctx-info">{{ info }}</span>
		</span>
	</span>
</template>

<style scoped>
.ctx-card {
	position: relative;
	display: inline-block;
}

.ctx-name {
	border-bottom: 1px dashed var(--vp-c-brand-1);
	cursor: help;
}

.ctx-pop {
	position: absolute;
	bottom: calc(100% + 8px);
	left: 50%;
	transform: translateX(-50%) translateY(4px);
	z-index: 30;
	display: grid;
	gap: 4px;
	min-width: 230px;
	max-width: 320px;
	padding: 10px 12px;
	border-radius: 8px;
	border: 1px solid var(--vp-c-divider);
	background: var(--vp-c-bg-elv);
	box-shadow: 0 8px 30px -10px rgba(0, 0, 0, 0.45);
	opacity: 0;
	visibility: hidden;
	transition:
		opacity 0.18s,
		transform 0.18s,
		visibility 0.18s;
	pointer-events: none;
}

.ctx-card:hover .ctx-pop,
.ctx-card:focus-visible .ctx-pop,
.ctx-card:focus-within .ctx-pop {
	opacity: 1;
	visibility: visible;
	transform: translateX(-50%) translateY(0);
}

.ctx-type {
	font-size: 12px;
	color: var(--vp-c-brand-1);
	background: transparent;
	padding: 0;
}

.ctx-info {
	font-size: 12.5px;
	line-height: 1.5;
	color: var(--vp-c-text-2);
	font-family: var(--vp-font-family-base);
	white-space: normal;
}

@media (prefers-reduced-motion: reduce) {
	.ctx-pop {
		transition: none;
	}
}
</style>
