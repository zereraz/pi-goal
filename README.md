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

The agent sees the goal in its system prompt every turn, gets `update_goal` and `get_goal` tools, and receives a structured continuation prompt (ported from Codex) with objective, budgets, and completion audit instructions.

## Commands

| Command | Action |
|---|---|
| `/goal <objective>` | Set goal, start working |
| `/goal <objective> --budget 50k` | Set goal with token budget |
| `/goal` | Interactive status menu |
| `/goal pause` | Pause (stops continuation) |
| `/goal resume` | Resume (restarts continuation) |
| `/goal clear` | Remove goal |
| `/goal status` | Show status |

## What the agent gets

- **System prompt**: Goal objective, status, time/token budget injected each turn
- **`update_goal` tool**: Mark goal `complete` — pause/resume are user-controlled
- **`get_goal` tool**: Read current goal status and budgets
- **Continuation prompt**: Budget info + completion audit checklist (from Codex)
- **Budget limit**: When token budget exceeded, goal auto-pauses with wrap-up instructions

## Footer status

```
🎯 Refactor auth module to... [2m • 1.5K/50K]
⏸ Refactor auth module to... (paused)
⚠️ Refactor auth module to... (budget limited)
```
