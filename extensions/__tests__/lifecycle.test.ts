/**
 * pi-goal — lifecycle integration tests.
 *
 * These exist because every real bug this extension has had was a LIFECYCLE
 * bug, invisible to pure-function tests:
 *
 *  1. ctx.isIdle() is FALSE while agent_end is being emitted (pi-agent-core
 *     flips isStreaming only after event processing). Gating the continuation
 *     schedule on isIdle() at agent_end killed the loop on every single turn.
 *  2. User input silently suspended the loop (design bug).
 *  3. A single transient turn error silently suspended the loop.
 *  4. Esc suspended permanently instead of resuming after a grace window.
 *
 * The FakePi harness below reproduces pi v0.80.x semantics — INCLUDING the
 * isIdle-false-during-agent_end quirk — and drives the extension through
 * realistic event sequences.
 *
 * Timings are shrunk via env vars (see top of index.ts), set BEFORE import.
 */

process.env.PI_GOAL_DEBOUNCE_MS = "30";
process.env.PI_GOAL_ERROR_RETRY_MS = "60";
process.env.PI_GOAL_ABORT_RESUME_MS = "60";

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

// ── FakePi harness ─────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

interface SentMessage {
	msg: { customType?: string; content: string; display?: boolean };
	opts?: Record<string, unknown>;
}

class FakePi {
	handlers = new Map<string, Handler[]>();
	sent: SentMessage[] = [];
	entries: { customType: string; data: unknown }[] = [];
	tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
	activeTools: string[] = [];
	notifications: { message: string; level?: string }[] = [];
	statuses = new Map<string, string | undefined>();

	/** Mimics pi: isIdle() is FALSE while an agent_end handler runs. */
	streaming = false;
	pendingMessages = 0;

	ctx = {
		isIdle: () => !this.streaming,
		hasPendingMessages: () => this.pendingMessages > 0,
		hasUI: false,
		sessionManager: { getBranch: () => [] as unknown[] },
		ui: {
			setStatus: (key: string, text?: string) => void this.statuses.set(key, text),
			notify: (message: string, level?: string) =>
				void this.notifications.push({ message, level }),
			custom: async () => undefined,
		},
	};

	on(event: string, fn: Handler) {
		const list = this.handlers.get(event) ?? [];
		list.push(fn);
		this.handlers.set(event, list);
	}
	sendMessage(msg: SentMessage["msg"], opts?: Record<string, unknown>) {
		this.sent.push({ msg, opts });
	}
	appendEntry(customType: string, data: unknown) {
		this.entries.push({ customType, data });
	}
	registerTool(def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
		this.tools.set(def.name, def);
	}
	registerCommand(
		name: string,
		def: { handler: (args: string, ctx: unknown) => Promise<void> | void },
	) {
		this.commands.set(name, def);
	}
	getActiveTools() {
		return this.activeTools;
	}
	setActiveTools(tools: string[]) {
		this.activeTools = tools;
	}

	// ── event drivers ──────────────────────────────────────────────────

	async emit(event: string, payload: Record<string, unknown> = {}) {
		for (const fn of this.handlers.get(event) ?? []) {
			await fn({ type: event, ...payload }, this.ctx);
		}
	}

	/** Full invocation: before_agent_start → turn_start → turn_end → agent_end.
	 * agent_end is emitted with streaming=true (the real pi quirk), flipped
	 * false afterward — exactly like pi-agent-core finishRun(). */
	async runInvocation(stopReason: "stop" | "aborted" | "error" = "stop") {
		this.streaming = true;
		await this.emit("before_agent_start", { systemPrompt: "" });
		await this.emit("turn_start", {});
		const message = {
			role: "assistant",
			stopReason,
			usage: { output: 100 },
		};
		await this.emit("turn_end", { message });
		await this.emit("agent_end", { messages: [message] });
		this.streaming = false; // finishRun() — AFTER agent_end processing
	}

	async runInvocationWithContent(
		stopReason: "stop" | "aborted" | "error" | "length",
		content: Array<{ type: string; [k: string]: unknown }>,
		usage: Record<string, number> = { output: 1 },
	) {
		this.streaming = true;
		await this.emit("before_agent_start", { systemPrompt: "" });
		await this.emit("turn_start", {});
		const message = {
			role: "assistant",
			stopReason,
			content,
			usage,
		};
		await this.emit("turn_end", { message });
		await this.emit("agent_end", { messages: [message] });
		this.streaming = false;
	}

	async command(name: string, args: string) {
		const cmd = this.commands.get(name);
		assert.ok(cmd, `command ${name} not registered`);
		await cmd.handler(args, this.ctx);
	}

