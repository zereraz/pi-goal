/**
 * pi-goal — Persistent goal pursuit for pi.
 *
 * Model: simple FIFO queue. One goal active at a time. New goals queue.
 *
 * Commands:
 * - /goal <objective>                 set or queue a goal
 * - /goal --replace <objective>      abandon active, set new one immediately
 * - /goal --queue <objective>        explicit queue (same as /goal X with active)
 * - /goal next | /goal skip          abandon active, promote next queued
 * - /goal complete                   user marks active complete, promote next
 * - /goal pause | /goal resume       suspend / wake the active goal
 * - /goal continue                   re-enable continuation nudges after Esc/errors
 * - /goal clear                      wipe everything
 * - /goal                            open status menu
 *
 * Steering rules (Codex-aligned):
 * - User input does NOT suspend the goal. Messages typed while a goal is
 *   active are steering WITHIN the goal; after the agent answers, the
 *   continuation loop resumes (Codex: continue_if_idle on every thread idle).
 * - System prompt injection happens ONLY on continuation turns. User turns get
 *   a clean system prompt — agent answers what user actually asked.
 * - First continuation after /goal is delivered immediately (queueMicrotask).
 *   Subsequent continuations debounce 2s after agent_end.
 * - Esc / abort does NOT stop the goal (Codex: abort only accounts progress).
 *   The loop resumes after a 5s grace window — time to type steering or
 *   /goal pause. Stopping is explicit: /goal pause / /goal clear.
 * - Turn errors retry with a 10s backoff; after 3 consecutive errors the loop
 *   suspends loudly instead of silently (and instead of error-looping).
 * - Token accounting uses per-turn output tokens charged to the goal active at
 *   turn_start (so promotion mid-turn doesn't bleed cost into the next goal).
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	formatElapsed,
	formatTokens,
	goalStatusLabel,
	buildContinuationPrompt,
	findActive,
	findNextQueued,
	queueDepth,
	newGoalId,
} from "./helpers.ts";
import type { Goal, GoalStatus } from "./helpers.ts";

interface GoalEntry {
	action: "add" | "update" | "activate" | "complete" | "abandon" | "clear";
	goals: Goal[];
}

// Timings are env-overridable so lifecycle tests can run fast.
const CONTINUATION_DEBOUNCE_MS = Number(process.env.PI_GOAL_DEBOUNCE_MS ?? 2000);
/** Longer delay before retrying after a turn error (throttle/transient). */
const ERROR_RETRY_DELAY_MS = Number(process.env.PI_GOAL_ERROR_RETRY_MS ?? 10_000);
/** Grace period after Esc before the goal loop resumes — long enough to
 * type a steering message or /goal pause. */
const ABORT_RESUME_DELAY_MS = Number(process.env.PI_GOAL_ABORT_RESUME_MS ?? 5_000);
/** Consecutive turn errors tolerated before the loop suspends. */
const MAX_CONSECUTIVE_ERRORS = 3;
const CONTINUATION_CUSTOM_TYPE = "pi-goal:continuation";

// ============================================================================
// Status menu
// ============================================================================

type MenuAction =
	| "pause"
	| "resume"
	| "complete"
	| "next"
	| "continue"
	| "clear"
	| "close";

