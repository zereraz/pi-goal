/**
 * pi-goal — pure function tests
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	formatElapsed,
	formatTokens,
	goalStatusLabel,
	buildContinuationPrompt,
	buildBudgetLimitPrompt,
	findActive,
	findNextQueued,
	queueDepth,
	pendingGoals,
	newGoalId,
} from "../helpers.ts";
import type { Goal } from "../helpers.ts";

// ── formatElapsed ────────────────────────────────────────────────────────

describe("formatElapsed", () => {
	test("zero", () => assert.equal(formatElapsed(0), "0s"));
	test("sub-second rounds to 0s", () => assert.equal(formatElapsed(999), "0s"));
	test("seconds", () => assert.equal(formatElapsed(30_000), "30s"));
	test("59s boundary", () => assert.equal(formatElapsed(59_999), "59s"));
	test("exactly 1 minute", () => assert.equal(formatElapsed(60_000), "1m"));
	test("30 minutes", () => assert.equal(formatElapsed(30 * 60_000), "30m"));
	test("59 minutes", () => assert.equal(formatElapsed(59 * 60_000), "59m"));
	test("exactly 1 hour", () => assert.equal(formatElapsed(60 * 60_000), "1h"));
	test("1h 30m", () => assert.equal(formatElapsed(90 * 60_000), "1h 30m"));
	test("2h even", () => assert.equal(formatElapsed(2 * 60 * 60_000), "2h"));
	test("23h 59m", () => assert.equal(formatElapsed((24 * 60 * 60 - 1) * 1000), "23h 59m"));
	test("exactly 1 day", () => assert.equal(formatElapsed(24 * 60 * 60_000), "1d 0h 0m"));
	test("2d 23h 42m", () => {
		const ms = (2 * 24 * 60 * 60 + 23 * 60 * 60 + 42 * 60) * 1000;
		assert.equal(formatElapsed(ms), "2d 23h 42m");
	});
	test("negative clamps to 0s", () => assert.equal(formatElapsed(-5000), "0s"));
});

// ── formatTokens ─────────────────────────────────────────────────────────

describe("formatTokens", () => {
	test("small number", () => assert.equal(formatTokens(42), "42"));
	test("999", () => assert.equal(formatTokens(999), "999"));
	test("1000", () => assert.equal(formatTokens(1000), "1.0K"));
	test("1500", () => assert.equal(formatTokens(1500), "1.5K"));
	test("9999", () => assert.equal(formatTokens(9999), "10.0K"));
	test("10000", () => assert.equal(formatTokens(10_000), "10K"));
	test("50000", () => assert.equal(formatTokens(50_000), "50K"));
	test("999999", () => assert.equal(formatTokens(999_999), "1000K"));
	test("1M", () => assert.equal(formatTokens(1_000_000), "1.0M"));
	test("2.5M", () => assert.equal(formatTokens(2_500_000), "2.5M"));
});

// ── goalStatusLabel ──────────────────────────────────────────────────────

describe("goalStatusLabel", () => {
	test("active", () => assert.equal(goalStatusLabel("active"), "🟢 active"));
	test("queued", () => assert.equal(goalStatusLabel("queued"), "⏳ queued"));
	test("paused", () => assert.equal(goalStatusLabel("paused"), "⏸ paused"));
	test("complete", () => assert.equal(goalStatusLabel("complete"), "✅ complete"));
	test("abandoned", () => assert.equal(goalStatusLabel("abandoned"), "🚫 abandoned"));
	test("budget_limited", () =>
		assert.equal(goalStatusLabel("budget_limited"), "⚠️ budget limited"));
});

// ── continuation prompt ──────────────────────────────────────────────────

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: overrides.id ?? "g-" + Math.random().toString(36).slice(2, 8),
		objective: "Fix the auth bug",
		status: "active",
		createdAt: 0,
		updatedAt: 0,
		tokensUsed: 1200,
		tokenBudget: 50_000,
		timeUsedMs: 120_000,
		...overrides,
	};
}

describe("buildContinuationPrompt", () => {
	test("first prompt includes objective", () => {
		const prompt = buildContinuationPrompt(makeGoal(), true);
		assert.match(prompt, /Fix the auth bug/);
		assert.match(prompt, /New goal received/);
	});

	test("non-first prompt mentions continue", () => {
		const prompt = buildContinuationPrompt(makeGoal(), false);
		assert.match(prompt, /Continue working/);
	});

	test("includes time used in seconds (non-first)", () => {
		const prompt = buildContinuationPrompt(makeGoal({ timeUsedMs: 300_000 }), false);
		assert.match(prompt, /300s/);
	});

	test("includes token budget and remaining (non-first)", () => {
		const prompt = buildContinuationPrompt(
			makeGoal({ tokensUsed: 10_000, tokenBudget: 50_000 }),
			false,
		);
		assert.match(prompt, /Tokens used \(output only\): 10000/);
		assert.match(prompt, /Token budget: 50000/);
		assert.match(prompt, /Tokens remaining: 40000/);
	});

	test("unlimited budget says unlimited (non-first)", () => {
		const prompt = buildContinuationPrompt(makeGoal({ tokenBudget: null }), false);
		assert.match(prompt, /Token budget: unlimited/);
		assert.match(prompt, /Tokens remaining: unlimited/);
	});

	test("mentions update_goal", () => {
		const prompt = buildContinuationPrompt(makeGoal(), false);
		assert.match(prompt, /update_goal/);
	});

	test("wraps objective in untrusted tag", () => {
		const prompt = buildContinuationPrompt(makeGoal(), true);
		assert.match(prompt, /<untrusted_objective>/);
		assert.match(prompt, /<\/untrusted_objective>/);
	});
});

// ── Queue helpers ────────────────────────────────────────────────────────

describe("findActive", () => {
	test("no goals → null", () => assert.equal(findActive([]), null));
	test("no active → null", () => {
		const g = makeGoal({ status: "queued" });
		assert.equal(findActive([g]), null);
	});
	test("finds the active goal", () => {
		const q = makeGoal({ id: "q", status: "queued" });
		const a = makeGoal({ id: "a", status: "active" });
		assert.equal(findActive([q, a])?.id, "a");
	});
});

describe("findNextQueued", () => {
	test("no queued → null", () => {
		const a = makeGoal({ status: "active" });
		assert.equal(findNextQueued([a]), null);
	});

	test("picks earliest queued by createdAt (FIFO)", () => {
		const a = makeGoal({ id: "a", status: "complete" });
		const b = makeGoal({ id: "b", status: "queued", createdAt: 200 });
		const c = makeGoal({ id: "c", status: "queued", createdAt: 100 });
		assert.equal(findNextQueued([a, b, c])?.id, "c");
	});

	test("ignores paused/budget_limited/abandoned", () => {
		const p = makeGoal({ id: "p", status: "paused", createdAt: 1 });
		const b = makeGoal({ id: "b", status: "budget_limited", createdAt: 2 });
		const x = makeGoal({ id: "x", status: "abandoned", createdAt: 3 });
		const q = makeGoal({ id: "q", status: "queued", createdAt: 4 });
		assert.equal(findNextQueued([p, b, x, q])?.id, "q");
	});
});

describe("queueDepth", () => {
	test("counts queued+paused+budget_limited, excludes active/complete/abandoned", () => {
		const gs = [
			makeGoal({ id: "1", status: "active" }),
			makeGoal({ id: "2", status: "queued" }),
			makeGoal({ id: "3", status: "queued" }),
			makeGoal({ id: "4", status: "paused" }),
			makeGoal({ id: "5", status: "complete" }),
			makeGoal({ id: "6", status: "budget_limited" }),
			makeGoal({ id: "7", status: "abandoned" }),
		];
		assert.equal(queueDepth(gs), 4);
	});
});

describe("pendingGoals", () => {
	test("excludes complete and abandoned", () => {
		const gs = [
			makeGoal({ id: "1", status: "active" }),
			makeGoal({ id: "2", status: "queued" }),
			makeGoal({ id: "3", status: "complete" }),
			makeGoal({ id: "4", status: "abandoned" }),
			makeGoal({ id: "5", status: "paused" }),
		];
		assert.deepEqual(
			pendingGoals(gs).map((g) => g.id),
			["1", "2", "5"],
		);
	});
});

describe("newGoalId", () => {
	test("returns non-empty string", () => {
		const id = newGoalId();
		assert.equal(typeof id, "string");
		assert.ok(id.length > 0);
	});
	test("ids are unique across calls", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 50; i++) ids.add(newGoalId());
		assert.equal(ids.size, 50);
	});
});

describe("buildBudgetLimitPrompt", () => {
	test("includes objective", () => {
		const prompt = buildBudgetLimitPrompt(makeGoal());
		assert.match(prompt, /Fix the auth bug/);
	});

	test("says budget_limited", () => {
		const prompt = buildBudgetLimitPrompt(makeGoal());
		assert.match(prompt, /budget_limited/);
	});

	test("includes token budget", () => {
		const prompt = buildBudgetLimitPrompt(
			makeGoal({ tokenBudget: 50_000, tokensUsed: 50_000 }),
		);
		assert.match(prompt, /Token budget: 50000/);
	});

	test("says do not start new work", () => {
		const prompt = buildBudgetLimitPrompt(makeGoal());
		assert.match(prompt, /do not start new substantive work/i);
	});
});
