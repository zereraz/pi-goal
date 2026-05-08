# pi-goal Specification

## Overview

`pi-goal` implements Codex's `/goal` command for pi. It provides autonomous long-running task execution — the agent keeps working toward an objective until it's achieved, paused, cleared, or budget-exhausted.

## Core Behavior: The Continuation Loop

```
/goal <objective>
  → persist goal (status: active)
  → schedule continuation (2s delay)
    → send hidden continuation prompt (display:false, deliverAs:followUp)
      → agent works (visible streaming, tool calls)
        → turn_end: account time + tokens
        → agent_end: schedule next continuation
          → loop repeats
```

**Loop terminates when:**
- Agent calls `update_goal(status: "complete")`
- User runs `/goal pause` or `/goal clear`
- User presses Esc/Ctrl+C (auto-pauses goal)
- Token budget exhausted (status → `budget_limited`, wrap-up prompt sent)
- User sends input during 2s delay (cancels pending continuation)

## Commands

| Command | Behavior |
|---|---|
| `/goal <objective>` | Set new goal, start loop. Confirms replacement if active goal exists. |
| `/goal <objective> --budget 50k` | Set goal with token budget. Supports k/K/m/M suffixes. |
| `/goal` | Interactive menu (pause/resume/complete/clear) |
| `/goal status` | Same as bare `/goal` |
| `/goal pause` | Pause goal, stop continuation loop |
| `/goal resume` | Resume paused/budget-limited/completed goal, restart loop |
| `/goal clear` | Remove goal entirely, clear status bar |

## Tools (LLM-facing)

### `update_goal`

- **Only accepts** `status: "complete"`
- Agent cannot pause/resume/clear — those are user-controlled
- Hidden from LLM when goal is not active (`syncGoalTools`)
- Must report final time and token usage to user on completion

### `get_goal`

- Returns: objective, status, time_used_seconds, tokens_used, token_budget, remaining_tokens
- Read-only, no side effects
- Hidden from LLM when goal is not active

## System Prompt Injection

When goal is active/paused/budget_limited, appended to system prompt each turn:

```
## Active Goal
Objective: <objective>
Status: <status>
Time elapsed: <formatted>
Tokens used: <formatted>
Token budget: <budget> (<remaining> remaining)

Stay focused on this goal. Use update_goal to mark it complete when the objective is achieved.
```

Not injected when goal is `complete`.

## Continuation Prompt (hidden, developer-role equivalent)

Sent as `sendMessage(display:false, triggerTurn:true, deliverAs:followUp)`:

```
Continue working toward the active goal.

<untrusted_objective>
{objective}
</untrusted_objective>

Budget:
- Time spent pursuing goal: {seconds} seconds
- Tokens used: {tokens}
- Token budget: {budget}
- Tokens remaining: {remaining}

Avoid repeating work that is already done.
Choose the next concrete action toward the objective.

Before deciding that the goal is achieved, perform a completion audit:
- Restate the objective as concrete deliverables or success criteria.
- Inspect relevant files, command output, test results, or other real evidence.
- Do not accept proxy signals as completion by themselves.
- Treat uncertainty as not achieved; do more verification or continue the work.

If the objective is achieved, call update_goal with status "complete".
Do not call update_goal unless the goal is actually complete.
```

## Budget Limit Prompt

Sent when `tokensUsed >= tokenBudget`:

```
The active goal has reached its token budget.

<untrusted_objective>
{objective}
</untrusted_objective>

Budget:
- Time spent pursuing goal: {seconds} seconds
- Tokens used: {tokens}
- Token budget: {budget}

The goal is now budget_limited. Do not start new substantive work.
Wrap up: summarize progress, identify remaining work, and leave the user with a clear next step.
Do not call update_goal unless the goal is actually complete.
```

## Status Bar

| Status | Display |
|---|---|
| Active (with budget) | `Pursuing goal (12.5K / 50K)` |
| Active (no budget) | `Pursuing goal (2m)` |
| Paused | `Goal paused (/goal resume)` |
| Budget limited | `Goal unmet (63.9K / 50K tokens)` |
| Complete (with budget) | `Goal achieved (40K tokens)` |
| Complete (no budget) | `Goal achieved (10h 12m)` |
| Cleared | *(nothing)* |

