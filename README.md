# pi-goal

Goal tracking extension for [pi](https://github.com/mariozechner/pi-mono) — inspired by [Codex's `/goal` command](https://github.com/openai/codex).

## What it does

Sets an objective for your session that the agent tracks and stays focused on. Like Codex's goal system, but for pi.

### Features

- **`/goal <objective>`** — Set a goal (optionally with `--budget 50k` for token limits)
- **`/goal`** — Interactive goal status menu (pause, resume, complete, clear)
- **`/goal clear|pause|resume|complete|status`** — Quick status changes
- **`goal` tool** — LLM can read/update goal status programmatically
- **System prompt injection** — Active goals are injected into the system prompt to keep the agent focused
- **Footer status** — Shows `🎯 objective [time • tokens]` in the status bar
- **Session persistence** — Goals survive across branches via session entries
- **Token budget** — Optional token budget with auto-pause when exceeded

### Codex Parity

| Codex Feature | pi-goal |
|---|---|
| `/goal <objective>` | ✅ `/goal <objective>` |
| Goal status (active/paused/complete/budget-limited) | ✅ active/paused/complete |
| Token tracking | ✅ Per-turn estimation |
| Token budget | ✅ `--budget 50k` |
| Time tracking | ✅ Elapsed since creation |
| Goal summary menu | ✅ Interactive TUI component |
| Replace confirmation | ✅ Confirms before replacing active goal |
| Clear goal | ✅ `/goal clear` |

## Installation

Copy `src/index.ts` to your pi extensions directory:

```bash
# Global
cp src/index.ts ~/.pi/agent/extensions/pi-goal.ts

# Per-project
cp src/index.ts .pi/extensions/pi-goal.ts
```

## Usage

```
/goal Build a REST API for user management
/goal Build the frontend --budget 100k
/goal          # Show status menu
/goal pause    # Pause the goal
/goal resume   # Resume it
/goal complete # Mark done
/goal clear    # Remove goal
```

The LLM also has access to a `goal` tool and will see the active goal in its system prompt.

## Architecture

Follows pi-mono extension patterns:
- `pi.registerCommand("goal", ...)` — Slash command with subcommand autocomplete
- `pi.registerTool(...)` — LLM-callable tool with custom call/result renderers
- `pi.appendEntry("pi-goal", ...)` — State persistence via session entries
- `pi.on("before_agent_start", ...)` — System prompt injection
- `pi.on("turn_end", ...)` — Token tracking
- `ctx.ui.custom(...)` — Interactive TUI component for goal menu
- `ctx.ui.setStatus("goal", ...)` — Footer status display
