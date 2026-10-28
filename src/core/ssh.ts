/**
 * `ctx.ssh`: a `$`-like tagged template that runs one command on a remote host
 * through the system `ssh` client. Interpolations are POSIX-shell escaped
 * (arrays become several words, `{ raw }` is inserted verbatim), output
 * streams line by line with a `label |` prefix and is also returned.
 * `OUTDO_SSH` overrides the ssh binary — a path, or a JSON array of argv
 * (tests use `["bun", "fake-ssh.ts"]`).
 */

import type { RemoteResult, RemoteShell, Ssh } from "~/types";

const SAFE = /^[A-Za-z0-9_\-.,:/@%+=]+$/;

/** Quote one word for a POSIX shell. */
export function shellQuote(word: string): string {
	if (word !== "" && SAFE.test(word)) {
		return word;
	}
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Like shellQuote, but a leading `~/` keeps expanding to the remote home. */
function quotePath(path: string): string {
	if (path === "~") {
		return `"$HOME"`;
	}
	if (path.startsWith("~/")) {
		return `"$HOME"/${shellQuote(path.slice(2))}`;
	}
	return shellQuote(path);
}

function render(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map((item) => render(item)).join(" ");
	}
	if (typeof value === "object" && value !== null && "raw" in value && typeof value.raw === "string") {
		return value.raw;
	}
	return shellQuote(String(value));
}

export function buildRemoteCommand(
	strings: TemplateStringsArray | readonly string[],
	values: readonly unknown[],
): string {
	let out = strings[0] ?? "";
	for (let i = 0; i < values.length; i++) {
		out += render(values[i]) + (strings[i + 1] ?? "");
	}
	return out.trim();
}

interface RemoteConfig {
	target: string;
	label: string;
	args: readonly string[];
	cwd: string | undefined;
	nothrow: boolean;
	quiet: boolean;
}

async function pump(
	stream: ReadableStream<Uint8Array>,
	prefix: string,
	write: ((text: string) => void) | undefined,
): Promise<string> {
	const decoder = new TextDecoder();
	let all = "";
	let tail = "";
	for await (const chunk of stream) {
		const text = decoder.decode(chunk, {
			stream: true,
		});
		all += text;
		const lines = (tail + text).split("\n");
		tail = lines.pop() ?? "";
		for (const line of lines) {
			write?.(`${prefix}${line.endsWith("\r") ? line.slice(0, -1) : line}\n`);
		}
	}
	const rest = tail + decoder.decode();
	all += decoder.decode();
	if (rest !== "") {
		write?.(`${prefix}${rest}\n`);
	}
	return all;
}

function sshCommand(override: string | undefined): string[] {
	if (override === undefined || override === "") {
		return [
			"ssh",
		];
	}
	return override.startsWith("[")
		? (JSON.parse(override) as string[])
		: [
				override,
			];
}

function remote(cfg: RemoteConfig, env: Record<string, string | undefined>, signal: AbortSignal): RemoteShell {
	const run = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<RemoteResult> => {
		const command = buildRemoteCommand(strings, values);
		const full = cfg.cwd === undefined ? command : `cd ${quotePath(cfg.cwd)} && ${command}`;
		const clean: Record<string, string> = {};
		for (const [key, value] of Object.entries(env)) {
			if (value !== undefined) {
				clean[key] = value;
			}
		}
		const proc = Bun.spawn(
			[
				...sshCommand(env.OUTDO_SSH),
				...cfg.args,
				cfg.target,
				full,
			],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: clean,
			},
		);
		const onAbort = (): void => proc.kill();
		signal.addEventListener("abort", onAbort, {
			once: true,
		});
		const prefix = `${cfg.label} | `;
		const [stdout, stderr, exitCode] = await Promise.all([
			pump(proc.stdout, prefix, cfg.quiet ? undefined : (text) => process.stdout.write(text)),
			pump(proc.stderr, prefix, cfg.quiet ? undefined : (text) => process.stderr.write(text)),
			proc.exited,
		]);
		signal.removeEventListener("abort", onAbort);
		if (exitCode !== 0 && !cfg.nothrow) {
			throw new Error(`ssh ${cfg.target}: \`${command}\` exited with code ${exitCode}`);
		}
		return {
			exitCode,
			stdout,
			stderr,
		};
	};
	const shell = run as RemoteShell;
	shell.cwd = (dir) =>
		remote(
			{
				...cfg,
				cwd: dir,
			},
			env,
			signal,
		);
	shell.nothrow = () =>
		remote(
			{
				...cfg,
				nothrow: true,
			},
			env,
			signal,
		);
	shell.quiet = () =>
		remote(
			{
				...cfg,
				quiet: true,
			},
			env,
			signal,
		);
	return shell;
}

export function makeSsh(env: Record<string, string | undefined>, signal: AbortSignal): Ssh {
	return (target, options = {}) =>
		remote(
			{
				target,
				label: options.label ?? target.replace(/^.*@/, ""),
				args: options.args ?? [],
				cwd: undefined,
				nothrow: false,
				quiet: false,
			},
			env,
			signal,
		);
}
