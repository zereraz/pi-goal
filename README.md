# pi-goal

Goal tracking extension for [pi](https://github.com/badlogic/pi-mono) — inspired by [Codex's `/goal`](https://github.com/openai/codex).

Sets an objective and the agent autonomously works toward it, continuing across turns until done.

## How it works

```
/goal Refactor auth module to use JWT
```

1. Sets the goal and sends the objective to the agent
2. Agent works on it, then finishes the turn
3. After 2s idle, a **continuation prompt** auto-sends — agent keeps going
4. Loop continues until the agent calls `update_goal(status: "complete")` or you `/goal pause`

The agent sees the goal in its system prompt every turn, gets `update_goal` and `get_goal` tools, and receives a structured continuation prompt (ported from Codex) that includes objective, time/token budgets, and completion audit instructions.

## Commands

| Command | Action |
|---|---|
| `/goal <objective>` | Set goal, start working |
| `/goal <objective> --budget 50k` | Set goal with token budget |
| `/goal` | Interactive status menu |
| `/goal pause` | Pause (stops auto-continuation) |
| `/goal resume` | Resume (restarts auto-continuation) |
| `/goal clear` | Remove goal |
| `/goal status` | Show status |

## Install

```bash
# Symlink globally (recommended)
ln -s /path/to/pi-goal/src/index.ts ~/.pi/agent/extensions/pi-goal.ts

# Then /reload in any running pi session
```

## What the agent gets

- **System prompt**: Active goal objective, status, time, token budget injected each turn
- **`update_goal` tool**: Can only mark goal `complete` — pause/resume are user-controlled
- **`get_goal` tool**: Read current goal status and budgets
- **Continuation prompt**: Structured message with budget info and completion audit checklist
- **Budget limit prompt**: When token budget exceeded, goal pauses with wrap-up instructions

## Footer

Shows in the status bar:
```
🎯 Refactor auth module to... [2m • 1.5K/50K]
⏸ Refactor auth module to... (paused)
⚠️ Refactor auth module to... (budget limited)
```
