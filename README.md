# Timebraid for Claude Code

Every Claude Code chat thread becomes a timer in [Timebraid](https://github.com/hannescrossplatforms/tally-site), on a task in the right workspace and project. Claude can also log time, show what is running and give you today's totals.

## Install

1. In Timebraid, open **Settings, Account, AI assistants** and choose **Connect an assistant**. Copy the token. It starts with `tally_mcp_` and is shown once.
2. In Claude Code:

   ```
   /plugin marketplace add hannescrossplatforms/timebraid-plugin
   /plugin install timebraid@timebraid
   ```

   Paste the token when it asks. To change it later: `/plugin configure timebraid@timebraid`.
3. Start a new chat. Claude starts a timer before it begins on your first request.

Claude Code asks before it uses a tool for the first time. Choose "don't ask again" for the Timebraid tools, or add this to the `permissions.allow` list in `~/.claude/settings.json`:

```json
"mcp__plugin_timebraid_timebraid"
```

The hooks need Node.js 18 or newer on your `PATH`.

## What happens in a thread

1. **Before the work.** When a thread starts, Claude is told that no timer is running. Before it works on your first request it picks the workspace and project, names a task after the work ("Login redirect bug"), starts the timer and tells you in one line what it is tracking.
2. **Choosing where the time goes.**
   - A `.timebraid.json` in the repository wins: `{ "workspace": "Baker Street Properties", "project": "Website" }`.
   - Otherwise the folder's last place is a hint: the plugin remembers where each folder was tracked.
   - Otherwise Claude matches your request, the folder, the repository and its CLAUDE.md against your workspaces and projects.
   - With the workspace clear but no project, the time goes to that workspace's **General** project. You can move the task later with Move to project.
   - With the workspace unclear, Claude asks you once before it starts.
3. **During the thread.** A thread owns one timer. If the work moves to another project, Claude starts a new timer and the old one stops.
4. **Breaks.** After Claude's last reply the thread keeps counting while you read, up to the break time (15 minutes by default). If you come back later, the time beyond that is cut and a new entry starts on the same task. A long run of tool calls keeps counting.
5. **The end.** When the session ends, the timer stops at your last activity plus the break time. A resumed thread carries on with the same task on its next message. Timers left behind by a thread that was never closed are trimmed the next time any thread starts or you send a prompt.

Parallel threads run parallel timers, and Timebraid's reports share overlapping time between them fairly.

## Commands

| Command | Does |
| --- | --- |
| `/timebraid:track [project]` | Start or switch this thread's timer, optionally naming `workspace / project` |
| `/timebraid:off` | Stop tracking this thread until you ask again |
| `/timebraid:status` | This thread's task, the other running timers and today's totals |

You can also just ask: "log 45 minutes to Baker Street for the call", "how many hours did Ridgeline get this week?", "what is running?".

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Timebraid token | none | Your personal token, kept in your system keychain |
| Timebraid server | `https://backend-production-e532.up.railway.app` | Change only for a self-hosted server |
| Break after (minutes) | 15 | How long a thread keeps counting after Claude's last reply |

## Security

- The token reaches only the workspaces you belong to, and only your own entries. Leaving a workspace cuts its access on the next call.
- Timebraid stores only a SHA-256 digest of the token. Revoke it any time under Settings, Account, AI assistants.
- Claude Code keeps the token in your system keychain. The hooks read it from their environment and never write it to disk or to the log.
- The plugin talks only to the Timebraid server, over https (plain http is allowed for `localhost` only).
- Local state lives in Claude Code's plugin data folder: one small file per thread (task and entry ids, last activity), the remembered places, and a short log without tokens or prompts.

## How it is built

| Part | Path |
| --- | --- |
| MCP server (Timebraid's API, `POST /mcp`) | `.mcp.json` |
| Hooks that keep the clock | `hooks/hooks.json`, `scripts/hook.mjs`, `scripts/lib/` |
| Tracking protocol Claude follows | `skills/time-tracking/SKILL.md` |
| Using Timebraid on request | `skills/timebraid/SKILL.md` |
| Commands | `skills/track`, `skills/off`, `skills/status` |

The hooks never block Claude: they exit cleanly on any error and log it to `hook.log` in the plugin data folder.

## Troubleshooting

- **Claude says Timebraid is not connected.** Set the token with `/plugin configure timebraid@timebraid`.
- **No timer starts.** Run `/mcp` and check that `plugin:timebraid:timebraid` is connected. A `401` means the token was revoked.
- **The server answers 404 at `/mcp`.** The MCP endpoint is switched off on that server (`MCP_ENABLED`).

## Development

```
npm test                                   # node:test, no dependencies
claude plugin validate --strict .
claude --plugin-dir .                      # try it in one session
```
