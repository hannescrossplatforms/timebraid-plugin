---
description: Uses Timebraid, the user's time tracker, on request. Use when the user asks what they tracked today, how many hours went to a client, workspace or project, wants to log time they already spent, wants to see or stop running timers, or asks about their Timebraid workspaces, projects or tasks.
allowed-tools: mcp__plugin_timebraid_timebraid
---

# Using Timebraid

Timebraid tracks time in **workspaces** (usually one per client), which hold **projects**, which hold **tasks**. Time is recorded as **entries** on tasks. Every workspace has a **General** project for time without a project yet. Several timers can run in parallel, one per task; overlapping time is shared fairly between them in Timebraid's reports.

The Timebraid tools reach only the workspaces the user belongs to and only the user's own entries.

## Tools

| Tool | Use it to |
| --- | --- |
| `list_workspaces` | See the workspaces, with each one's budget (hours per day, week or month) and how long an assistant's timer may stay quiet |
| `list_projects` | See the projects, across every workspace or in one |
| `list_tasks` | See a project's tasks, most recently worked first, and which are running |
| `start_timer` | Start a timer on a task (a new task name creates the task) |
| `stop_timer` | Stop one entry, a task's timer, or every running timer of the user |
| `list_running` | See what is running now |
| `log_entry` | Record time already spent, ending now: `45m`, `1h30m`, `1:30` or `0.75` |
| `update_entry` | Change an entry's note |
| `today_summary` | Today's hours, per workspace and project |
| `keep_alive` | Used by the plugin's hooks to keep this thread's timer running; you do not need it |

## How to work with it

- Prefer ids once you have them. Names work too: workspaces and projects match loosely, tasks match exactly.
- When a name matches more than one workspace or project, the tool lists the candidates. Ask the user which one; do not pick.
- A project is never created by a tool. If the user names a project that does not exist, offer General in the right workspace or ask them to create the project in Timebraid.
- Report time the way Timebraid shows it: hours and minutes ("3h 20m"), with the workspace and project.
- Only stop timers the user asked you to stop. Stopping every timer stops the user's timers on their other devices too, so confirm first unless they said "stop everything".
- The timer for the current Claude Code thread is handled by the time-tracking skill; do not stop it when answering a question about other time.
