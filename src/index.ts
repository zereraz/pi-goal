/**
 * pi-goal — Goal tracking extension for pi
 *
 * Inspired by Codex's /goal command. Provides:
 * - `/goal <objective>` — Set a goal for the current session
 * - `/goal` (no args) — Show current goal status & actions menu
 * - `/goal clear` — Clear the current goal
 * - `goal` tool — LLM can read/update goal status
 *
 * Goals track:
 * - Objective text
 * - Status (active, paused, complete)
 * - Token usage (estimated from turns)
 * - Time elapsed since goal was set
 *
 * State is persisted via session entries for proper branch support.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";

// ============================================================================
// Types
// ============================================================================

export type GoalStatus = "active" | "paused" | "complete";

export interface Goal {
	objective: string;
	status: GoalStatus;
	createdAt: number; // epoch ms
	updatedAt: number; // epoch ms
	tokensUsed: number;
	tokenBudget: number | null; // null = unlimited
}

/** Stored in session entries as details */
interface GoalEntry {
	action: "set" | "update" | "clear";
	goal: Goal | null;
}

// ============================================================================
// Formatting helpers (ported from codex goal_display.rs)
// ============================================================================

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const remainingHours = hours % 24;
		return `${days}d ${remainingHours}h ${remainingMinutes}m`;
	}
	return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function goalStatusLabel(status: GoalStatus): string {
	switch (status) {
		case "active":
			return "🟢 active";
		case "paused":
			return "⏸ paused";
		case "complete":
			return "✅ complete";
	}
}

function goalSummaryText(goal: Goal): string {
	const parts = [`Objective: ${goal.objective}`];
	const elapsed = Date.now() - goal.createdAt;
	if (elapsed > 0) {
		parts.push(`Time: ${formatElapsed(elapsed)}.`);
	}
	if (goal.tokenBudget !== null) {
		parts.push(`Tokens: ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}.`);
	} else if (goal.tokensUsed > 0) {
		parts.push(`Tokens: ${formatTokens(goal.tokensUsed)}.`);
	}
	return parts.join(" ");
}

// ============================================================================
// Goal Summary UI Component
// ============================================================================

class GoalSummaryComponent implements Component {
	private goal: Goal;
	private theme: Theme;
	private onAction: (action: "pause" | "resume" | "complete" | "clear" | "close") => void;
	private selectedIndex = 0;
	private actions: Array<{ label: string; key: "pause" | "resume" | "complete" | "clear" | "close" }>;
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