	continuations() {
		return this.sent.filter((s) => s.msg.customType === "pi-goal:continuation");
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Debounce (30ms) + margin. */
const WAIT = 90;

async function makeExtension() {
	const mod = await import("../index.ts");
	const fake = new FakePi();
	(mod.default as (pi: unknown) => void)(fake as unknown);
	await fake.emit("session_start", {});
	return fake;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("goal loop lifecycle", () => {
	let fake: FakePi;

	beforeEach(async () => {
		fake = await makeExtension();
		await fake.command("goal", "test objective");
		await sleep(5); // first continuation goes out via queueMicrotask
		assert.equal(fake.continuations().length, 1, "first continuation fires on /goal");
	});

	test("REGRESSION(isIdle-at-agent_end): loop continues after a clean turn", async () => {
		await fake.runInvocation("stop");
		// The killer bug: isIdle() is false during agent_end. The schedule must
		// not be gated on it — the continuation must still fire after debounce.
		await sleep(WAIT);
		assert.equal(
			fake.continuations().length,
			2,
			"debounced continuation must fire after a clean turn",
		);
	});

	test("loop keeps continuing across multiple turns", async () => {
		for (let i = 0; i < 3; i++) {
			await fake.runInvocation("stop");
			await sleep(WAIT);
		}
		assert.equal(fake.continuations().length, 4);
	});

	test("REGRESSION(input-suspend): typing does NOT suspend the loop", async () => {
		await fake.emit("input", { text: "steering message" });
		await fake.runInvocation("stop"); // the turn answering the user
		await sleep(WAIT);
		assert.equal(
			fake.continuations().length,
			2,
			"loop must resume after a user-driven turn",
		);
	});

	test("REGRESSION(esc-suspend): abort resumes after grace window", async () => {
		await fake.runInvocation("aborted");
		assert.equal(fake.continuations().length, 1, "not immediately");
		await sleep(150); // > abort grace (60ms) + margin
		assert.equal(
			fake.continuations().length,
			2,
			"loop must resume after the abort grace window",
		);
		assert.ok(
			fake.notifications.some((n) => n.message.includes("goal still active")),
			"user must be told the goal is still active",
		);
	});

	test("REGRESSION(error-suspend): single error retries instead of suspending", async () => {
		await fake.runInvocation("error");
		await sleep(150); // > error retry delay (60ms)
		assert.equal(
			fake.continuations().length,
			2,
			"loop must retry after one transient error",
		);
		assert.ok(
			fake.notifications.some((n) => n.message.includes("retrying")),
			"retry must be visible",
		);
	});

	test("3 consecutive errors suspend LOUDLY", async () => {
		for (let i = 0; i < 3; i++) {
			await fake.runInvocation("error");
			await sleep(150);
		}
		const count = fake.continuations().length;
		await fake.runInvocation("stop");
		await sleep(WAIT);
		assert.equal(fake.continuations().length, count, "suspended: no more continuations");
		assert.ok(
			fake.notifications.some(
				(n) => n.level === "warning" && n.message.includes("suspended"),
			),
			"suspension must be loudly notified",
		);
	});

	test("clean turn resets the error streak", async () => {
		await fake.runInvocation("error");
		await sleep(150);
		await fake.runInvocation("stop"); // clean — resets streak
		await sleep(WAIT);
		await fake.runInvocation("error");
		await sleep(150);
		await fake.runInvocation("error");
		await sleep(150);
		// only 2 consecutive errors — must still be running
		const count = fake.continuations().length;
		await fake.runInvocation("stop");
		await sleep(WAIT);
		assert.ok(fake.continuations().length > count, "loop still alive");
	});

	test("no continuation when messages are pending (that turn reschedules)", async () => {
		fake.pendingMessages = 1;
		await fake.runInvocation("stop");
		await sleep(WAIT);
		assert.equal(fake.continuations().length, 1, "skipped while pending");
		fake.pendingMessages = 0;
		await fake.runInvocation("stop");
		await sleep(WAIT);
		assert.equal(fake.continuations().length, 2, "resumes once pending drains");
	});

	test("queue: completing the active goal promotes the next and continues", async () => {
		await fake.command("goal", "second objective");
		const update = fake.tools.get("update_goal");
		assert.ok(update);
		await update.execute("id", { status: "complete" }, undefined, undefined, fake.ctx);
		await sleep(WAIT);
		const conts = fake.continuations();
		assert.ok(
			conts.some((c) => c.msg.content.includes("second objective")),
			"promoted goal gets its own continuation",
		);
	});

	test("/goal pause stops the loop; /goal resume restarts it", async () => {
		await fake.command("goal", "pause");
		await fake.runInvocation("stop");
		await sleep(WAIT);
		assert.equal(fake.continuations().length, 1, "paused: no continuation");
		await fake.command("goal", "resume");
		await sleep(WAIT);
		assert.ok(fake.continuations().length >= 2, "resume restarts the loop");
	});

	test("REGRESSION(length-stall): length with no tools halts auto-continuation and notifies", async () => {
		const count = fake.continuations().length;
		await fake.runInvocationWithContent("length", [{ type: "thinking", thinking: "The" }]);
		await sleep(WAIT);
		assert.equal(
			fake.continuations().length,
			count,
			"must not auto-continue after a length-no-tools stall",
		);
		assert.ok(
			fake.notifications.some(
				(n) => n.level === "warning" && n.message.includes("truncated"),
			),
			"user must be warned about the stall",
		);
	});

	test("user input clears a length stall", async () => {
		await fake.runInvocationWithContent("length", [{ type: "thinking", thinking: "The" }]);
		await sleep(WAIT);
		const count = fake.continuations().length;
		await fake.emit("input", { text: "compact and continue" });
		await fake.runInvocation("stop");
		await sleep(WAIT);
		assert.ok(
			fake.continuations().length > count,
			"loop must resume after user input clears the stall",
		);
	});

	test("length with tool_use does NOT stall", async () => {
		const count = fake.continuations().length;
		await fake.runInvocationWithContent(
			"length",
			[
				{ type: "thinking", thinking: "Need to run cmd" },
				{ type: "tool_use", name: "bash", input: { command: "echo hi" } },
			],
		);
		await sleep(WAIT);
		assert.equal(
			fake.continuations().length,
			count + 1,
			"length turn that emitted tools is a normal clean turn",
		);
	});
});

// ── Queue robustness ───────────────────────────────────────────────────────

describe("queue lifecycle", () => {
	let fake: FakePi;

	beforeEach(async () => {
		fake = await makeExtension();
	});

	test("three goals chain A→B→C via update_goal completions", async () => {
		await fake.command("goal", "goal A");
		await fake.command("goal", "goal B");
		await fake.command("goal", "goal C");
		await sleep(5);
		const update = fake.tools.get("update_goal")!;

		await update.execute("1", { status: "complete" }, undefined, undefined, fake.ctx);
		await sleep(WAIT);
		assert.ok(
			fake.continuations().some((c) => c.msg.content.includes("goal B")),
			"B activated after A",
		);

		await update.execute("2", { status: "complete" }, undefined, undefined, fake.ctx);
		await sleep(WAIT);
		assert.ok(
			fake.continuations().some((c) => c.msg.content.includes("goal C")),
			"C activated after B",
		);

		// C completes → queue empty → loop stops cleanly.
		await update.execute("3", { status: "complete" }, undefined, undefined, fake.ctx);
		const count = fake.continuations().length;
		await fake.runInvocation("stop");
		await sleep(WAIT);
		assert.equal(fake.continuations().length, count, "no zombie continuations");
	});

	test("/goal next abandons active and starts the queued goal", async () => {
		await fake.command("goal", "goal A");
		await fake.command("goal", "goal B");
		await sleep(5);
		await fake.command("goal", "next");
		await sleep(WAIT);
		assert.ok(
			fake.continuations().some((c) => c.msg.content.includes("goal B")),
			"B gets its continuation after /goal next",
		);
	});

	test("promotion works even while error-suspended", async () => {
		await fake.command("goal", "goal A");
		await fake.command("goal", "goal B");
		await sleep(5);
		// Suspend the loop via 3 consecutive errors.
		for (let i = 0; i < 3; i++) {
			await fake.runInvocation("error");
			await sleep(150);
		}
		// Completing A must still promote B AND clear the suspension.
		const update = fake.tools.get("update_goal")!;
		await update.execute("1", { status: "complete" }, undefined, undefined, fake.ctx);
		await sleep(WAIT);
		assert.ok(
			fake.continuations().some((c) => c.msg.content.includes("goal B")),
			"promotion must clear suspension — queued goal cannot stall",
		);
	});

	test("goal queued while a turn is in flight still activates cleanly", async () => {
		await fake.command("goal", "goal A");
		await sleep(5);
		// Queue B mid-turn (streaming), then finish the turn.
		fake.streaming = true;
		await fake.command("goal", "goal B");
		fake.streaming = false;
		const update = fake.tools.get("update_goal")!;
		await update.execute("1", { status: "complete" }, undefined, undefined, fake.ctx);
		await sleep(WAIT);
		assert.ok(
			fake.continuations().some((c) => c.msg.content.includes("goal B")),
			"mid-flight queued goal activates on completion",
		);
	});

	test("--replace abandons active and starts the new goal immediately", async () => {
		await fake.command("goal", "goal A");
		await sleep(5);
		await fake.command("goal", "--replace goal Z");
		await sleep(WAIT);
		assert.ok(
			fake.continuations().some((c) => c.msg.content.includes("goal Z")),
			"replacement goal starts immediately",
		);
	});
});
