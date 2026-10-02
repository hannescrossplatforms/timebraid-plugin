---
description: Stop tracking this thread in Timebraid until asked again.
disable-model-invocation: true
allowed-tools: mcp__plugin_timebraid_timebraid
---

Stop the Timebraid timer for this thread.

1. Find this thread's entry id: from your earlier `start_timer` result, or from the Timebraid context ("entry …"). If neither has it, call `list_running` and pick the entry whose task matches this thread's work; if you cannot tell, ask the user which one.
2. Call `stop_timer` with `entry` set to that id. Do not call it without an entry, because that stops every running timer the user has.
3. Confirm in one line: "Stopped tracking this thread (*task*, 1h 20m)." Tracking stays off for this thread until the user runs /timebraid:track.
