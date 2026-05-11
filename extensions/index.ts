/**
 * pi-goal — Goal tracking extension for pi (DAG model)
 *
 * Inspired by Codex's /goal command, extended with a goal DAG so users can keep
 * queuing objectives without waiting for the active one to finish — like adding
 * commits to a branch while CI is running.
 *
 * Behaviour:
 *
 * - `/goal <objective>` — If no active goal, becomes active immediately. If a
 *   goal is already active, the new one is added silently to the DAG as a
 *   queued node depending on the active goal, so the agent's current work is
 *   not interrupted.
 * - `/goal` (no args) — Show DAG status menu with pause/resume/complete/clear.
 * - `/goal pause|resume|clear` — Operate on the active goal (clear wipes the
 *   whole DAG).
 *
 * The agent gets:
 * - Active goal context injected into system prompt each turn
 * - A continuation message after idle while an active goal exists
 * - `update_goal` tool to mark the active goal complete
 * - `get_goal` tool to inspect the active goal + DAG
 *
 * State is persisted as session entries for branch support. Each mutation
 * snapshots the full goals array so replay is trivial.
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
	findNextReady,
	queueDepth,
	newGoalId,
} from "./helpers.ts";
import type { Goal, GoalStatus } from "./helpers.ts";

/** Stored in session entries as details — full snapshot of the DAG. */
interface GoalEntry {
	action: "add" | "update" | "activate" | "complete" | "clear";
	goals: Goal[];
}

// ============================================================================
// Goal Summary UI Component
// ============================================================================

