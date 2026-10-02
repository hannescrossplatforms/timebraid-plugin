---
description: Show what this thread is tracking in Timebraid and today's totals.
disable-model-invocation: true
allowed-tools: mcp__plugin_timebraid_timebraid
---

Show the user their Timebraid status in a few short lines:

1. This thread: the task, workspace and project it tracks (from the Timebraid context or your `start_timer` result), or that it is not tracked.
2. Call `list_running` and list the other running timers, one line each with workspace / project / task and how long it has run.
3. Call `today_summary` and give today's total and the hours per workspace.

Use hours and minutes ("3h 20m"). No tables unless there are more than five lines.
