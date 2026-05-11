# pi-goal Specification

## Overview

`pi-goal` implements Codex's `/goal` command for pi, extended with a **goal DAG** so users can keep adding objectives without waiting for the current one to finish — like pushing commits to a branch while CI is running. The active goal is never interrupted by new `/goal` invocations; new goals are silently enqueued and activated in order as earlier goals complete.

## Core Behavior: The Continuation Loop + DAG

```
/goal <objective>                         (no active goal)
  → add goal to DAG as active
  → schedule continuation (2s delay)
    → hidden continuation prompt
      → agent works → turn_end → account time+tokens
        → agent_end → schedule next continuation → loop

/goal <another>                           (while previous is active)
  → add goal to DAG as queued with dependency on active goal
  → do NOT interrupt the active loop
  → no confirmation prompt — it's just a new DAG node

active goal: update_goal(status:"complete")
  → mark complete → find next ready queued goal
  → promote to active → restart continuation loop on it
```

**Active-goal loop terminates when:**
- Agent calls `update_goal(status: "complete")` — next ready goal in the DAG (if any) activates automatically
- User runs `/goal pause` or `/goal clear`
- User presses Esc/Ctrl+C (auto-pauses active goal)
- Token budget exhausted (status → `budget_limited`, wrap-up prompt sent)
- User sends input during 2s delay (cancels pending continuation)

## Commands

| Command | Behavior |
|---|---|
| `/goal <objective>` | Add goal to DAG. If no active goal, it becomes active immediately. Otherwise it's enqueued with a dependency on the active goal. **No confirmation prompt** — new goals never replace or interrupt existing ones. |
| `/goal <objective> --budget 50k` | Same as above, with token budget. Supports k/K/m/M suffixes. |
| `/goal` | Interactive DAG menu (pause/resume/complete active / clear all) |
| `/goal status` | Same as bare `/goal` |
| `/goal pause` | Pause active goal, stop continuation loop |
| `/goal resume` | Re-activate the most recent non-complete goal (or promote a ready queued one) |
| `/goal clear` | Remove **all** goals, clear status bar |

## Tools (LLM-facing)

### `update_goal`

- **Only accepts** `status: "complete"`
- Operates on the **active** goal only
- Completing the active goal triggers automatic promotion of the next ready queued goal
- Agent cannot pause/resume/clear — those are user-controlled
- Hidden from LLM when no goal is active (`syncGoalTools`)
- Must report final time and token usage to user on completion

### `get_goal`

- Returns: `active` (or null), `dag` (all goals with id, status, dependencies, time/token usage), `queued_count`
- Read-only, no side effects
- Hidden from LLM when no goal is active

## System Prompt Injection

When a goal is active/paused/budget_limited, appended to system prompt each turn (active goal only):

```
## Active Goal
Objective: <objective>
Status: <status>
Time elapsed: <formatted>
Tokens used: <formatted>
Token budget: <budget> (<remaining> remaining)
Queued goals waiting: <n>

Stay focused on this goal. Use update_goal to mark it complete when the
objective is achieved. When you complete this goal, the next queued goal
(if any) will activate automatically — do not switch focus until then.
```

Only the active goal is injected; queued goals are not surfaced to the agent beyond the count, so focus is preserved.

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
| Active (with budget) | `Pursuing goal (12.5K / 50K) [+2 queued]` |
| Active (no budget) | `Pursuing goal (2m) [+1 queued]` |
| Paused | `Goal paused (/goal resume)` |
| Budget limited | `Goal unmet (63.9K / 50K tokens)` |
| Complete (with budget) | `Goal achieved (40K tokens)` |
| Complete (no budget) | `Goal achieved (10h 12m)` |
| No active, DAG non-empty | `Goal DAG idle [+N queued]` |
| Cleared | *(nothing)* |

Status persists until explicit `/goal clear`. Never auto-fades.

## Guards & Safety

| Guard | Mechanism |
|---|---|
| Pending user input | `ctx.hasPendingMessages()` — skip continuation |
| Agent busy | `ctx.isIdle()` — don't schedule if streaming |
| Stale goal | `goal.id` check — cancel if active changed/cleared during delay |
| User interrupt | `stopReason: "aborted"` detection → auto-pause active goal |
| User types during delay | `input` event → `clearContinuationTimer()` |
| Queued goal promotion | only promoted when dependencies are all `complete` (missing deps treated as satisfied) |
| No suppression | No-tool turns still continue (Codex #20523) |
| No replace prompt | DAG model — new goals are nodes, not replacements; the old `Replace goal?` confirmation has been removed |

## State Persistence

Stored as pi custom session entries (`customType: "pi-goal"`). Each mutation snapshots the entire DAG so replay is trivial (just take the last entry):

```typescript
interface GoalEntry {
  action: "add" | "update" | "activate" | "complete" | "clear";
  goals: Goal[];  // full DAG snapshot after the action
}

interface Goal {
  id: string;             // stable, unique within session
  objective: string;
  status: "active" | "queued" | "paused" | "complete" | "budget_limited";
  dependencies: string[]; // goal ids that must complete before this can run
  createdAt: number;
  updatedAt: number;
  tokensUsed: number;     // actual from usage, fallback +500/turn
  tokenBudget: number | null;
  timeUsedMs: number;     // wall-clock while active
}
```

**DAG invariants:**
- At most one goal has `status: "active"` at any time.
- `/goal <obj>` appends a new node. If some goal is active, the new node gets `dependencies: [activeId]` and `status: "queued"`, forming an implicit chain.
- When the active goal transitions out of `active` (complete/paused/cleared/budget_limited), `maybePromoteNext` picks the earliest-created queued goal whose dependencies are all complete (or absent from the DAG) and activates it.

Reconstructed from session branch on startup/tree navigation.

## Tool Visibility

`get_goal` and `update_goal` are dynamically shown/hidden via `pi.setActiveTools()`:
- **Visible** whenever any goal has `status: "active"`
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
