/**
 * Run guards checked once per plan, before anything starts:
 * - OUTDO_READONLY=1 refuses any task with a body that is not `readonly`
 *   (for unattended agent loops);
 * - `protect` / `confirm` ask before running (all questions first, then the
 *   run), `--yes` answers for you, and with no terminal outdo refuses.
 */

import { OutdoError } from "~/core/errors";
import { hasBody } from "~/core/executor";
import { dim, yellow } from "~/core/logger";
import type { Task } from "~/core/model";

const FALSY = new Set([
	"",
	"0",
	"false",
	"no",
]);

export function readonlyMode(env: Record<string, string | undefined> = process.env): boolean {
	const value = env.OUTDO_READONLY;
	return value !== undefined && !FALSY.has(value.toLowerCase());
}

export function assertReadonlyAllowed(planned: readonly Task[]): void {
	if (!readonlyMode()) {
		return;
	}
	const refused = planned.filter((task) => hasBody(task) && !task.readonly).map((task) => task.name);
	if (refused.length > 0) {
		throw new OutdoError(
			"refused",
			`OUTDO_READONLY is set: refusing ${refused.map((n) => `"${n}"`).join(", ")} (not marked readonly: true).`,
			{
				refused,
			},
		);
	}
}

/** The question a task asks before running in `mode`, if any. */
export function confirmQuestion(task: Task, mode: string): string | undefined {
	if (task.confirm !== undefined) {
		return task.confirm;
	}
	if (task.protect.includes("*")) {
		return `Run "${task.name}"?`;
	}
	if (mode !== "" && task.protect.includes(mode)) {
		return `Run "${task.name}" in ${mode} mode?`;
	}
	return undefined;
}

/** Whether stdin can answer a question (OUTDO_ASSUME_TTY lets tests pipe answers). */
function canAsk(): boolean {
	return process.stdin.isTTY === true || process.env.OUTDO_ASSUME_TTY === "1";
}

export function confirmPlan(planned: readonly Task[], mode: string, yes: boolean): void {
	const questions = planned
		.map((task) => ({
			task,
			question: confirmQuestion(task, mode),
		}))
		.filter(
			(
				q,
			): q is {
				task: Task;
				question: string;
			} => q.question !== undefined,
		);
	if (questions.length === 0) {
		return;
	}
	if (yes) {
		console.error(dim(`--yes: confirmed ${questions.map((q) => q.task.name).join(", ")}`));
		return;
	}
	if (!canAsk()) {
		const names = questions.map((q) => `"${q.task.name}"`).join(", ");
		throw new OutdoError(
			"refused",
			`${names} ${questions.length === 1 ? "asks" : "ask"} for confirmation and there is no terminal to ask in. Re-run with --yes to confirm.`,
			{
				tasks: questions.map((q) => q.task.name),
			},
		);
	}
	for (const { question } of questions) {
		if (!confirm(`${yellow("?")} ${question}`)) {
			throw new OutdoError("refused", "Not confirmed — nothing was run.");
		}
	}
}
