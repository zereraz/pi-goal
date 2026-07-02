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

Messages you type while a goal is active are treated as **steering within the goal** — the agent answers, then the loop resumes with your input absorbed as context. Only **Esc** (interrupt) or 3 consecutive turn errors suspend the loop (with a visible notification); `/goal continue` resumes it.

The agent sees the active goal in its system prompt every turn, gets `update_goal` and `get_goal` tools, and receives a structured continuation prompt with the objective and completion audit instructions.

### Stacking goals (queue)

You don't have to wait for the current goal to finish before queuing the next one — like adding commits to a branch while CI is running:

```
/goal Refactor auth          ← starts immediately, loop running
/goal Add rate limiting      ← queued silently behind the active goal
/goal Write docs             ← queued silently behind that
```

The agent stays focused on the active goal. New `/goal` invocations join a simple FIFO queue and never interrupt ongoing work. When the active goal completes (`update_goal`) — or you run `/goal next` to skip it — pi-goal automatically promotes the next queued goal (earliest first) and starts the continuation loop on it.

There's no `Replace goal?` confirmation — a new `/goal` is appended to the queue, not a replacement. Use `/goal --replace <objective>` if you explicitly want to abandon the active goal and start fresh.

## Commands

| Command | Action |
|---|---|
| `/goal <objective>` | Add goal. Becomes active if no active goal; otherwise queued behind the active one. |
| `/goal --replace <objective>` | Abandon the active goal and start this one immediately |
| `/goal --queue <objective>` | Force-queue, even if nothing is active |
| `/goal` | Interactive menu (active goal + queue) |
| `/goal pause` | Pause the active goal |
| `/goal resume` | Resume the most recent paused goal (or activate the next queued one) |
| `/goal next` / `/goal skip` | Abandon the active goal and advance to the next queued one |
| `/goal continue` | Re-enable continuation nudges after Esc or repeated errors |
| `/goal complete` | Mark the active goal complete |
| `/goal clear` | Clear **all** goals |
| `/goal status` | Show status |

## What the agent gets

- **System prompt**: Goal objective + status injected each turn (only while a goal is active)
- **`update_goal` tool**: Mark goal `complete` — pause/resume are user-controlled
- **`get_goal` tool**: Read the active goal and the queue
- **Continuation prompt**: Objective + completion audit checklist, re-sent after each idle turn

## Footer status

```
🎯 Goal active (2m) [+2 queued]
⏸ Goal paused
✅ Goal complete
```