		// Build actions based on current status
		this.actions = [];
		if (goal.status === "active") {
			this.actions.push({ label: "⏸  Pause goal", key: "pause" });
			this.actions.push({ label: "✅ Mark complete", key: "complete" });
		} else if (goal.status === "paused") {
			this.actions.push({ label: "▶  Resume goal", key: "resume" });
			this.actions.push({ label: "✅ Mark complete", key: "complete" });
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
			if (action) {
				this.onAction(action.key);
			}
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const lines: string[] = [];

		lines.push("");
		const title = th.fg("accent", " Goal ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		// Status
		lines.push(truncateToWidth(`  Status: ${goalStatusLabel(this.goal.status)}`, width));
		lines.push("");

		// Objective
		lines.push(truncateToWidth(`  ${th.fg("muted", "Objective:")} ${this.goal.objective}`, width));
		lines.push("");

		// Time elapsed
		const elapsed = Date.now() - this.goal.createdAt;
		lines.push(truncateToWidth(`  ${th.fg("muted", "Time:")} ${formatElapsed(elapsed)}`, width));

		// Token usage
		if (this.goal.tokenBudget !== null) {
			const pct = Math.round((this.goal.tokensUsed / this.goal.tokenBudget) * 100);
			lines.push(
				truncateToWidth(
					`  ${th.fg("muted", "Tokens:")} ${formatTokens(this.goal.tokensUsed)}/${formatTokens(this.goal.tokenBudget)} (${pct}%)`,
					width,
				),
			);
		} else if (this.goal.tokensUsed > 0) {
			lines.push(
				truncateToWidth(`  ${th.fg("muted", "Tokens:")} ${formatTokens(this.goal.tokensUsed)}`, width),
			);
		}

		lines.push("");

		// Actions
		lines.push(truncateToWidth(`  ${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`, width));
		lines.push("");
		for (let i = 0; i < this.actions.length; i++) {
			const action = this.actions[i];
			const prefix = i === this.selectedIndex ? th.fg("accent", "▸ ") : "  ";
			const label = i === this.selectedIndex ? th.fg("text", action.label) : th.fg("muted", action.label);
			lines.push(truncateToWidth(`  ${prefix}${label}`, width));
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ navigate • Enter select • Esc close")}`, width));
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
	// In-memory goal state (reconstructed from session entries)
	let currentGoal: Goal | null = null;

	// ── State reconstruction from session entries ─────────────────────────

	const reconstructState = (ctx: ExtensionContext) => {
		currentGoal = null;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "pi-goal") continue;
			const data = entry.data as GoalEntry | undefined;
			if (!data) continue;

			if (data.action === "clear") {
				currentGoal = null;
			} else {
				currentGoal = data.goal;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// ── Track token usage per turn ───────────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => {
		if (!currentGoal || currentGoal.status !== "active") return;

		// Estimate tokens from context usage
		const usage = ctx.getContextUsage();
		if (usage?.tokens) {
			// Rough estimate: use delta since last check
			// For simplicity, we increment by a fixed amount per turn
			// A more accurate approach would track input/output tokens from the provider
			currentGoal.tokensUsed += 500; // Conservative estimate per turn
			currentGoal.updatedAt = Date.now();

			// Persist updated goal
			pi.appendEntry<GoalEntry>("pi-goal", {
				action: "update",
				goal: { ...currentGoal },
			});

			// Check budget limit
			if (currentGoal.tokenBudget !== null && currentGoal.tokensUsed >= currentGoal.tokenBudget) {
				currentGoal.status = "paused";
				currentGoal.updatedAt = Date.now();
				pi.appendEntry<GoalEntry>("pi-goal", {
					action: "update",
					goal: { ...currentGoal },
				});
				ctx.ui.notify(`⚠️ Goal budget reached (${formatTokens(currentGoal.tokenBudget)} tokens). Goal paused.`, "warning");
			}
		}
	});

	// ── Update footer with goal status ───────────────────────────────────

	const updateFooterStatus = (ctx: ExtensionContext) => {
		if (currentGoal && currentGoal.status === "active") {
			const elapsed = formatElapsed(Date.now() - currentGoal.createdAt);
			const tokens = currentGoal.tokenBudget
				? `${formatTokens(currentGoal.tokensUsed)}/${formatTokens(currentGoal.tokenBudget)}`
				: formatTokens(currentGoal.tokensUsed);
			const obj =
				currentGoal.objective.length > 30
					? currentGoal.objective.slice(0, 27) + "..."
					: currentGoal.objective;
			ctx.ui.setStatus("goal", `🎯 ${obj} [${elapsed} • ${tokens}]`);
		} else if (currentGoal && currentGoal.status === "paused") {
			ctx.ui.setStatus("goal", `⏸ Goal paused`);
		} else {
			ctx.ui.setStatus("goal", undefined);
		}
	};

	pi.on("session_start", async (_event, ctx) => updateFooterStatus(ctx));
	pi.on("turn_end", async (_event, ctx) => updateFooterStatus(ctx));
	pi.on("agent_end", async (_event, ctx) => updateFooterStatus(ctx));

	// ── Helper: set goal ─────────────────────────────────────────────────

	const setGoal = (objective: string, tokenBudget: number | null, ctx: ExtensionContext): Goal => {
		const now = Date.now();

		// If there's an existing active goal with the same objective, just update
		if (
			currentGoal &&
			currentGoal.objective === objective &&
			currentGoal.status !== "complete"
		) {
			if (tokenBudget !== undefined) {
				currentGoal.tokenBudget = tokenBudget;
			}
			currentGoal.updatedAt = now;
			pi.appendEntry<GoalEntry>("pi-goal", {
				action: "update",
				goal: { ...currentGoal },
			});
			return currentGoal;
		}

		// Create new goal (replacing any existing)
		currentGoal = {
			objective,
			status: "active",
			createdAt: now,
			updatedAt: now,
			tokensUsed: 0,
			tokenBudget,
		};

		pi.appendEntry<GoalEntry>("pi-goal", {
			action: "set",
			goal: { ...currentGoal },
		});

		updateFooterStatus(ctx);
		return currentGoal;
	};

	const updateGoalStatus = (status: GoalStatus, ctx: ExtensionContext) => {
		if (!currentGoal) return;
		currentGoal.status = status;
		currentGoal.updatedAt = Date.now();
		pi.appendEntry<GoalEntry>("pi-goal", {
			action: "update",
			goal: { ...currentGoal },
		});
		updateFooterStatus(ctx);
	};

	const clearGoal = (ctx: ExtensionContext) => {
		currentGoal = null;
		pi.appendEntry<GoalEntry>("pi-goal", {
			action: "clear",
			goal: null,
		});
		updateFooterStatus(ctx);
	};

	// ── /goal command ────────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: "Set, view, or manage session goal",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["clear", "pause", "resume", "complete", "status"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
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
				updateGoalStatus("active", ctx);
				ctx.ui.notify("Goal resumed", "info");
				return;
			}

			// /goal complete
			if (trimmed === "complete") {
				if (!currentGoal) {
					ctx.ui.notify("No goal set", "info");
					return;
				}
				updateGoalStatus("complete", ctx);
				ctx.ui.notify("Goal marked complete! 🎉", "info");
				return;
			}

			// /goal status (or just /goal with no args)
			if (trimmed === "status" || trimmed === "") {
				if (!currentGoal) {
					ctx.ui.notify("No goal set. Usage: /goal <objective>", "info");
					return;
				}

				if (!ctx.hasUI) {
					ctx.ui.notify(goalSummaryText(currentGoal), "info");
					return;
				}

				// Show interactive goal menu
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
						ctx.ui.notify("Goal resumed", "info");
						break;
					case "complete":
						updateGoalStatus("complete", ctx);
						ctx.ui.notify("Goal marked complete! 🎉", "info");
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

			// /goal <objective> — parse optional budget with --budget <N>
			let objective = trimmed;
			let tokenBudget: number | null = null;

			const budgetMatch = trimmed.match(/--budget\s+(\d+[kKmM]?)\s*/);
			if (budgetMatch) {
				const budgetStr = budgetMatch[1].toLowerCase();
				let budget = Number.parseInt(budgetStr, 10);
				if (budgetStr.endsWith("k")) budget = Number.parseInt(budgetStr, 10) * 1000;
				else if (budgetStr.endsWith("m")) budget = Number.parseInt(budgetStr, 10) * 1_000_000;
				tokenBudget = budget;
				objective = trimmed.replace(/--budget\s+\d+[kKmM]?\s*/, "").trim();
			}

			if (!objective) {
				ctx.ui.notify("Usage: /goal <objective> [--budget <tokens>]", "info");
				return;
			}

			// If there's an existing goal, confirm replacement
			if (currentGoal && currentGoal.status !== "complete") {
				const replace = await ctx.ui.confirm(
					"Replace goal?",
					`Current: ${currentGoal.objective}\nNew: ${objective}`,
				);
				if (!replace) return;
			}

			const goal = setGoal(objective, tokenBudget, ctx);
			ctx.ui.notify(`🎯 Goal set: ${goal.objective}`, "info");
		},
	});

	// ── goal tool (LLM can read/update goal) ─────────────────────────────

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description:
			"Read or manage the session goal. Actions: get (show current goal), set (objective, optional token_budget), pause, resume, complete, clear.",
		promptSnippet: "goal: Read or manage the session goal objective and status",
		promptGuidelines: [
			"Use the goal tool to check the current objective before starting work",
			"Mark goals complete when the objective is achieved",
			"If the user sets a goal via /goal, reference it to stay focused",
		],
		parameters: {
			type: "object" as const,
			properties: {
				action: {
					type: "string" as const,
					enum: ["get", "set", "pause", "resume", "complete", "clear"],
					description: "Action to perform",
				},
				objective: {
					type: "string" as const,
					description: "Goal objective text (for set action)",
				},
				token_budget: {
					type: "number" as const,
					description: "Optional token budget (for set action)",
				},
			},
			required: ["action"],
		} as any,

		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const action = params.action as string;

			switch (action) {
				case "get": {
					if (!currentGoal) {
						return {
							content: [{ type: "text" as const, text: "No goal is currently set." }],
						};
					}
					return {
						content: [
							{
								type: "text" as const,
								text: [
									`Status: ${currentGoal.status}`,
									`Objective: ${currentGoal.objective}`,
									`Time: ${formatElapsed(Date.now() - currentGoal.createdAt)}`,
									currentGoal.tokenBudget
										? `Tokens: ${formatTokens(currentGoal.tokensUsed)}/${formatTokens(currentGoal.tokenBudget)}`
										: `Tokens: ${formatTokens(currentGoal.tokensUsed)}`,
								].join("\n"),
							},
						],
					};
				}

				case "set": {
					const objective = params.objective as string | undefined;
					if (!objective) {
						return {
							content: [{ type: "text" as const, text: "Error: objective is required for set action" }],
							isError: true,
						};
					}
					const goal = setGoal(objective, params.token_budget ?? null, ctx);
					return {
						content: [
							{
								type: "text" as const,
								text: `Goal set: ${goal.objective} (status: ${goal.status})`,
							},
						],
					};
				}

				case "pause": {
					if (!currentGoal) {
						return {
							content: [{ type: "text" as const, text: "No goal to pause" }],
							isError: true,
						};
					}
					updateGoalStatus("paused", ctx);
					return {
						content: [{ type: "text" as const, text: "Goal paused" }],
					};
				}

				case "resume": {
					if (!currentGoal) {
						return {
							content: [{ type: "text" as const, text: "No goal to resume" }],
							isError: true,
						};
					}
					updateGoalStatus("active", ctx);
					return {
						content: [{ type: "text" as const, text: "Goal resumed" }],
					};
				}

				case "complete": {
					if (!currentGoal) {
						return {
							content: [{ type: "text" as const, text: "No goal to complete" }],
							isError: true,
						};
					}
					updateGoalStatus("complete", ctx);
					return {
						content: [{ type: "text" as const, text: "Goal marked complete! 🎉" }],
					};
				}

				case "clear": {
					if (!currentGoal) {
						return {
							content: [{ type: "text" as const, text: "No goal to clear" }],
						};
					}
					clearGoal(ctx);
					return {
						content: [{ type: "text" as const, text: "Goal cleared" }],
					};
				}

				default:
					return {
						content: [
							{
								type: "text" as const,
								text: `Unknown action: ${action}. Valid: get, set, pause, resume, complete, clear`,
							},
						],
						isError: true,
					};
			}
		},

		renderCall(args: any, theme) {
			const action = args.action || "?";
			let text = theme.fg("toolTitle", theme.bold("goal ")) + theme.fg("muted", action);
			if (args.objective) text += ` ${theme.fg("dim", `"${args.objective}"`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			if (result.isError) {
				return new Text(theme.fg("error", msg), 0, 0);
			}
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
		},
	});

	// ── Inject goal into system prompt when active ───────────────────────

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!currentGoal || currentGoal.status === "complete") return;

		const goalBlock = [
			"",
			"## Current Goal",
			`Objective: ${currentGoal.objective}`,
			`Status: ${currentGoal.status}`,
			`Time elapsed: ${formatElapsed(Date.now() - currentGoal.createdAt)}`,
			currentGoal.tokenBudget
				? `Token budget: ${formatTokens(currentGoal.tokensUsed)}/${formatTokens(currentGoal.tokenBudget)}`
				: "",
			"Stay focused on this goal. Report progress and mark it complete when done.",
			"",
		]
			.filter(Boolean)
			.join("\n");

		return {
			systemPrompt: _event.systemPrompt + goalBlock,
		};
	});
}
