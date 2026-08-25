/** Levenshtein distance — small inputs only (task/flag names). */
export function levenshtein(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	const m = a.length;
	const n = b.length;
	if (m === 0) {
		return n;
	}
	if (n === 0) {
		return m;
	}
	let prev = Array.from(
		{
			length: n + 1,
		},
		(_, i) => i,
	);
	let curr = new Array<number>(n + 1).fill(0);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min((curr[j - 1] as number) + 1, (prev[j] as number) + 1, (prev[j - 1] as number) + cost);
		}
		[prev, curr] = [
			curr,
			prev,
		];
	}
	return prev[n] as number;
}

/** Closest candidate within a sane edit distance, for "did you mean" hints. */
export function didYouMean(input: string, candidates: readonly string[]): string | undefined {
	let best: string | undefined;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		const dist = levenshtein(input, candidate);
		if (dist < bestDist) {
			bestDist = dist;
			best = candidate;
		}
	}
	const threshold = Math.max(2, Math.floor(input.length / 3));
	return bestDist <= threshold ? best : undefined;
}

/** Compare strings for stable, locale-independent sorting. */
export function byName(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
