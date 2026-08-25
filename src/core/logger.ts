/**
 * ANSI color helper. Zero dependencies.
 *
 * Resolution order (first match wins):
 *   --color=always/never > FORCE_COLOR > NO_COLOR > TERM=dumb > isatty
 * per https://no-color.org and https://force-color.org.
 */

export type ColorMode = "auto" | "always" | "never";

let colorEnabled = resolveColor("auto");

export function resolveColor(mode: ColorMode): boolean {
	if (mode === "always") {
		return true;
	}
	if (mode === "never") {
		return false;
	}
	const env = process.env;
	if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false") {
		return true;
	}
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
		return false;
	}
	if (env.TERM === "dumb") {
		return false;
	}
	return process.stdout.isTTY === true;
}

export function setColorMode(mode: ColorMode): void {
	colorEnabled = resolveColor(mode);
}

export function colorsEnabled(): boolean {
	return colorEnabled;
}

function style(open: number, close: number): (text: string) => string {
	return (text) => (colorEnabled ? `\x1b[${open}m${text}\x1b[${close}m` : text);
}

export const bold = style(1, 22);
export const dim = style(2, 22);
export const italic = style(3, 23);
export const red = style(31, 39);
export const green = style(32, 39);
export const yellow = style(33, 39);
export const blue = style(34, 39);
export const magenta = style(35, 39);
export const cyan = style(36, 39);
export const gray = style(90, 39);

/** Stable per-name prefix colors for multiplexed output. */
const PREFIX_STYLES = [
	cyan,
	magenta,
	green,
	yellow,
	blue,
] as const;

export function prefixColor(name: string): (text: string) => string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = (hash * 31 + name.charCodeAt(i)) | 0;
	}
	const idx = Math.abs(hash) % PREFIX_STYLES.length;
	return PREFIX_STYLES[idx] as (text: string) => string;
}

/** Debug logging, gated by BUNDO_LOG=debug. stderr only. */
export function debugLog(...args: unknown[]): void {
	if (process.env.BUNDO_LOG === "debug") {
		console.error(dim("[bundo:debug]"), ...args);
	}
}