class GoalSummaryComponent implements Component {
	private goals: Goal[];
	private active: Goal | null;
	private theme: Theme;
	private suspended: boolean;
	private onAction: (action: MenuAction) => void;
	private selectedIndex = 0;
	private actions: Array<{ label: string; key: MenuAction }>;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		goals: Goal[],
		suspended: boolean,
		theme: Theme,
		onAction: (action: MenuAction) => void,
	) {
		this.goals = goals;
		this.active = findActive(goals);
		this.theme = theme;
		this.suspended = suspended;
		this.onAction = onAction;

		this.actions = [];
		const a = this.active;
		const next = findNextQueued(goals);
		if (a) {
			if (a.status === "active") {
				this.actions.push({ label: "⏸  Pause active goal", key: "pause" });
				this.actions.push({ label: "✅ Mark active complete", key: "complete" });
				this.actions.push({ label: "⏭  Skip to next queued", key: "next" });
			}
		} else if (next) {
			this.actions.push({ label: "▶  Activate next queued", key: "resume" });
		}
		const pausedExists = goals.some((g) => g.status === "paused");
		if (!a && pausedExists) {
			this.actions.push({ label: "▶  Resume paused goal", key: "resume" });
		}
		if (suspended && a) {
			this.actions.push({
				label: "🔔 Re-enable continuation nudges",
				key: "continue",
			});
		}
		this.actions.push({ label: "🗑  Clear all goals", key: "clear" });
		this.actions.push({ label: "   Close", key: "close" });
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onAction("close");
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
			this.selectedIndex = Math.min(
				this.actions.length - 1,
				this.selectedIndex + 1,
			);
			this.invalidate();
			return;
		}
		if (matchesKey(data, "return")) {
			const action = this.actions[this.selectedIndex];
			if (action) this.onAction(action.key);
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [];

		lines.push("");
		const title = th.fg("accent", ` Goals (${this.goals.length}) `);
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) +
			title +
			th.fg(
				"borderMuted",
				"─".repeat(Math.max(0, width - 10 - String(this.goals.length).length)),
			);
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.suspended) {
			lines.push(
				truncateToWidth(
					`  ${th.fg("warning", "⏸  Continuations suspended (user steered away)")}`,
					width,
				),
			);
			lines.push("");
		}

		for (const g of this.goals) {
			const marker = g === this.active ? th.fg("accent", "●") : th.fg("muted", "○");
			lines.push(
				truncateToWidth(
					`  ${marker} ${goalStatusLabel(g.status)}  ${g.objective}`,
					width,
				),
			);
			const meta: string[] = [];
			meta.push(`time ${formatElapsed(g.timeUsedMs)}`);
			if (g.tokensUsed > 0) {
				meta.push(`tokens ${formatTokens(g.tokensUsed)}`);
			}
			lines.push(truncateToWidth(`      ${th.fg("muted", meta.join(" · "))}`, width));
		}

		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`,
				width,
			),
		);
		lines.push("");
		for (let i = 0; i < this.actions.length; i++) {
			const action = this.actions[i];
			const prefix = i === this.selectedIndex ? th.fg("accent", "▸ ") : "  ";
			const label =
				i === this.selectedIndex
					? th.fg("text", action.label)
					: th.fg("muted", action.label);
			lines.push(truncateToWidth(`  ${prefix}${label}`, width));
		}
		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${th.fg("dim", "↑↓ navigate • Enter select • Esc close")}`,
				width,
			),
		);
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ============================================================================
// Extension
// ============================================================================