Status persists until explicit `/goal clear`. Never auto-fades.

## Guards & Safety

| Guard | Mechanism |
|---|---|
| Pending user input | `ctx.hasPendingMessages()` — skip continuation |
| Agent busy | `ctx.isIdle()` — don't schedule if streaming |
| Stale goal | `createdAt` check — cancel if goal was replaced during delay |
| User interrupt | `stopReason: "aborted"` detection → auto-pause |
| User types during delay | `input` event → `clearContinuationTimer()` |
| No suppression | No-tool turns still continue (Codex #20523) |

## State Persistence

Stored as pi custom session entries (`customType: "pi-goal"`):

```typescript
interface GoalEntry {
  action: "set" | "update" | "clear";
  goal: Goal | null;
}

interface Goal {
  objective: string;
  status: "active" | "paused" | "complete" | "budget_limited";
  createdAt: number;      // epoch ms — also serves as goal ID
  updatedAt: number;      // epoch ms
  tokensUsed: number;     // actual from usage, fallback +500/turn
  tokenBudget: number | null;
  timeUsedMs: number;     // wall-clock while active
}
```

Reconstructed from session branch on startup/tree navigation.

## Tool Visibility

`get_goal` and `update_goal` are dynamically shown/hidden via `pi.setActiveTools()`:
- **Visible** when `goal.status === "active"`
- **Hidden** otherwise (prevents LLM from calling them on unrelated turns)

## Validation

- Objective: max 4000 characters
- Blank lines collapsed (`/\n{3,}/g` → `\n\n`)
- Empty objective rejected
- Token budget must be positive (via suffix parsing)

## Differences from Codex

| Aspect | Codex | pi-goal |
|---|---|---|
| Continuation delivery | Hidden user-role with `<goal_context>` tags (changed May 8 from developer-role) | `sendMessage(display:false, deliverAs:followUp)` |
| Token accounting | Per-tool-call from state DB, blended (excludes cache) | Per-turn from `event.message.usage` |
| Continuation delay | Immediate (task system) | 2s setTimeout |
| Paused goal on resume | Prompts user "Resume goal?" or "Leave paused" | Auto-resumes |
| `/goal resume` on complete | Requires re-setting same objective | Allowed (re-activates loop) |
| Plan mode | Pauses goals | N/A (pi has no plan mode) |
| Thread materialization | Yes (for `/resume` listing) | N/A (pi sessions work differently) |
| Objective too long | Shows file-reference guidance | Shows character count error |
| Lifecycle metrics | OpenTelemetry counters + histograms | None |

## Codex Design Decisions (from PR discussions)

### "Keep paused goals paused on thread resume" (#20790)
Early adopters reported that explicitly pausing a goal should survive thread resume. Codex now asks the user via TUI prompt whether to resume or leave paused. We auto-resume for simplicity but could adopt this.

### "Remove no-tool goal continuation suppression" (#20523)
The heuristic "stop continuation after a no-tool turn" caused goals to stop short. Users reported the agent could still make progress. Codex removed all suppression — the loop never stops unless update_goal(complete), pause, clear, or budget.

### "Move goal prompts to hidden user context" (May 8, 2026)
Goal continuation/budget prompts moved from `developer` role to `user` role wrapped in `<goal_context>` tags. This makes them invisible in the TUI transcript while still being in the LLM context as user messages. Our `display:false` achieves the same effect through pi's custom message system.

### "Validate /goal objective length in TUI" (#20746)
Long pasted objectives hit lower-level validation with opaque errors. TUI now validates locally with a goal-specific message recommending putting long instructions in a file. We validate at 4000 chars.

### "Display blended token count" (#21669)
Session token displays now exclude cached input tokens to avoid confusion. Goals track blended totals. Our per-turn `usage.totalTokens` may include cache — acceptable approximation.
