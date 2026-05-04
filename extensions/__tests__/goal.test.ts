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
	test("paused", () => assert.equal(goalStatusLabel("paused"), "⏸ paused"));
	test("complete", () => assert.equal(goalStatusLabel("complete"), "✅ complete"));
	test("budget_limited", () => assert.equal(goalStatusLabel("budget_limited"), "⚠️ budget limited"));
});

// ── continuation prompt ──────────────────────────────────────────────────

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
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
	test("includes objective", () => {
		const prompt = buildContinuationPrompt(makeGoal());
		assert.match(prompt, /Fix the auth bug/);
	});

	test("includes time used in seconds", () => {
		const prompt = buildContinuationPrompt(makeGoal({ timeUsedMs: 300_000 }));
		assert.match(prompt, /300 seconds/);
	});

	test("includes token budget and remaining", () => {
		const prompt = buildContinuationPrompt(makeGoal({ tokensUsed: 10_000, tokenBudget: 50_000 }));
		assert.match(prompt, /Tokens used: 10000/);
		assert.match(prompt, /Token budget: 50000/);
		assert.match(prompt, /Tokens remaining: 40000/);
	});

	test("unlimited budget says unlimited", () => {
		const prompt = buildContinuationPrompt(makeGoal({ tokenBudget: null }));
		assert.match(prompt, /Token budget: unlimited/);
		assert.match(prompt, /Tokens remaining: unlimited/);
	});

	test("mentions update_goal", () => {
		const prompt = buildContinuationPrompt(makeGoal());
		assert.match(prompt, /update_goal/);
	});

	test("wraps objective in untrusted tag", () => {
		const prompt = buildContinuationPrompt(makeGoal());
		assert.match(prompt, /<untrusted_objective>/);
		assert.match(prompt, /<\/untrusted_objective>/);
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
		const prompt = buildBudgetLimitPrompt(makeGoal({ tokenBudget: 50_000, tokensUsed: 50_000 }));
		assert.match(prompt, /Token budget: 50000/);
	});

	test("says do not start new work", () => {
		const prompt = buildBudgetLimitPrompt(makeGoal());
		assert.match(prompt, /do not start new substantive work/i);
	});
});
