/**
 * pi-goal — Goal tracking extension for pi
 *
 * Inspired by Codex's /goal command. Implements the same core behavior:
 *
 * 1. `/goal <objective>` — Set an active goal, agent auto-continues working on it
 * 2. `/goal` (no args) — Show goal status menu with pause/resume/complete/clear
 * 3. `/goal clear|pause|resume` — Quick status changes
 *
 * The agent gets:
 * - Goal context injected into system prompt each turn
 * - A continuation message when idle + goal is active (autonomous loop)
 * - `update_goal` tool to mark goal complete
 * - `get_goal` tool to check current goal status
 *
 * State persisted via session entries for branch support.
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
} from "./helpers.ts";
import type { Goal, GoalStatus } from "./helpers.ts";

/** Stored in session entries as details */
interface GoalEntry {
	action: "set" | "update" | "clear";
	goal: Goal | null;
}

// ============================================================================
// Goal Summary UI Component
// ============================================================================

class GoalSummaryComponent implements Component {
	private goal: Goal;
	private theme: Theme;
	private onAction: (action: "pause" | "resume" | "complete" | "clear" | "close") => void;
	private selectedIndex = 0;
	private actions: Array<{
		label: string;
		key: "pause" | "resume" | "complete" | "clear" | "close";
	}>;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		goal: Goal,
		theme: Theme,
		onAction: (action: "pause" | "resume" | "complete" | "clear" | "close") => void,
	) {
		this.goal = goal;
		this.theme = theme;
		this.onAction = onAction;

		this.actions = [];
		if (goal.status === "active") {
			this.actions.push({ label: "⏸  Pause goal", key: "pause" });
			this.actions.push({ label: "✅ Mark complete", key: "complete" });
		} else if (goal.status === "paused" || goal.status === "budget_limited" || goal.status === "complete") {
			this.actions.push({ label: "▶  Resume goal", key: "resume" });
			if (goal.status !== "complete") {
				this.actions.push({ label: "✅ Mark complete", key: "complete" });
			}
		}
		this.actions.push({ label: "🗑  Clear goal", key: "clear" });
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
			this.selectedIndex = Math.min(this.actions.length - 1, this.selectedIndex + 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, "return")) {
			const action = this.actions[this.selectedIndex];
			if (action) this.onAction(action.key);
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const lines: string[] = [];

		lines.push("");
		const title = th.fg("accent", " Goal ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) +
			title +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");
		lines.push(
			truncateToWidth(`  Status: ${goalStatusLabel(this.goal.status)}`, width),
		);
		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${th.fg("muted", "Objective:")} ${this.goal.objective}`,
				width,
			),
		);
		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${th.fg("muted", "Time:")} ${formatElapsed(this.goal.timeUsedMs)}`,
				width,
			),
		);
		if (this.goal.tokenBudget !== null) {
			const pct = Math.round(
				(this.goal.tokensUsed / this.goal.tokenBudget) * 100,
			);
			lines.push(
				truncateToWidth(
					`  ${th.fg("muted", "Tokens:")} ${formatTokens(this.goal.tokensUsed)}/${formatTokens(this.goal.tokenBudget)} (${pct}%)`,
					width,
				),
			);
		} else if (this.goal.tokensUsed > 0) {
			lines.push(
				truncateToWidth(
					`  ${th.fg("muted", "Tokens:")} ${formatTokens(this.goal.tokensUsed)}`,
					width,
				),
			);
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

const CONTINUATION_DELAY_MS = 2000; // Wait before auto-continuing

export default function piGoalExtension(pi: ExtensionAPI) {
	let currentGoal: Goal | null = null;
	let turnStartedAt: number | null = null; // wall-clock tracking per turn
	let continuationTimer: ReturnType<typeof setTimeout> | null = null;

	// ── State reconstruction ─────────────────────────────────────────────

	const reconstructState = (ctx: ExtensionContext) => {
		currentGoal = null;
		turnStartedAt = null;
		clearContinuationTimer();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "pi-goal") continue;
			const data = entry.data as GoalEntry | undefined;
			if (!data) continue;

			if (data.action === "clear") {
				currentGoal = null;
			} else if (data.goal) {
				currentGoal = data.goal;
			}
		}

		updateFooterStatus(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		// Resume continuation loop if goal is active (like Codex's ThreadResumed → MaybeContinueIfIdle)
		if (currentGoal && currentGoal.status === "active") {
			scheduleContinuation();
		}
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		if (currentGoal && currentGoal.status === "active") {
			scheduleContinuation();
		}
	});

	// ── Wall-clock time tracking ─────────────────────────────────────────

	pi.on("turn_start", async (_event, _ctx) => {
		if (currentGoal && currentGoal.status === "active") {
			turnStartedAt = Date.now();
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (currentGoal && currentGoal.status === "active" && turnStartedAt) {
			const elapsed = Date.now() - turnStartedAt;
			currentGoal.timeUsedMs += elapsed;
			currentGoal.updatedAt = Date.now();
			turnStartedAt = null;

			// Rough token estimate per turn
			currentGoal.tokensUsed += 500;

			// Check budget
			if (
				currentGoal.tokenBudget !== null &&
				currentGoal.tokensUsed >= currentGoal.tokenBudget
			) {
				currentGoal.status = "budget_limited";
				currentGoal.updatedAt = Date.now();
				persistGoal("update");
				updateFooterStatus(ctx);
				// Steer agent to wrap up (like Codex's budget_limit steering)
				pi.sendMessage(
					{ customType: "pi-goal:budget-limit", content: buildBudgetLimitPrompt(currentGoal), display: false },
					{ triggerTurn: true, deliverAs: "steer" },
				);
				return;
			}

			persistGoal("update");
			updateFooterStatus(ctx);
		}
	});

	// ── Auto-continuation: when agent finishes and goal is active ────────
	//
	// This is the core of the "Ralph loop" — after each agent_end, if the
	// goal is still active, schedule a continuation turn. No suppression
	// for no-tool turns (Codex removed that in #20523 because it caused
	// goals to stop short).

	pi.on("agent_end", async (event, ctx) => {
		updateFooterStatus(ctx);

		// If agent was interrupted (Esc/Ctrl+C), pause the goal (matches Codex)
		if (currentGoal && currentGoal.status === "active") {
			const lastMsg = event.messages[event.messages.length - 1];
			if (lastMsg && "stopReason" in lastMsg && lastMsg.stopReason === "aborted") {
				updateGoalStatus("paused", ctx);
				ctx.ui.notify("Goal paused (interrupted). Use /goal resume to continue.", "info");
				return;
			}
		}

		scheduleContinuation();
	});

	function scheduleContinuation() {
		clearContinuationTimer();

		// Only continue if goal is active
		if (!currentGoal || currentGoal.status !== "active") return;

		continuationTimer = setTimeout(() => {
			continuationTimer = null;

			// Re-check: goal may have been paused/cleared/completed during delay
			if (!currentGoal || currentGoal.status !== "active") return;

			// Don't send if agent is already streaming (user sent something)
			// isIdle check prevents collision with user input
			// Hidden continuation — not shown in chat (like Codex's developer-role message)
			pi.sendMessage(
				{ customType: "pi-goal:continuation", content: buildContinuationPrompt(currentGoal), display: false },
				{ triggerTurn: true },
			);
		}, CONTINUATION_DELAY_MS);
	}

	function clearContinuationTimer() {
		if (continuationTimer) {
			clearTimeout(continuationTimer);
			continuationTimer = null;
		}
	}

	// ── Cancel continuation when user sends input ───────────────────────
	// If user types something while continuation is pending, their input
	// takes priority (matches Codex: pending user input suppresses continuation).

	pi.on("input", async (_event, _ctx) => {
		clearContinuationTimer();
	});

	// ── Inject goal context into system prompt ───────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!currentGoal || currentGoal.status === "complete") return;

		const lines = [
			"",
			"## Active Goal",
			`Objective: ${currentGoal.objective}`,
			`Status: ${currentGoal.status}`,
			`Time elapsed: ${formatElapsed(currentGoal.timeUsedMs)}`,
			`Tokens used: ${formatTokens(currentGoal.tokensUsed)}`,
		];
		if (currentGoal.tokenBudget !== null) {
			const remaining = Math.max(0, currentGoal.tokenBudget - currentGoal.tokensUsed);
			lines.push(
				`Token budget: ${formatTokens(currentGoal.tokenBudget)} (${formatTokens(remaining)} remaining)`,
			);
		}
		lines.push("");
		lines.push(
			"Stay focused on this goal. Use update_goal to mark it complete when the objective is achieved.",
		);
		lines.push("");

		return {
			systemPrompt: event.systemPrompt + lines.join("\n"),
		};
	});

	// ── Footer status ────────────────────────────────────────────────────

	const updateFooterStatus = (ctx: ExtensionContext) => {
		if (!currentGoal) {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		const elapsed = formatElapsed(currentGoal.timeUsedMs);
		const tokens = currentGoal.tokenBudget
			? `${formatTokens(currentGoal.tokensUsed)}/${formatTokens(currentGoal.tokenBudget)}`
			: formatTokens(currentGoal.tokensUsed);

		switch (currentGoal.status) {
			case "active":
				if (currentGoal.tokenBudget) {
					ctx.ui.setStatus("goal", `Pursuing goal (${tokens})`);
				} else {
					ctx.ui.setStatus("goal", `Pursuing goal (${elapsed})`);
				}
				break;
			case "paused":
				ctx.ui.setStatus("goal", `Goal paused (/goal resume)`);
				break;
			case "budget_limited":
				if (currentGoal.tokenBudget) {
					ctx.ui.setStatus("goal", `Goal unmet (${tokens})`);
				} else {
					ctx.ui.setStatus("goal", `Goal unmet`);
				}
				break;
			case "complete":
				if (currentGoal.tokenBudget) {
					ctx.ui.setStatus("goal", `Goal achieved (${formatTokens(currentGoal.tokensUsed)} tokens)`);
				} else {
					ctx.ui.setStatus("goal", `Goal achieved (${elapsed})`);
				}
				break;
		}
	};

	// ── Persistence helper ───────────────────────────────────────────────

	function persistGoal(action: "set" | "update" | "clear") {
		pi.appendEntry<GoalEntry>("pi-goal", {
			action,
			goal: currentGoal ? { ...currentGoal } : null,
		});
	}

	// ── Goal mutation helpers ────────────────────────────────────────────

	const setGoal = (
		objective: string,
		tokenBudget: number | null,
		ctx: ExtensionContext,
	): Goal => {
		clearContinuationTimer();
		const now = Date.now();

		currentGoal = {
			objective,
			status: "active",
			createdAt: now,
			updatedAt: now,
			tokensUsed: 0,
			tokenBudget,
			timeUsedMs: 0,
		};

		persistGoal("set");
		updateFooterStatus(ctx);
		return currentGoal;
	};

	const updateGoalStatus = (status: GoalStatus, ctx: ExtensionContext) => {
		if (!currentGoal) return;

		// If resuming, clear continuation so we don't double-fire
		if (status === "active") {
			clearContinuationTimer();
		}
		// If pausing/completing, cancel any pending continuation
		if (status !== "active") {
			clearContinuationTimer();
		}

		currentGoal.status = status;
		currentGoal.updatedAt = Date.now();
		persistGoal("update");
		updateFooterStatus(ctx);

		// If resumed to active, schedule continuation (agent may be idle)
		if (status === "active") {
			scheduleContinuation();
		}
	};

	const clearGoal = (ctx: ExtensionContext) => {
		clearContinuationTimer();
		currentGoal = null;
		persistGoal("clear");
		updateFooterStatus(ctx);
	};

	// ── /goal command ────────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: "Set or view the goal for a long-running task",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["clear", "pause", "resume", "status"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// /goal clear
			if (trimmed === "clear") {
				if (!currentGoal) {
					ctx.ui.notify("No goal to clear", "info");
					return;
				}
				clearGoal(ctx);
				ctx.ui.notify("Goal cleared", "info");
				return;
			}

			// /goal pause
			if (trimmed === "pause") {
				if (!currentGoal) {
					ctx.ui.notify("No goal set", "info");
					return;
				}
				if (currentGoal.status === "paused") {
					ctx.ui.notify("Goal is already paused", "info");
					return;
				}
				updateGoalStatus("paused", ctx);
				ctx.ui.notify("Goal paused", "info");
				return;
			}

			// /goal resume
			if (trimmed === "resume") {
				if (!currentGoal) {
					ctx.ui.notify("No goal set", "info");
					return;
				}
				if (currentGoal.status === "active") {
					ctx.ui.notify("Goal is already active", "info");
					return;
				}
				if (currentGoal.status === "complete") {
					// User disagrees with completion — re-activate the goal loop
					updateGoalStatus("active", ctx);
					ctx.ui.notify("Goal re-activated — agent will continue working", "info");
					return;
				}
				updateGoalStatus("active", ctx);
				ctx.ui.notify("Goal resumed — agent will continue working", "info");
				return;
			}

			// /goal (no args) or /goal status → show menu or info
			if (trimmed === "" || trimmed === "status") {
				if (!currentGoal) {
					ctx.ui.notify(
						"No goal set. Usage: /goal <objective>",
						"info",
					);
					return;
				}

				if (!ctx.hasUI) {
					const timeUsed = formatElapsed(currentGoal.timeUsedMs);
					const tokens = currentGoal.tokenBudget
						? `${formatTokens(currentGoal.tokensUsed)}/${formatTokens(currentGoal.tokenBudget)}`
						: formatTokens(currentGoal.tokensUsed);
					ctx.ui.notify(
						`Goal [${currentGoal.status}]: ${currentGoal.objective} (${timeUsed}, ${tokens})`,
						"info",
					);
					return;
				}

				// Interactive goal menu
				const action = await ctx.ui.custom<
					"pause" | "resume" | "complete" | "clear" | "close"
				>((_tui, theme, _kb, done) => {
					return new GoalSummaryComponent(currentGoal!, theme, done);
				});

				switch (action) {
					case "pause":
						updateGoalStatus("paused", ctx);
						ctx.ui.notify("Goal paused", "info");
						break;
					case "resume":
						updateGoalStatus("active", ctx);
						ctx.ui.notify(
							"Goal resumed — agent will continue working",
							"info",
						);
						break;
					case "complete":
						updateGoalStatus("complete", ctx);
						ctx.ui.notify("Goal complete! 🎉", "info");
						break;
					case "clear":
						clearGoal(ctx);
						ctx.ui.notify("Goal cleared", "info");
						break;
					case "close":
						break;
				}
				return;
			}

			// /goal <objective> [--budget <N>]
			let objective = trimmed;
			let tokenBudget: number | null = null;

			const budgetMatch = trimmed.match(/--budget\s+(\d+[kKmM]?)\s*/);
			if (budgetMatch) {
				const budgetStr = budgetMatch[1].toLowerCase();
				let budget = Number.parseInt(budgetStr, 10);
				if (budgetStr.endsWith("k"))
					budget = Number.parseInt(budgetStr, 10) * 1000;
				else if (budgetStr.endsWith("m"))
					budget = Number.parseInt(budgetStr, 10) * 1_000_000;
				tokenBudget = budget;
				objective = trimmed
					.replace(/--budget\s+\d+[kKmM]?\s*/, "")
					.trim();
			}

			if (!objective) {
				ctx.ui.notify(
					"Usage: /goal <objective> [--budget <tokens>]",
					"info",
				);
				return;
			}

			// Validate objective (matches Codex: max 4000 chars, collapse blank lines)
			objective = objective.replace(/\n{3,}/g, "\n\n").trim();
			if (objective.length > 4000) {
				ctx.ui.notify(
					"Goal objective must be at most 4000 characters",
					"error",
				);
				return;
			}

			// Confirm replacement if active goal exists
			if (
				currentGoal &&
				currentGoal.status !== "complete"
			) {
				if (ctx.hasUI) {
					const replace = await ctx.ui.confirm(
						"Replace goal?",
						`Current: ${currentGoal.objective}\nNew: ${objective}`,
					);
					if (!replace) return;
				}
			}

			const goal = setGoal(objective, tokenBudget, ctx);
			ctx.ui.notify(`🎯 Goal set: ${goal.objective}`, "info");

			// Kick off work via hidden continuation (not a visible user message).
			// Codex: /goal just sets metadata, then the continuation loop starts.
			scheduleContinuation();
		},
	});

	// ── update_goal tool (LLM marks goal complete) ───────────────────────

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description: `Update the existing goal.
Use this tool only to mark the goal achieved.
Set status to "complete" only when the objective has actually been achieved and no required work remains.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.
You cannot use this tool to pause, resume, or budget-limit a goal; those status changes are controlled by the user.
When marking a budgeted goal complete, report the final token usage to the user.`,
		promptSnippet:
			"update_goal: Mark the current goal complete when the objective is achieved",
		parameters: Type.Object({
			status: Type.Literal("complete", {
				description:
					"Set to complete only when the objective is achieved and no required work remains",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!currentGoal) {
				throw new Error("No goal exists to update");
			}
			if (params.status !== "complete") {
				throw new Error(
					"update_goal can only mark the goal complete; pause/resume are controlled by the user via /goal",
				);
			}

		updateGoalStatus("complete", ctx);

			const parts = [`Goal complete: ${currentGoal!.objective}`];
			if (currentGoal!.tokenBudget) {
				parts.push(
					`Tokens: ${formatTokens(currentGoal!.tokensUsed)}/${formatTokens(currentGoal!.tokenBudget)}`,
				);
			}
			parts.push(`Time: ${formatElapsed(currentGoal!.timeUsedMs)}`);

			return {
				content: [{ type: "text" as const, text: parts.join(". ") }],
			};
		},
	});

	// ── get_goal tool (LLM checks goal status) ──────────────────────────

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description:
			"Get the current goal for this session, including status, budgets, token and elapsed-time usage, and remaining token budget.",
		promptSnippet: "get_goal: Check current goal status, budget, and time",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!currentGoal) {
				return {
					content: [
						{ type: "text" as const, text: "No goal is currently set." },
					],
				};
			}

			const remaining =
				currentGoal.tokenBudget !== null
					? Math.max(0, currentGoal.tokenBudget - currentGoal.tokensUsed)
					: null;

			const info = {
				objective: currentGoal.objective,
				status: currentGoal.status,
				time_used_seconds: Math.floor(currentGoal.timeUsedMs / 1000),
				tokens_used: currentGoal.tokensUsed,
				token_budget: currentGoal.tokenBudget,
				remaining_tokens: remaining,
			};

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(info, null, 2),
					},
				],
			};
		},
	});

	// ── Cleanup on session shutdown ──────────────────────────────────────

	pi.on("session_shutdown", async () => {
		clearContinuationTimer();
		turnStartedAt = null;
	});
}
