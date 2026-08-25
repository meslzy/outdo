/** Exit codes, per clig.dev conventions. */
export const EXIT = {
	ok: 0,
	taskFailure: 1,
	usage: 2,
	config: 3,
	interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type BundoErrorCode =
	| "usage"
	| "config-not-found"
	| "config-invalid"
	| "unknown-task"
	| "cycle"
	| "env-invalid"
	| "task-failed"
	| "interrupted";

const EXIT_BY_CODE: Record<BundoErrorCode, ExitCode> = {
	usage: EXIT.usage,
	"config-not-found": EXIT.config,
	"config-invalid": EXIT.config,
	"unknown-task": EXIT.usage,
	cycle: EXIT.config,
	"env-invalid": EXIT.config,
	"task-failed": EXIT.taskFailure,
	interrupted: EXIT.interrupted,
};

/** An error with a stable machine-readable code and a mapped exit code. */
export class BundoError extends Error {
	readonly code: BundoErrorCode;
	readonly exitCode: ExitCode;
	/** Extra machine-readable payload for `--json` error output. */
	readonly detail: unknown;

	constructor(code: BundoErrorCode, message: string, detail?: unknown) {
		super(message);
		this.name = "BundoError";
		this.code = code;
		this.exitCode = EXIT_BY_CODE[code];
		this.detail = detail;
	}
}
