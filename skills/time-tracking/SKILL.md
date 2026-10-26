---
description: Starts and keeps the Timebraid timer for this Claude Code thread. Use before doing any work on a request whenever Timebraid context says no timer is running for the thread, when the work moves to a different project or work item, and when the user asks to start, switch or stop tracking this thread.
allowed-tools: mcp__plugin_timebraid_timebraid
---

# Tracking this thread in Timebraid

Every Claude Code thread is tracked as one timer on one task in Timebraid, so the user's clients and projects get the time the work took. The plugin's hooks handle the clock: they keep the timer alive while the thread is active, start it again on the same task when it stopped during a quiet spell, and stop it when the session ends. Your part is to start the timer on the right task, once, before the work begins.

Timebraid's model: **workspaces** (a client or an area of life) hold **projects**, projects hold **tasks**, and time is **entries** on tasks. Every workspace has a project called **General** for time that has no project yet. Several timers can run at once (one per task), so parallel threads are normal.

## 1. Start the timer before the work

Do this as the first thing in a thread, before reading files or answering at length. It should take one or two tool calls.

**Pick the workspace and project, in this order:**

1. A `.timebraid.json` rule in the context (from the repository) wins unless the request is plainly about something else.
2. A remembered place in the context ("Last time in … this was tracked to …") is a strong hint when the request is about the same work. Use its ids.
3. Otherwise call `list_projects` once (it covers every workspace the user belongs to) and match the request, the folder and repository name, the git remote and any CLAUDE.md against workspace and project names. A client, product or repository name that matches a workspace settles the workspace; a project name that matches settles the project.
4. When the workspace is clear but no project fits, use that workspace's **General** project.
5. When you cannot tell the workspace, ask the user one short question before starting work, with your best guess first, for example: "Which workspace should I track this in: Baker Street Properties, Ridgeline Studio, or Personal?" Start the timer as soon as they answer. Never guess between workspaces, because that bills the wrong client.

**Name the task** for the work item, not the conversation: 2 to 6 words in the user's terms, such as "Login redirect bug", "Weekly report export" or "Q3 budget review". If the project already has a task for the same work item, reuse its exact name (`list_tasks` shows the recent ones); otherwise a new name creates the task.

**Start it:** call `start_timer` with the project id (or the workspace and project names), the task name, and a `note` of one line saying what the user asked for.

**Tell the user in one line**, then get on with the request: "Tracking *Login redirect bug* in Baker Street Properties / Website."

## 2. While the thread runs

- If the Timebraid context says this thread shares the timer of the thread that started it (a helper session), there is nothing to start: the hooks keep that timer alive while you work. Do not start or stop a timer there unless the user asks.
- Do not stop the timer when you finish a reply, and do not call `keep_alive` yourself; the hooks do both. When the thread goes quiet for longer than the workspace allows (15 minutes unless the workspace says otherwise), Timebraid stops the timer and the user decides in the app whether to continue it or keep it stopped.
- If the work clearly moves to a different project or work item, start a timer on the new task. The thread's previous timer stops by itself, because a thread owns one timer at a time.
- If you started under General and the right project becomes clear, start the timer on a task in that project. The time so far stays in General, where the user can move the task with Move to project.
- If `start_timer` says the task is already running (another thread is on it), use a more specific task name for this thread.

## 3. When the user asks

- **Stop tracking this thread:** call `stop_timer` with this thread's entry id (from your `start_timer` result, or the Timebraid context after a compaction). Tracking stays off for the thread until they ask again.
- **Switch:** start a timer on the new project or task as in step 1.
- **What am I tracking:** answer from the context, or call `list_running`.

## 4. When Timebraid is unavailable

If a Timebraid call fails because the plugin is not connected or the token was refused, say so once in one sentence (the user can create a token in Timebraid under Settings, Account, AI assistants, then run `/plugin configure timebraid@timebraid`) and carry on with the work. Never let tracking hold up the request beyond one short question about the workspace.
