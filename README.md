# pi-goal

Codex-like `/goal` command for [pi](https://github.com/badlogic/pi-mono) — autonomous goal tracking with continuation loops.

## Install

```bash
pi install npm:@sahebjot94/pi-goal
```

Or via git:

```bash
pi install https://github.com/zereraz/pi-goal
```

Temporarily (without installing):

```bash
pi -e git:github.com/zereraz/pi-goal
```

## How it works

```
/goal Refactor auth module to use JWT
```

1. Sets the goal and sends the objective to the agent
2. Agent works on it, finishes the turn
3. After 2s idle, a **continuation prompt** auto-sends — agent keeps going
4. Loop continues until the agent calls `update_goal(status: "complete")` or you `/goal pause`

The agent sees the active goal in its system prompt every turn, gets `update_goal` and `get_goal` tools, and receives a structured continuation prompt (ported from Codex) with objective, budgets, and completion audit instructions.

### Stacking goals (DAG)

You don't have to wait for the current goal to finish before queuing the next one — like adding commits to a branch while CI is running:

```
/goal Refactor auth          ← starts immediately, loop running
/goal Add rate limiting      ← queued silently behind the active goal
/goal Write docs             ← queued silently behind that
```

The agent stays focused on the active goal. New `/goal` invocations land in the DAG with a dependency on the currently active goal, and never interrupt ongoing work. When the active goal completes (`update_goal`), pi-goal automatically promotes the next ready queued goal (one whose dependencies are all `complete`) and starts the continuation loop on it.

There's no `Replace goal?` confirmation anymore — you're adding a node to a graph, not replacing a single slot.

## Commands

| Command | Action |
|---|---|
| `/goal <objective>` | Add goal. Becomes active if no active goal; otherwise queued behind the active one. |
| `/goal <objective> --budget 50k` | Same, with token budget |
| `/goal` | Interactive DAG menu |
| `/goal pause` | Pause the active goal |
| `/goal resume` | Resume the most recent non-complete goal (or activate a ready queued one) |
| `/goal clear` | Clear **all** goals |
| `/goal status` | Show status |

## What the agent gets

- **System prompt**: Goal objective, status, time/token budget injected each turn
- **`update_goal` tool**: Mark goal `complete` — pause/resume are user-controlled
- **`get_goal` tool**: Read current goal status and budgets
- **Continuation prompt**: Budget info + completion audit checklist (from Codex)
- **Budget limit**: When token budget exceeded, goal auto-pauses with wrap-up instructions

## Footer status

```
🎯 Refactor auth module to... [2m • 1.5K/50K] [+2 queued]
⏸ Refactor auth module to... (paused)
⚠️ Refactor auth module to... (budget limited)
```
