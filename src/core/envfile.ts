/**
 * .env file parser matching Bun's loader semantics exactly: `$VAR`/`${VAR}`
 * expansion applies in unquoted, double- AND single-quoted values (verified
 * against Bun 1.4.0); `/**
 escapes. node:util.parseEnv does not expand,
 * which is why we parse ourselves.
 */

export interface EnvFileEntry {
	value: string;
	line: number;
}

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parse one .env file's text into raw (unexpanded) entries. */
export function parseEnvFile(text: string): Map<string, EnvFileEntry> {
	const entries = new Map<string, EnvFileEntry>();
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) {
			continue;
		}
		const match = LINE_RE.exec(line);
		if (!match) {
			continue;
		}
		const key = match[1] as string;
		let raw = (match[2] as string).trim();
		if (raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`")) {
			const quote = raw[0] as string;
			// Multi-line quoted values: consume until the closing quote.
			while (!closesQuote(raw, quote) && i + 1 < lines.length) {
				i++;
				raw += `\n${lines[i]}`;
			}
			if (closesQuote(raw, quote)) {
				raw = raw.slice(1, raw.lastIndexOf(quote));
				entries.set(key, {
					value: quote === '"' ? unescapeDouble(raw) : raw,
					line: i + 1,
				});
				continue;
			}
			// Unterminated quote — treat literally.
		}
		const hash = findUnquotedHash(raw);
		if (hash !== -1) {
			raw = raw.slice(0, hash).trimEnd();
		}
		entries.set(key, {
			value: raw,
			line: i + 1,
		});
	}
	return entries;
}

function closesQuote(raw: string, quote: string): boolean {
	return raw.length > 1 && raw.lastIndexOf(quote) > 0;
}

function unescapeDouble(value: string): string {
	return value.replaceAll("\\n", "\n").replaceAll("\\t", "\t").replaceAll('\\"', '"');
}

function findUnquotedHash(raw: string): number {
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) {
			return i;
		}
	}
	return -1;
}

/**
 * Expand `$VAR` / `${VAR}` in a value. Single-quoted values must be passed
 * through without calling this (the caller tracks quoting). `\$` escapes.
 */
export function expandValue(value: string, lookup: (name: string) => string | undefined): string {
	return value.replace(/\\\$|\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (whole, braced, bare) => {
		if (whole === "\\$") {
			return "$";
		}
		return lookup((braced ?? bare) as string) ?? "";
	});
}
