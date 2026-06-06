/**
 * pi-goal — Persistent goal pursuit for pi.
 *
 * Model: simple FIFO queue. One goal active at a time. New goals queue.
 *
 * Commands:
 * - /goal <objective> [--budget N]   set or queue a goal
 * - /goal --replace <objective>      abandon active, set new one immediately
 * - /goal --queue <objective>        explicit queue (same as /goal X with active)
 * - /goal next | /goal skip          abandon active, promote next queued
 * - /goal complete                   user marks active complete, promote next
 * - /goal pause | /goal resume       suspend / wake the active goal
 * - /goal continue                   re-enable continuation nudges after side conv
 * - /goal clear                      wipe everything
 * - /goal                            open status menu
 *
 * Steering rules:
 * - Continuation message ONLY fires when the previous turn was itself a
 *   continuation (or the goal was just set). Side conversations don't trigger
 *   continuations.
 * - System prompt injection happens ONLY on continuation turns. User turns get
 *   a clean system prompt — agent answers what user actually asked.
 * - First continuation after /goal is delivered immediately (queueMicrotask).
 *   Subsequent continuations debounce 2s after agent_end.
 * - Esc / abort does NOT auto-pause. User decides.
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
	buildBudgetLimitPrompt,
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

const CONTINUATION_DEBOUNCE_MS = 2000;
const CONTINUATION_CUSTOM_TYPE = "pi-goal:continuation";
const BUDGET_LIMIT_CUSTOM_TYPE = "pi-goal:budget-limit";

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
		const pausedExists = goals.some(
			(g) => g.status === "paused" || g.status === "budget_limited",
		);
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
			if (g.tokenBudget !== null) {
				const pct = Math.round((g.tokensUsed / g.tokenBudget) * 100);
				meta.push(
					`tokens ${formatTokens(g.tokensUsed)}/${formatTokens(g.tokenBudget)} (${pct}%)`,
				);
			} else if (g.tokensUsed > 0) {
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
	/** True if user steered away — continuations stay paused until /goal continue. */
	let userSuspended = false;
	/** Number of consecutive continuations without external input. */
	let consecutiveContinuations = 0;

	// ── Per-turn accounting ─────────────────────────────────────────────
	let turnStartedAt: number | null = null;
	/** Goal id that was active when the turn started — charge cost to this id
	 * even if the active goal changes mid-turn (e.g. agent calls update_goal). */
	let turnGoalId: string | null = null;

	let continuationTimer: ReturnType<typeof setTimeout> | null = null;

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
		userSuspended = false;
		consecutiveContinuations = 0;
		clearContinuationTimer();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "pi-goal") continue;
			const data = entry.data as GoalEntry | undefined;
			if (!data) continue;
			// Strip legacy `dependencies` field if present in old snapshots.
			goals = data.goals.map((g) => {
				const { ...rest } = g as Goal & { dependencies?: unknown };
				delete (rest as { dependencies?: unknown }).dependencies;
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
			goalDrivenInvocation = true;
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

	/** Debounced re-prompt after the agent finishes a continuation turn. */
	function scheduleContinuationDebounced(ctx: ExtensionContext) {
		clearContinuationTimer();
		if (userSuspended) return;
		const a = active();
		if (!a) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		const goalId = a.id;
		continuationTimer = setTimeout(() => {
			continuationTimer = null;
			const a2 = active();
			if (!a2 || a2.id !== goalId) return;
			if (userSuspended) return;
			goalDrivenInvocation = true;
			pi.sendMessage(
				{
					customType: CONTINUATION_CUSTOM_TYPE,
					content: buildContinuationPrompt(a2, /*isFirst*/ false),
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}, CONTINUATION_DEBOUNCE_MS);
	}

	// ── Turn lifecycle ──────────────────────────────────────────────────

	pi.on("turn_start", async (_event, _ctx) => {
		if (goalDrivenInvocation) {
			consecutiveContinuations += 1;
		} else {
			consecutiveContinuations = 0;
		}

		const a = active();
		if (a) {
			turnStartedAt = Date.now();
			turnGoalId = a.id;
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

		// Budget check — only if charged goal is still the active one.
		if (
			charged.status === "active" &&
			charged.tokenBudget !== null &&
			charged.tokensUsed >= charged.tokenBudget
		) {
			charged.status = "budget_limited";
			charged.updatedAt = Date.now();
			persistGoal("update");
			updateFooterStatus(ctx);
			pi.sendMessage(
				{
					customType: BUDGET_LIMIT_CUSTOM_TYPE,
					content: buildBudgetLimitPrompt(charged),
					display: false,
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			return;
		}

		persistGoal("update");
		updateFooterStatus(ctx);
	});

	// ── agent_end: decide whether to continue ───────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		updateFooterStatus(ctx);
		const wasGoalDriven = goalDrivenInvocation;
		// Reset the per-invocation flag now that the invocation is fully done.
		goalDrivenInvocation = false;

		const a = active();
		if (!a) return;

		// If the agent was interrupted (Esc) or hit an error, treat it as a
		// signal to stop nudging. The goal stays active (user didn't pause it),
		// but continuations suspend until the user explicitly /goal continue or
		// /goal resume. Without this, pressing Esc would just delay the same
		// continuation by 2s and re-fire it.
		const messages = event.messages ?? [];
		let lastAssistantStop: string | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as { role?: string; stopReason?: string };
			if (m && m.role === "assistant") {
				lastAssistantStop = m.stopReason;
				break;
			}
		}
		if (lastAssistantStop === "aborted" || lastAssistantStop === "error") {
			userSuspended = true;
			clearContinuationTimer();
			if (lastAssistantStop === "aborted") {
				ctx.ui.notify(
					"Goal continuations suspended (interrupted). Use /goal continue to resume.",
					"info",
				);
			}
			return;
		}

		// Only re-prompt if THIS just-finished invocation was itself goal-driven.
		if (!wasGoalDriven) return;
		if (userSuspended) return;
		if (ctx.hasPendingMessages()) return;

		scheduleContinuationDebounced(ctx);
	});

	// ── User input → suspend continuations ──────────────────────────────

	pi.on("input", async (_event, _ctx) => {
		// User just typed something. Stop nudging until they say /goal continue.
		clearContinuationTimer();
		if (active()) {
			userSuspended = true;
		}
	});

	// ── System prompt injection — only on continuation turns ────────────

	pi.on("before_agent_start", async (event, _ctx) => {
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
		if (a.tokenBudget !== null) {
			const remaining = Math.max(0, a.tokenBudget - a.tokensUsed);
			lines.push(
				`Token budget: ${formatTokens(a.tokenBudget)} (${formatTokens(remaining)} remaining)`,
			);
		}
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
		const a = active();
		if (!a && goals.every((g) => g.status === "complete" || g.status === "abandoned")) {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		const qd = queueDepth(goals);
		const suffix = qd > 0 ? ` [+${qd} queued]` : "";
		const susp = userSuspended ? " (suspended)" : "";
		if (!a) {
			ctx.ui.setStatus("goal", `Goals idle${suffix}`);
			return;
		}
		const elapsed = formatElapsed(a.timeUsedMs);
		const tokens = a.tokenBudget
			? `${formatTokens(a.tokensUsed)}/${formatTokens(a.tokenBudget)}`
			: formatTokens(a.tokensUsed);

		switch (a.status) {
			case "active":
				ctx.ui.setStatus(
					"goal",
					a.tokenBudget
						? `Goal active (${tokens})${suffix}${susp}`
						: `Goal active (${elapsed})${suffix}${susp}`,
				);
				break;
			case "paused":
				ctx.ui.setStatus("goal", `Goal paused${suffix}`);
				break;
			case "budget_limited":
				ctx.ui.setStatus(
					"goal",
					a.tokenBudget ? `Goal budget hit (${tokens})${suffix}` : `Goal budget hit${suffix}`,
				);
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
		tokenBudget: number | null,
		ctx: ExtensionContext,
		mode: "auto" | "queue" | "replace",
	): { goal: Goal; activatedNow: boolean } {
		const now = Date.now();
		const a = active();
		const id = newGoalId();

		// Anything pending blocks auto-activation: active, queued, paused,
		// budget_limited. Only abandoned/complete don't count.
		const hasPending = goals.some(
			(g) =>
				g.status === "active" ||
				g.status === "queued" ||
				g.status === "paused" ||
				g.status === "budget_limited",
		);

		let activatedNow = false;
		if (mode === "replace" && a) {
			a.status = "abandoned";
			a.updatedAt = now;
			activatedNow = true;
		} else if (mode === "auto") {
			// Activate only if nothing is pending (queue empty AND no paused/budget_limited).
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
			tokenBudget,
			timeUsedMs: 0,
		};
		goals.push(goal);

		// Reset suspension on any explicit goal action.
		userSuspended = false;
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
				// Prefer paused/budget_limited (most-recently-updated), else next queued.
				const candidates = goals
					.filter((g) => g.status === "paused" || g.status === "budget_limited")
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
							.filter((g) => g.status === "paused" || g.status === "budget_limited")
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

			// /goal [--replace|--queue] <objective> [--budget N]
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

			let tokenBudget: number | null = null;
			const budgetMatch = rest.match(/--budget\s+(\d+[kKmM]?)\s*/);
			if (budgetMatch) {
				const budgetStr = budgetMatch[1].toLowerCase();
				let budget = Number.parseInt(budgetStr, 10);
				if (budgetStr.endsWith("k")) budget = Number.parseInt(budgetStr, 10) * 1000;
				else if (budgetStr.endsWith("m"))
					budget = Number.parseInt(budgetStr, 10) * 1_000_000;
				tokenBudget = budget;
				rest = rest.replace(/--budget\s+\d+[kKmM]?\s*/, "").trim();
			}

			let objective = rest.trim();
			if (!objective) {
				ctx.ui.notify(
					"Usage: /goal [--replace|--queue] <objective> [--budget N]",
					"info",
				);
				return;
			}

			objective = objective.replace(/\n{3,}/g, "\n\n").trim();
			if (objective.length > 32000) {
				ctx.ui.notify("Goal objective must be at most 32000 characters", "error");
				return;
			}

			const { goal, activatedNow } = addGoal(objective, tokenBudget, ctx, mode);

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
Do not mark complete because budget is exhausted, you are stopping work, or progress feels good. Pause/resume/budget changes are controlled by the user, not this tool.
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
			if (completed.tokenBudget) {
				parts.push(
					`Tokens: ${formatTokens(completed.tokensUsed)}/${formatTokens(completed.tokenBudget)}`,
				);
			} else {
				parts.push(`Tokens: ${formatTokens(completed.tokensUsed)}`);
			}
			parts.push(`Time: ${formatElapsed(completed.timeUsedMs)}`);

			const nextActive = active();
			if (nextActive && nextActive.id !== completed.id) {
				parts.push(`Next goal activated: ${nextActive.objective}`);
			} else if (queueDepth(goals) > 0) {
				parts.push(`${queueDepth(goals)} goal(s) still paused/budget-limited.`);
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
			"Inspect the active goal and the queue (status, time used, tokens used vs. budget).",
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
				token_budget: g.tokenBudget,
				remaining_tokens:
					g.tokenBudget !== null ? Math.max(0, g.tokenBudget - g.tokensUsed) : null,
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
		turnStartedAt = null;
		turnGoalId = null;
	});
}