class GoalSummaryComponent implements Component {
	private goals: Goal[];
	private active: Goal | null;
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
		goals: Goal[],
		theme: Theme,
		onAction: (action: "pause" | "resume" | "complete" | "clear" | "close") => void,
	) {
		this.goals = goals;
		this.active = findActive(goals);
		this.theme = theme;
		this.onAction = onAction;

		this.actions = [];
		const a = this.active;
		if (a) {
			if (a.status === "active") {
				this.actions.push({ label: "⏸  Pause active goal", key: "pause" });
				this.actions.push({ label: "✅ Mark active complete", key: "complete" });
			} else if (
				a.status === "paused" ||
				a.status === "budget_limited" ||
				a.status === "complete"
			) {
				this.actions.push({ label: "▶  Resume goal", key: "resume" });
				if (a.status !== "complete") {
					this.actions.push({ label: "✅ Mark complete", key: "complete" });
				}
			}
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
		const title = th.fg("accent", ` Goal DAG (${this.goals.length}) `);
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) +
			title +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 10 - String(this.goals.length).length)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		// Render each goal in the DAG
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
			if (g.dependencies.length > 0) {
				meta.push(`deps ${g.dependencies.length}`);
			}
			lines.push(
				truncateToWidth(`      ${th.fg("muted", meta.join(" · "))}`, width),
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
	/** The DAG. Order is creation order. */
	let goals: Goal[] = [];
	let turnStartedAt: number | null = null; // wall-clock tracking per turn
	let continuationTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Helpers ──────────────────────────────────────────────────────────

	const active = (): Goal | null => findActive(goals);

	// ── State reconstruction ─────────────────────────────────────────────

	const reconstructState = (ctx: ExtensionContext) => {
		goals = [];
		turnStartedAt = null;
		clearContinuationTimer();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "pi-goal") continue;
			const data = entry.data as GoalEntry | undefined;
			if (!data) continue;
			// Full-snapshot replay: just take the latest state.
			goals = data.goals.map((g) => ({ ...g, dependencies: [...g.dependencies] }));
		}

		updateFooterStatus(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		syncGoalTools();
		if (active()) scheduleContinuation(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		syncGoalTools();
		if (active()) scheduleContinuation(ctx);
	});

	// ── Wall-clock time tracking ─────────────────────────────────────────

	pi.on("turn_start", async (_event, _ctx) => {
		if (active()) {
			turnStartedAt = Date.now();
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		const a = active();
		if (a && turnStartedAt) {
			const elapsed = Date.now() - turnStartedAt;
			a.timeUsedMs += elapsed;
			a.updatedAt = Date.now();
			turnStartedAt = null;

			// Token counting: use actual usage from assistant message if available
			const msg = event.message as any;
			if (msg?.usage?.totalTokens) {
				a.tokensUsed += msg.usage.totalTokens;
			} else if (msg?.usage?.input != null && msg?.usage?.output != null) {
				a.tokensUsed += msg.usage.input + msg.usage.output;
			} else {
				a.tokensUsed += 500;
			}

			// Check budget
			if (a.tokenBudget !== null && a.tokensUsed >= a.tokenBudget) {
				a.status = "budget_limited";
				a.updatedAt = Date.now();
				persistGoal("update");
				updateFooterStatus(ctx);
				pi.sendMessage(
					{
						customType: "pi-goal:budget-limit",
						content: buildBudgetLimitPrompt(a),
						display: false,
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
				return;
			}

			persistGoal("update");
			updateFooterStatus(ctx);
		}
	});

	// ── Auto-continuation ────────────────────────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		updateFooterStatus(ctx);

		const a = active();
		if (a) {
			const lastMsg = event.messages[event.messages.length - 1];
			if (lastMsg && "stopReason" in lastMsg && lastMsg.stopReason === "aborted") {
				updateGoalStatus(a.id, "paused", ctx);
				ctx.ui.notify("Goal paused (interrupted). Use /goal resume to continue.", "info");
				return;
			}
		}

		if (ctx.hasPendingMessages()) return;

		scheduleContinuation(ctx);
	});

	function scheduleContinuation(ctx?: ExtensionContext) {
		clearContinuationTimer();

		const a = active();
		if (!a) return;

		if (ctx && (!ctx.isIdle() || ctx.hasPendingMessages())) return;

		const goalId = a.id;

		continuationTimer = setTimeout(() => {
			continuationTimer = null;

			const a2 = active();
			if (!a2 || a2.id !== goalId) return; // active changed/cleared

			pi.sendMessage(
				{
					customType: "pi-goal:continuation",
					content: buildContinuationPrompt(a2),
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}, CONTINUATION_DELAY_MS);
	}

	function clearContinuationTimer() {
		if (continuationTimer) {
			clearTimeout(continuationTimer);
			continuationTimer = null;
		}
	}

	pi.on("input", async (_event, _ctx) => {
		clearContinuationTimer();
	});

	// ── Inject active goal context into system prompt ────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		const a = active();
		if (!a) return;

		const lines = [
			"",
			"## Active Goal",
			`Objective: ${a.objective}`,
			`Status: ${a.status}`,
			`Time elapsed: ${formatElapsed(a.timeUsedMs)}`,
			`Tokens used: ${formatTokens(a.tokensUsed)}`,
		];
		if (a.tokenBudget !== null) {
			const remaining = Math.max(0, a.tokenBudget - a.tokensUsed);
			lines.push(
				`Token budget: ${formatTokens(a.tokenBudget)} (${formatTokens(remaining)} remaining)`,
			);
		}
		const qd = queueDepth(goals);
		if (qd > 0) {
			lines.push(`Queued goals waiting: ${qd}`);
		}
		lines.push("");
		lines.push(
			"Stay focused on this goal. Use update_goal to mark it complete when the objective is achieved. When you complete this goal, the next queued goal (if any) will activate automatically — do not switch focus until then.",
		);
		lines.push("");

		return {
			systemPrompt: event.systemPrompt + lines.join("\n"),
		};
	});

	// ── Footer status ────────────────────────────────────────────────────

	const updateFooterStatus = (ctx: ExtensionContext) => {
		const a = active();
		if (!a && goals.length === 0) {
			ctx.ui.setStatus("goal", undefined);
			return;
		}

		const qd = queueDepth(goals) - (a ? 0 : 0); // queueDepth already excludes active
		const suffix = qd > 0 ? ` [+${qd} queued]` : "";

		if (!a) {
			// No active goal but DAG has pending items (all paused/budget_limited)
			ctx.ui.setStatus("goal", `Goal DAG idle${suffix}`);
			return;
		}

		const elapsed = formatElapsed(a.timeUsedMs);
		const tokens = a.tokenBudget
			? `${formatTokens(a.tokensUsed)}/${formatTokens(a.tokenBudget)}`
			: formatTokens(a.tokensUsed);

		switch (a.status) {
			case "active":
				if (a.tokenBudget) {
					ctx.ui.setStatus("goal", `Pursuing goal (${tokens})${suffix}`);
				} else {
					ctx.ui.setStatus("goal", `Pursuing goal (${elapsed})${suffix}`);
				}
				break;
			case "paused":
				ctx.ui.setStatus("goal", `Goal paused (/goal resume)${suffix}`);
				break;
			case "budget_limited":
				ctx.ui.setStatus("goal", a.tokenBudget ? `Goal unmet (${tokens})${suffix}` : `Goal unmet${suffix}`);
				break;
			case "complete":
				ctx.ui.setStatus(
					"goal",
					a.tokenBudget
						? `Goal achieved (${formatTokens(a.tokensUsed)} tokens)${suffix}`
						: `Goal achieved (${elapsed})${suffix}`,
				);
				break;
			case "queued":
				ctx.ui.setStatus("goal", `Goal queued${suffix}`);
				break;
		}
	};

	// ── Persistence helper ───────────────────────────────────────────────

	function persistGoal(action: GoalEntry["action"]) {
		pi.appendEntry<GoalEntry>("pi-goal", {
			action,
			goals: goals.map((g) => ({ ...g, dependencies: [...g.dependencies] })),
		});
		syncGoalTools();
	}

	// Hide goal tools from LLM when no active goal
	const GOAL_TOOL_NAMES = ["get_goal", "update_goal"];
	function syncGoalTools() {
		const want = !!active();
		const activeTools = new Set(pi.getActiveTools());
		for (const name of GOAL_TOOL_NAMES) {
			if (want) activeTools.add(name);
			else activeTools.delete(name);
		}
		pi.setActiveTools(Array.from(activeTools));
	}

	// ── Goal mutation helpers ────────────────────────────────────────────

	/** Add a new goal to the DAG.
	 *
	 * - If no goal is active, the new goal becomes active immediately.
	 * - Otherwise it's enqueued with a dependency on the current active goal
	 *   (serial chain behaviour), so the agent doesn't get interrupted.
	 */
	const addGoal = (
		objective: string,
		tokenBudget: number | null,
		ctx: ExtensionContext,
	): Goal => {
		const now = Date.now();
		const a = active();
		const id = newGoalId();

		const goal: Goal = {
			id,
			objective,
			status: a ? "queued" : "active",
			dependencies: a ? [a.id] : [],
			createdAt: now,
			updatedAt: now,
			tokensUsed: 0,
			tokenBudget,
			timeUsedMs: 0,
		};

		goals.push(goal);
		persistGoal("add");
		updateFooterStatus(ctx);

		// If we just activated, kick off the continuation loop.
		if (!a) scheduleContinuation(ctx);

		return goal;
	};

	const updateGoalStatus = (
		goalId: string,
		status: GoalStatus,
		ctx: ExtensionContext,
	) => {
		const g = goals.find((x) => x.id === goalId);
		if (!g) return;

		const wasActive = g.status === "active";
		g.status = status;
		g.updatedAt = Date.now();

		if (wasActive && status !== "active") {
			// Active slot freed — maybe promote the next ready goal.
			clearContinuationTimer();
			maybePromoteNext(ctx);
		}

		if (status === "active") {
			clearContinuationTimer();
			scheduleContinuation(ctx);
		}

		persistGoal(status === "complete" ? "complete" : "update");
		updateFooterStatus(ctx);
	};

	/** Try to promote the next ready queued goal to active. */
	const maybePromoteNext = (ctx: ExtensionContext) => {
		if (active()) return; // still something active
		const next = findNextReady(goals);
		if (!next) return;
		next.status = "active";
		next.updatedAt = Date.now();
		persistGoal("activate");
		updateFooterStatus(ctx);
		ctx.ui.notify(`🎯 Next goal activated: ${next.objective}`, "info");
		scheduleContinuation(ctx);
	};

	/** Clear the entire DAG. */
	const clearAll = (ctx: ExtensionContext) => {
		clearContinuationTimer();
		goals = [];
		persistGoal("clear");
		updateFooterStatus(ctx);
	};

	// ── /goal command ────────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: "Set or view the goal DAG for long-running tasks",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["clear", "pause", "resume", "status"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// /goal clear — clears entire DAG
			if (trimmed === "clear") {
				if (goals.length === 0) {
					ctx.ui.notify("No goals to clear", "info");
					return;
				}
				clearAll(ctx);
				ctx.ui.notify("All goals cleared", "info");
				return;
			}

			// /goal pause — pauses the active goal
			if (trimmed === "pause") {
				const a = active();
				if (!a) {
					ctx.ui.notify("No active goal to pause", "info");
					return;
				}
				updateGoalStatus(a.id, "paused", ctx);
				ctx.ui.notify("Goal paused", "info");
				return;
			}

			// /goal resume — resumes the most recent non-complete goal
			if (trimmed === "resume") {
				if (active()) {
					ctx.ui.notify("A goal is already active", "info");
					return;
				}
				// Find the most recently-updated paused/budget_limited/complete goal
				const candidates = goals
					.filter(
						(g) =>
							g.status === "paused" ||
							g.status === "budget_limited" ||
							g.status === "complete",
					)
					.sort((a, b) => b.updatedAt - a.updatedAt);
				const target = candidates[0];
				if (!target) {
					// Maybe there's a queued goal that's ready but no one promoted it
					const next = findNextReady(goals);
					if (next) {
						updateGoalStatus(next.id, "active", ctx);
						ctx.ui.notify(
							`Goal activated: ${next.objective}`,
							"info",
						);
						return;
					}
					ctx.ui.notify("No goal to resume", "info");
					return;
				}
				updateGoalStatus(target.id, "active", ctx);
				ctx.ui.notify(
					`Goal resumed: ${target.objective}`,
					"info",
				);
				return;
			}

			// /goal or /goal status — show status menu
			if (trimmed === "" || trimmed === "status") {
				if (goals.length === 0) {
					ctx.ui.notify(
						"No goals set. Usage: /goal <objective>",
						"info",
					);
					return;
				}

				if (!ctx.hasUI) {
					const a = active();
					const qd = queueDepth(goals);
					const head = a
						? `Active [${a.status}]: ${a.objective}`
						: `No active goal (${goals.length} in DAG)`;
					ctx.ui.notify(
						qd > 0 ? `${head} (+${qd} queued)` : head,
						"info",
					);
					return;
				}

				const action = await ctx.ui.custom<
					"pause" | "resume" | "complete" | "clear" | "close"
				>((_tui, theme, _kb, done) => {
					return new GoalSummaryComponent(goals, theme, done);
				});

				const a = active();
				switch (action) {
					case "pause":
						if (a) {
							updateGoalStatus(a.id, "paused", ctx);
							ctx.ui.notify("Goal paused", "info");
						}
						break;
					case "resume": {
						if (active()) break;
						const candidates = goals
							.filter(
								(g) =>
									g.status === "paused" ||
									g.status === "budget_limited" ||
									g.status === "complete",
							)
							.sort((x, y) => y.updatedAt - x.updatedAt);
						const target = candidates[0] ?? findNextReady(goals);
						if (target) {
							updateGoalStatus(target.id, "active", ctx);
							ctx.ui.notify(
								`Goal resumed: ${target.objective}`,
								"info",
							);
						}
						break;
					}
					case "complete":
						if (a) {
							updateGoalStatus(a.id, "complete", ctx);
							ctx.ui.notify("Goal complete! 🎉", "info");
						}
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

			// Normalize (collapse blank runs, enforce max length)
			objective = objective.replace(/\n{3,}/g, "\n\n").trim();
			if (objective.length > 4000) {
				ctx.ui.notify(
					"Goal objective must be at most 4000 characters",
					"error",
				);
				return;
			}

			// DAG model: adding a new goal never replaces the active one and never
			// interrupts current work. No confirmation prompt needed.
			const wasActive = active();
			const goal = addGoal(objective, tokenBudget, ctx);

			if (wasActive) {
				ctx.ui.notify(
					`📥 Queued goal: ${goal.objective} (will start after active goal completes)`,
					"info",
				);
			} else {
				ctx.ui.notify(`🎯 Goal set: ${goal.objective}`, "info");
			}
		},
	});

	// ── update_goal tool (LLM marks goal complete) ───────────────────────

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description: `Update the active goal.
Use this tool only to mark the active goal achieved.
Set status to "complete" only when the objective has actually been achieved and no required work remains.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.
You cannot use this tool to pause, resume, or budget-limit a goal; those status changes are controlled by the user.
When the active goal is marked complete, the next ready queued goal (if any) will activate automatically.
When marking a budgeted goal complete, report the final token usage to the user.`,
		promptSnippet:
			"update_goal: Mark the active goal complete when the objective is achieved",
		parameters: Type.Object({
			status: Type.Literal("complete", {
				description:
					"Set to complete only when the objective is achieved and no required work remains",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const a = active();
			if (!a) {
				throw new Error("No active goal to update");
			}
			if (params.status !== "complete") {
				throw new Error(
					"update_goal can only mark the active goal complete; pause/resume are controlled by the user via /goal",
				);
			}

			const completed = a;
			updateGoalStatus(completed.id, "complete", ctx);

			const parts = [`Goal complete: ${completed.objective}`];
			if (completed.tokenBudget) {
				parts.push(
					`Tokens: ${formatTokens(completed.tokensUsed)}/${formatTokens(completed.tokenBudget)}`,
				);
			}
			parts.push(`Time: ${formatElapsed(completed.timeUsedMs)}`);

			const nextActive = active();
			if (nextActive && nextActive.id !== completed.id) {
				parts.push(`Next goal activated: ${nextActive.objective}`);
			} else {
				const qd = queueDepth(goals);
				if (qd > 0) {
					parts.push(`${qd} goal(s) still in DAG (paused or waiting on deps).`);
				}
			}

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
			"Get the active goal and the rest of the goal DAG for this session, including each goal's status, dependencies, budgets, token and elapsed-time usage, and remaining token budget.",
		promptSnippet: "get_goal: Check the active goal + goal DAG",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (goals.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: "No goals are currently set." },
					],
				};
			}

			const a = active();

			const describe = (g: Goal) => ({
				id: g.id,
				objective: g.objective,
				status: g.status,
				dependencies: g.dependencies,
				time_used_seconds: Math.floor(g.timeUsedMs / 1000),
				tokens_used: g.tokensUsed,
				token_budget: g.tokenBudget,
				remaining_tokens:
					g.tokenBudget !== null
						? Math.max(0, g.tokenBudget - g.tokensUsed)
						: null,
			});

			const info = {
				active: a ? describe(a) : null,
				dag: goals.map(describe),
				queued_count: queueDepth(goals),
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