export default function piGoalExtension(pi: ExtensionAPI) {
	let goals: Goal[] = [];

	// ── Steering state ──────────────────────────────────────────────────
	/**
	 * True for the lifetime of an agent invocation that we triggered with a
	 * continuation message. Set when sendMessage(continuation) fires, cleared
	 * at agent_end. Used by before_agent_start (every LLM call inside the
	 * invocation should keep injecting goal context) and by agent_end (only
	 * nudge again if THIS invocation was goal-driven).
	 */
	let goalDrivenInvocation = false;
	/** True only after an explicit stop signal (Esc) or repeated errors —
	 * continuations stay paused until /goal continue. Plain user input does
	 * NOT suspend (Codex semantics: steering is fuel, not departure). */
	let userSuspended = false;
	/** Consecutive goal turns that ended in error — reset on any clean turn. */
	let consecutiveErrors = 0;
	/** Number of goal continuation messages we've queued via pi.sendMessage but
	 * whose triggered invocation hasn't yet started. Consumed (decremented) in
	 * before_agent_start so that goalDrivenInvocation is set on the right
	 * invocation, even when the continuation was queued while another (non-goal)
	 * invocation was still in flight. Without this counter the in-flight
	 * invocation's agent_end would prematurely consume + reset the flag, and the
	 * goal's first turn would lose the system-prompt goal augmentation. */
	let pendingGoalContinuations = 0;
	/** Number of consecutive continuations without external input. */
	let consecutiveContinuations = 0;

	// ── Per-turn accounting ─────────────────────────────────────────────
	let turnStartedAt: number | null = null;
	/** Goal id that was active when the turn started — charge cost to this id
	 * even if the active goal changes mid-turn (e.g. agent calls update_goal). */
	let turnGoalId: string | null = null;

	let continuationTimer: ReturnType<typeof setTimeout> | null = null;
	/** 1Hz ticker so the footer's elapsed counter actually advances during a
	 * long-running turn (otherwise we'd display the persisted timeUsedMs which
	 * only updates on turn_end — the "0s active bug"). */
	let footerTicker: ReturnType<typeof setInterval> | null = null;
	let footerCtx: ExtensionContext | null = null;

	function startFooterTicker() {
		if (footerTicker || !footerCtx) return;
		footerTicker = setInterval(() => {
			if (!footerCtx) return;
			updateFooterStatus(footerCtx);
		}, 1000);
	}
	function stopFooterTicker() {
		if (footerTicker) {
			clearInterval(footerTicker);
			footerTicker = null;
		}
	}

	// ── Helpers ─────────────────────────────────────────────────────────

	const active = (): Goal | null => findActive(goals);

	function clearContinuationTimer() {
		if (continuationTimer) {
			clearTimeout(continuationTimer);
			continuationTimer = null;
		}
	}

	function persistGoal(action: GoalEntry["action"]) {
		pi.appendEntry<GoalEntry>("pi-goal", {
			action,
			goals: goals.map((g) => ({ ...g })),
		});
		syncGoalTools();
	}

	const GOAL_TOOL_NAMES = ["get_goal", "update_goal"];
	function syncGoalTools() {
		const want = !!active();
		const current = new Set(pi.getActiveTools());
		let changed = false;
		for (const name of GOAL_TOOL_NAMES) {
			if (want && !current.has(name)) {
				current.add(name);
				changed = true;
			} else if (!want && current.has(name)) {
				current.delete(name);
				changed = true;
			}
		}
		if (changed) pi.setActiveTools(Array.from(current));
	}

	// ── State reconstruction ────────────────────────────────────────────

	function reconstructState(ctx: ExtensionContext) {
		goals = [];
		turnStartedAt = null;
		turnGoalId = null;
		goalDrivenInvocation = false;
		pendingGoalContinuations = 0;
		userSuspended = false;
		consecutiveErrors = 0;
		consecutiveContinuations = 0;
		clearContinuationTimer();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "pi-goal") continue;
			const data = entry.data as GoalEntry | undefined;
			if (!data) continue;
			// Migrate legacy snapshots: drop removed fields (`dependencies`,
			// `tokenBudget`) and map the removed `budget_limited` status — now an
			// invalid state — onto `paused` so old sessions still reconstruct and
			// the queue can still be advanced/resumed.
			goals = data.goals.map((g) => {
				const { ...rest } = g as Goal & {
					dependencies?: unknown;
					tokenBudget?: unknown;
				};
				delete (rest as { dependencies?: unknown }).dependencies;
				delete (rest as { tokenBudget?: unknown }).tokenBudget;
				if ((rest.status as string) === "budget_limited") {
					rest.status = "paused";
				}
				return rest;
			});
		}

		updateFooterStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		syncGoalTools();
		// Don't auto-fire on session_start — wait for actual activity.
	});

	pi.on("session_tree", async (_event, ctx) => {
		// Just rebuild state. Don't reschedule continuations from tree navigation.
		reconstructState(ctx);
		syncGoalTools();
	});

	// ── Continuation scheduling ─────────────────────────────────────────

	/** Send the continuation message NOW (zero delay). Used for fresh activation. */
	function sendContinuationImmediate(_ctx: ExtensionContext) {
		const a = active();
		if (!a) return;
		if (userSuspended) return;
		clearContinuationTimer();
		const isFirst = consecutiveContinuations === 0;
		queueMicrotask(() => {
			const a2 = active();
			if (!a2) return;
			if (userSuspended) return;
			// Don't set goalDrivenInvocation here — the in-flight (non-goal)
			// invocation's agent_end would consume + reset it before our
			// followUp turn even starts. Use the counter instead; it's drained
			// in before_agent_start of the actual goal turn.
			pendingGoalContinuations += 1;
			pi.sendMessage(
				{
					customType: CONTINUATION_CUSTOM_TYPE,
					content: buildContinuationPrompt(a2, isFirst),
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		});
	}

	/** Debounced re-prompt after the agent finishes a turn. */
	function scheduleContinuationDebounced(
		ctx: ExtensionContext,
		delayMs: number = CONTINUATION_DEBOUNCE_MS,
	) {
		clearContinuationTimer();
		if (userSuspended) return;
		const a = active();
		if (!a) return;
		// DO NOT gate on ctx.isIdle() here: agent_end is emitted INSIDE the run
		// lifecycle, before isStreaming flips false (pi-agent-core finishRun runs
		// after event processing). Gating at schedule time made this check fail
		// on EVERY agent_end — the debounced continuation never fired once and
		// the goal loop was structurally dead after the first turn. Check idle
		// state at FIRE time instead, when the run has actually finished.

		const goalId = a.id;
		continuationTimer = setTimeout(() => {
			continuationTimer = null;
			const a2 = active();
			if (!a2 || a2.id !== goalId) return;
			if (userSuspended) return;
			try {
				// If a newer turn is in flight or messages are queued, skip — that
				// turn's own agent_end will reschedule us.
				if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			} catch {
				return; // ctx no longer valid (reload/shutdown)
			}
			pendingGoalContinuations += 1;
			pi.sendMessage(
				{
					customType: CONTINUATION_CUSTOM_TYPE,
					content: buildContinuationPrompt(a2, /*isFirst*/ false),
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}, delayMs);
	}

	// ── Turn lifecycle ──────────────────────────────────────────────────

	pi.on("turn_start", async (_event, ctx) => {
		if (goalDrivenInvocation) {
			consecutiveContinuations += 1;
		} else {
			consecutiveContinuations = 0;
		}

		const a = active();
		if (a) {
			turnStartedAt = Date.now();
			turnGoalId = a.id;
			// Refresh footer + start the 1Hz ticker so the elapsed counter
			// advances visibly during this turn (fixes "0s active" bug).
			updateFooterStatus(ctx);
		} else {
			turnStartedAt = null;
			turnGoalId = null;
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (turnStartedAt === null || turnGoalId === null) return;

		const charged = goals.find((g) => g.id === turnGoalId);
		const elapsed = Date.now() - turnStartedAt;
		turnStartedAt = null;
		turnGoalId = null;

		if (!charged) return; // goal was cleared mid-turn

		charged.timeUsedMs += elapsed;
		charged.updatedAt = Date.now();

		// Token accounting: per-turn delta. Use output tokens (the cost we
		// actually generated this turn). Falls back to non-cached input + output.
		const usage = (event.message as any)?.usage;
		let turnTokens = 0;
		if (usage) {
			if (typeof usage.output === "number") {
				turnTokens = usage.output + (usage.reasoning ?? 0);
			} else if (typeof usage.totalTokens === "number") {
				// Older shape — best-effort: subtract cached read.
				turnTokens =
					usage.totalTokens - (usage.cacheRead ?? 0) - (usage.input ?? 0);
				if (turnTokens < 0) turnTokens = usage.output ?? 0;
			}
		}
		if (turnTokens <= 0) turnTokens = 100; // tiny fallback so something accrues
		charged.tokensUsed += turnTokens;

		persistGoal("update");
		updateFooterStatus(ctx);
	});

	// ── agent_end: decide whether to continue ───────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		updateFooterStatus(ctx);
		// Reset the per-invocation flag now that the invocation is fully done.
		goalDrivenInvocation = false;

		const a = active();
		if (!a) return;

		const messages = event.messages ?? [];
		let lastAssistantStop: string | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as { role?: string; stopReason?: string };
			if (m && m.role === "assistant") {
				lastAssistantStop = m.stopReason;
				break;
			}
		}

		// Esc (abort) does NOT suspend — Codex semantics: turn abort only
		// accounts progress; the goal continues on next idle. The common pattern
		// is Esc → type steering → expect the loop to keep going. We resume
		// after a longer grace delay so the user has time to type (their input
		// clears the timer, and their turn's agent_end reschedules) or to
		// /goal pause if they actually want to stop.
		if (lastAssistantStop === "aborted") {
			ctx.ui.notify(
				`Interrupted — goal still active, resuming in ${ABORT_RESUME_DELAY_MS / 1000}s. Use /goal pause to stop.`,
				"info",
			);
			scheduleContinuationDebounced(ctx, ABORT_RESUME_DELAY_MS);
			return;
		}

		// Turn error (throttle, network, provider). Don't die silently on the
		// first one — retry with a longer delay. Only suspend (loudly) after
		// several consecutive failures, to avoid an error loop burning tokens
		// (Codex blocks the goal on turn error for the same reason).
		if (lastAssistantStop === "error") {
			consecutiveErrors += 1;
			if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
				userSuspended = true;
				clearContinuationTimer();
				ctx.ui.notify(
					`Goal suspended after ${consecutiveErrors} consecutive errors. Use /goal continue to resume.`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Goal turn errored (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}) — retrying in ${ERROR_RETRY_DELAY_MS / 1000}s`,
				"info",
			);
			scheduleContinuationDebounced(ctx, ERROR_RETRY_DELAY_MS);
			return;
		}

		// Clean turn — reset the error streak.
		consecutiveErrors = 0;

		// Continue after ANY clean turn while a goal is active — including
		// user-driven ones. User messages are steering within the goal, not a
		// departure from it (Codex: continue_if_idle fires on every thread
		// idle). The agent answers the user, then the goal loop resumes with
		// that steering absorbed as context.
		if (userSuspended) return;
		if (ctx.hasPendingMessages()) return;

		scheduleContinuationDebounced(ctx);
	});

	// ── User input ───────────────────────────────────────────────────────

	pi.on("input", async (_event, _ctx) => {
		// User typed something — clear any pending nudge so it doesn't race
		// their turn. Do NOT suspend: the continuation reschedules at agent_end
		// once their turn completes (steering is fuel, not departure).
		clearContinuationTimer();
	});

	// ── System prompt injection — only on continuation turns ────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		// Drain a pending goal continuation onto THIS invocation. Done here
		// (rather than synchronously when we call sendMessage) so the flag
		// lands on the actual goal turn, not on whatever invocation happened
		// to be in flight when /goal was issued.
		if (pendingGoalContinuations > 0) {
			pendingGoalContinuations -= 1;
			goalDrivenInvocation = true;
		}

		const a = active();
		if (!a) return;
		// Inject goal context only on goal-driven invocations. User invocations
		// (asking unrelated questions while a goal is set) get a clean prompt.
		if (!goalDrivenInvocation) return;

		const lines = [
			"",
			"## Active Goal",
			`Objective: ${a.objective}`,
			`Status: ${a.status}`,
		];
		const qd = queueDepth(goals);
		if (qd > 0) lines.push(`${qd} goal(s) queued behind this one.`);
		lines.push("");
		lines.push(
			"Use update_goal with status \"complete\" only when the objective is fully achieved.",
		);

		return { systemPrompt: event.systemPrompt + lines.join("\n") };
	});

	// ── Footer status ───────────────────────────────────────────────────

	function updateFooterStatus(ctx: ExtensionContext) {
		footerCtx = ctx; // remember latest ctx so the ticker can refresh
		const a = active();
		if (!a && goals.every((g) => g.status === "complete" || g.status === "abandoned")) {
			ctx.ui.setStatus("goal", undefined);
			stopFooterTicker();
			return;
		}
		const qd = queueDepth(goals);
		const suffix = qd > 0 ? ` [+${qd} queued]` : "";
		const susp = userSuspended ? " (suspended)" : "";
		if (!a) {
			ctx.ui.setStatus("goal", `Goals idle${suffix}`);
			stopFooterTicker();
			return;
		}
		// Live elapsed: persisted time + wall-clock of any in-flight turn that
		// is being charged to THIS goal. Without this, the footer reads "0s"
		// for the entire duration of a long turn (e.g. multi-minute bench/train
		// turns on RTX rigs) because timeUsedMs only updates on turn_end.
		const inFlightMs =
			turnStartedAt !== null && turnGoalId === a.id
				? Math.max(0, Date.now() - turnStartedAt)
				: 0;
		const liveMs = a.timeUsedMs + inFlightMs;
		const elapsed = formatElapsed(liveMs);
		// Run the 1Hz ticker only while a turn is actually in flight on the
		// active goal — outside a turn the displayed elapsed is constant.
		if (a.status === "active" && inFlightMs > 0) startFooterTicker();
		else stopFooterTicker();

		switch (a.status) {
			case "active":
				ctx.ui.setStatus("goal", `Goal active (${elapsed})${suffix}${susp}`);
				break;
			case "paused":
				ctx.ui.setStatus("goal", `Goal paused${suffix}`);
				break;
			case "complete":
				ctx.ui.setStatus("goal", `Goal complete${suffix}`);
				break;
			case "abandoned":
				ctx.ui.setStatus("goal", `Goal abandoned${suffix}`);
				break;
			case "queued":
				ctx.ui.setStatus("goal", `Goal queued${suffix}`);
				break;
		}
	}

	// ── Mutations ───────────────────────────────────────────────────────

	function addGoal(
		objective: string,
		ctx: ExtensionContext,
		mode: "auto" | "queue" | "replace",
	): { goal: Goal; activatedNow: boolean } {
		const now = Date.now();
		const a = active();
		const id = newGoalId();

		// Only active or queued goals block auto-activation. Paused goals are
		// user-suspended — they shouldn't gate new goals.
		const hasPending = goals.some(
			(g) => g.status === "active" || g.status === "queued",
		);

		let activatedNow = false;
		if (mode === "replace" && a) {
			a.status = "abandoned";
			a.updatedAt = now;
			activatedNow = true;
		} else if (mode === "auto") {
			// Activate only if nothing is pending (queue empty AND no paused).
			activatedNow = !hasPending;
		} else if (mode === "queue") {
			// Explicit queue: never auto-activate, even if queue is empty.
			activatedNow = false;
		}

		const goal: Goal = {
			id,
			objective,
			status: activatedNow ? "active" : "queued",
			createdAt: now,
			updatedAt: now,
			tokensUsed: 0,
			timeUsedMs: 0,
		};
		goals.push(goal);

		// Reset suspension on any explicit goal action.
		userSuspended = false;
		consecutiveErrors = 0;
		consecutiveContinuations = 0;

		persistGoal("add");
		updateFooterStatus(ctx);

		if (activatedNow) sendContinuationImmediate(ctx);

		return { goal, activatedNow };
	}

	function setStatus(goalId: string, status: GoalStatus, ctx: ExtensionContext) {
		const g = goals.find((x) => x.id === goalId);
		if (!g) return;
		const wasActive = g.status === "active";
		g.status = status;
		g.updatedAt = Date.now();

		const freedQueue =
			wasActive && (status === "complete" || status === "abandoned");

		if (wasActive && status !== "active") clearContinuationTimer();

		// Defer the action: persist + maybe promote, but do promotion at the END
		// so we have one consistent snapshot.
		let promoted: Goal | null = null;
		if (freedQueue) {
			const next = findNextQueued(goals);
			if (next) {
				next.status = "active";
				next.updatedAt = Date.now();
				promoted = next;
			}
		}

		// Any explicit transition that produces a new active goal counts as user
		// engagement — reset suspension so the new active actually gets nudged.
		if ((status === "active" && !wasActive) || promoted) {
			userSuspended = false;
			consecutiveErrors = 0;
			consecutiveContinuations = 0;
		}

		persistGoal(
			status === "complete"
				? "complete"
				: status === "abandoned"
					? "abandon"
					: promoted
						? "activate"
						: "update",
		);
		updateFooterStatus(ctx);

		if (promoted) {
			ctx.ui.notify(`🎯 Next goal activated: ${promoted.objective}`, "info");
			sendContinuationImmediate(ctx);
		} else if (status === "active" && !wasActive) {
			sendContinuationImmediate(ctx);
		}
	}

	function clearAll(ctx: ExtensionContext) {
		clearContinuationTimer();
		goals = [];
		userSuspended = false;
		consecutiveErrors = 0;
		consecutiveContinuations = 0;
		goalDrivenInvocation = false;
		persistGoal("clear");
		updateFooterStatus(ctx);
	}

	// ── /goal command ───────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: "Set, queue, or manage goals for long-running tasks",
		getArgumentCompletions: (prefix) => {
			const subs = [
				"clear",
				"pause",
				"resume",
				"continue",
				"complete",
				"next",
				"skip",
				"status",
				"--replace",
				"--queue",
			];
			const filtered = subs.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// Subcommands
			if (trimmed === "clear") {
				if (goals.length === 0) {
					ctx.ui.notify("No goals to clear", "info");
					return;
				}
				clearAll(ctx);
				ctx.ui.notify("All goals cleared", "info");
				return;
			}

			if (trimmed === "pause") {
				const a = active();
				if (!a) {
					ctx.ui.notify("No active goal to pause", "info");
					return;
				}
				setStatus(a.id, "paused", ctx);
				ctx.ui.notify("Goal paused", "info");
				return;
			}

			if (trimmed === "resume") {
				if (active()) {
					ctx.ui.notify("A goal is already active", "info");
					return;
				}
				// Prefer paused (most-recently-updated), else next queued.
				const candidates = goals
					.filter((g) => g.status === "paused")
					.sort((a, b) => b.updatedAt - a.updatedAt);
				const target = candidates[0] ?? findNextQueued(goals);
				if (!target) {
					ctx.ui.notify("No goal to resume", "info");
					return;
				}
				setStatus(target.id, "active", ctx);
				ctx.ui.notify(`Goal resumed: ${target.objective}`, "info");
				return;
			}

			if (trimmed === "continue") {
				if (!active()) {
					ctx.ui.notify("No active goal", "info");
					return;
				}
				if (!userSuspended) {
					ctx.ui.notify("Continuations already enabled", "info");
					return;
				}
				userSuspended = false;
				consecutiveErrors = 0;
				ctx.ui.notify("Continuation nudges re-enabled", "info");
				sendContinuationImmediate(ctx);
				return;
			}

			if (trimmed === "complete") {
				const a = active();
				if (!a) {
					ctx.ui.notify("No active goal to complete", "info");
					return;
				}
				setStatus(a.id, "complete", ctx);
				ctx.ui.notify("Goal marked complete 🎉", "info");
				return;
			}

			if (trimmed === "next" || trimmed === "skip") {
				const a = active();
				if (!a) {
					// No active — try to promote a queued one.
					const next = findNextQueued(goals);
					if (!next) {
						ctx.ui.notify("No goal to advance to", "info");
						return;
					}
					setStatus(next.id, "active", ctx);
					ctx.ui.notify(`Goal activated: ${next.objective}`, "info");
					return;
				}
				setStatus(a.id, "abandoned", ctx);
				const newActive = active();
				if (newActive) {
					ctx.ui.notify(`Skipped. Now: ${newActive.objective}`, "info");
				} else {
					ctx.ui.notify("Skipped. No more goals queued.", "info");
				}
				return;
			}

			// Status menu
			if (trimmed === "" || trimmed === "status") {
				if (goals.length === 0) {
					ctx.ui.notify("No goals set. Usage: /goal <objective>", "info");
					return;
				}
				if (!ctx.hasUI) {
					const a = active();
					const qd = queueDepth(goals);
					const head = a
						? `Active [${a.status}]: ${a.objective}`
						: `No active goal (${goals.length} total)`;
					ctx.ui.notify(qd > 0 ? `${head} (+${qd} queued)` : head, "info");
					return;
				}
				const action = await ctx.ui.custom<MenuAction>((_tui, theme, _kb, done) => {
					return new GoalSummaryComponent(goals, userSuspended, theme, done);
				});
				const a = active();
				switch (action) {
					case "pause":
						if (a) {
							setStatus(a.id, "paused", ctx);
							ctx.ui.notify("Goal paused", "info");
						}
						break;
					case "resume": {
						if (active()) break;
						const candidates = goals
							.filter((g) => g.status === "paused")
							.sort((x, y) => y.updatedAt - x.updatedAt);
						const target = candidates[0] ?? findNextQueued(goals);
						if (target) {
							setStatus(target.id, "active", ctx);
							ctx.ui.notify(`Goal resumed: ${target.objective}`, "info");
						}
						break;
					}
					case "complete":
						if (a) {
							setStatus(a.id, "complete", ctx);
							ctx.ui.notify("Goal complete 🎉", "info");
						}
						break;
					case "next":
						if (a) {
							setStatus(a.id, "abandoned", ctx);
							const newActive = active();
							ctx.ui.notify(
								newActive
									? `Skipped. Now: ${newActive.objective}`
									: "Skipped. No more goals.",
								"info",
							);
						}
						break;
					case "continue":
						userSuspended = false;
						consecutiveErrors = 0;
						ctx.ui.notify("Continuation nudges re-enabled", "info");
						if (active()) sendContinuationImmediate(ctx);
						break;
					case "clear":
						clearAll(ctx);
						ctx.ui.notify("All goals cleared", "info");
						break;
					case "close":
						break;
				}
				return;
			}

			// /goal [--replace|--queue] <objective>
			let mode: "auto" | "queue" | "replace" = "auto";
			let rest = trimmed;

			const replaceMatch = rest.match(/^--replace\s+/);
			if (replaceMatch) {
				mode = "replace";
				rest = rest.slice(replaceMatch[0].length);
			} else {
				const queueMatch = rest.match(/^--queue\s+/);
				if (queueMatch) {
					mode = "queue";
					rest = rest.slice(queueMatch[0].length);
				}
			}

			let objective = rest.trim();
			if (!objective) {
				ctx.ui.notify(
					"Usage: /goal [--replace|--queue] <objective>",
					"info",
				);
				return;
			}

			objective = objective.replace(/\n{3,}/g, "\n\n").trim();
			if (objective.length > 32000) {
				ctx.ui.notify("Goal objective must be at most 32000 characters", "error");
				return;
			}

			const { goal, activatedNow } = addGoal(objective, ctx, mode);

			if (activatedNow) {
				if (mode === "replace") {
					ctx.ui.notify(`🎯 Replaced. Now: ${goal.objective}`, "info");
				} else {
					ctx.ui.notify(`🎯 Goal set: ${goal.objective}`, "info");
				}
			} else {
				ctx.ui.notify(
					`📥 Queued (#${queueDepth(goals)}): ${goal.objective}`,
					"info",
				);
			}
		},
	});

	// ── update_goal tool ────────────────────────────────────────────────

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description: `Mark the active goal complete when its objective is fully achieved.
Set status to "complete" only when every requirement of the objective has been verified against the actual state of the project (files, tests, command output).
Do not mark complete because you are stopping work or progress feels good. Pause and resume are controlled by the user, not this tool.
When marked complete, the next queued goal (if any) activates automatically.`,
		promptSnippet: "update_goal: Mark the active goal complete when achieved",
		parameters: Type.Object({
			status: Type.Literal("complete", {
				description:
					"Set to complete only when the objective is fully achieved and verified",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const a = active();
			if (!a) throw new Error("No active goal to update");
			if (params.status !== "complete") {
				throw new Error(
					"update_goal can only mark the active goal complete; pause/resume are user actions",
				);
			}

			const completed = a;
			setStatus(completed.id, "complete", ctx);

			const parts = [`Goal complete: ${completed.objective}`];
			parts.push(`Tokens: ${formatTokens(completed.tokensUsed)}`);
			parts.push(`Time: ${formatElapsed(completed.timeUsedMs)}`);

			const nextActive = active();
			if (nextActive && nextActive.id !== completed.id) {
				parts.push(`Next goal activated: ${nextActive.objective}`);
			} else if (queueDepth(goals) > 0) {
				parts.push(`${queueDepth(goals)} goal(s) still paused.`);
			}

			return {
				content: [{ type: "text" as const, text: parts.join(". ") }],
				details: { goal: completed },
			};
		},
	});

	// ── get_goal tool ───────────────────────────────────────────────────

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description:
			"Inspect the active goal and the queue (status, time used, tokens used).",
		promptSnippet: "get_goal: Check the active goal + queue",
		parameters: Type.Object({}),
		async execute(_id, _p, _s, _u, _ctx) {
			if (goals.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No goals are currently set." }],
					details: {},
				};
			}
			const a = active();
			const describe = (g: Goal) => ({
				id: g.id,
				objective: g.objective,
				status: g.status,
				time_used_seconds: Math.floor(g.timeUsedMs / 1000),
				tokens_used: g.tokensUsed,
			});
			const info = {
				active: a ? describe(a) : null,
				queue: goals
					.filter((g) => g.status !== "complete" && g.status !== "abandoned")
					.map(describe),
				history: goals
					.filter((g) => g.status === "complete" || g.status === "abandoned")
					.map(describe),
				queued_count: queueDepth(goals),
				continuations_suspended: userSuspended,
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
				details: info,
			};
		},
	});

	// ── Cleanup ─────────────────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		clearContinuationTimer();
		stopFooterTicker();
		footerCtx = null;
		turnStartedAt = null;
		turnGoalId = null;
	});
}
