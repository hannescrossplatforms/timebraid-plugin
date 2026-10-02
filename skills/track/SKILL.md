---
description: Start or switch the Timebraid timer for this thread, optionally naming the workspace and project.
argument-hint: "[project, or workspace / project]"
disable-model-invocation: true
allowed-tools: mcp__plugin_timebraid_timebraid
---

Track this thread in Timebraid now, following the time-tracking skill.

The user asked for: "$ARGUMENTS"

- If they named a project or a "workspace / project", resolve it with `list_projects` and use it. If it is ambiguous, show the matches and ask which one.
- If they named nothing, pick the workspace and project the way the time-tracking skill describes, and ask if the workspace is unclear.
- Name the task after the work this thread is doing, then call `start_timer`. Any timer the thread was already running stops by itself.
- Confirm in one line: "Tracking *task* in Workspace / Project."
