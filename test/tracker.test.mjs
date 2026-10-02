import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { onPrompt, onSessionEnd, onSessionStart, onTool, onTurnEnd, TOOL_PREFIX } from '../scripts/lib/tracker.mjs'
import { at, context, entry, fakeClient, MINUTE, refused, T0, tempDir, unreachable } from './helpers.mjs'

const START = `${TOOL_PREFIX}start_timer`
const STOP = `${TOOL_PREFIX}stop_timer`
const input = (over = {}) => ({ session_id: 'thread-a', cwd: '/work/baker', ...over })
const started = (row = entry()) => ({ tool_name: START, tool_input: {}, tool_response: { content: [{ type: 'text', text: 'Started.' }], structuredContent: { entry: row, createdTask: false }, isError: false } })

async function trackedThread(ctx) {
  await onSessionStart(input({ source: 'startup' }), ctx)
  await onPrompt(input({ prompt: 'fix the login redirect' }), ctx)
  await onTool(input(started()), ctx)
  return ctx
}

describe('starting a thread', () => {
  it('asks Claude to start a timer before the first request, and reminds it on each prompt until one runs', async () => {
    const ctx = context()
    const first = await onSessionStart(input({ source: 'startup' }), ctx)
    assert.match(first.context, /No timer is running for this thread yet/)
    assert.match(first.context, /timebraid:time-tracking/)

    const reminder = await onPrompt(input({ prompt: 'fix the login redirect' }), at(ctx, T0 + MINUTE))
    assert.match(reminder.context, /Start one now/)
    assert.equal(ctx.store.session('thread-a').status, 'untracked')
    assert.equal(ctx.client.calls.length, 0)
  })

  it('records the timer Claude starts, remembers the folder, and stops reminding', async () => {
    const ctx = await trackedThread(context())
    const state = ctx.store.session('thread-a')
    assert.deepEqual([state.status, state.entryId, state.taskId, state.workspace, state.project], ['running', 'entry-1', 'task-1', 'Baker Street Properties', 'Website'])
    assert.deepEqual(ctx.store.places()['/work/baker'], { workspaceId: 'ws-1', workspace: 'Baker Street Properties', projectId: 'project-1', project: 'Website', at: T0 })
    assert.deepEqual(await onPrompt(input({ prompt: 'and the logout one' }), at(ctx, T0 + 2 * MINUTE)), {})
  })

  it('offers the remembered folder and a .timebraid.json as hints for the next thread', async () => {
    const ctx = await trackedThread(context())
    const next = await onSessionStart({ session_id: 'thread-b', cwd: '/work/baker/app', source: 'startup' }, ctx)
    assert.match(next.context, /Last time in \/work\/baker this was tracked to Baker Street Properties \/ Website \(workspace id ws-1, project id project-1\)/)

    const repo = tempDir('repo-')
    writeFileSync(join(repo, '.timebraid.json'), JSON.stringify({ workspace: 'Ridgeline Studio', project: 'Brand' }))
    mkdirSync(join(repo, 'src'))
    const ruled = await onSessionStart({ session_id: 'thread-c', cwd: join(repo, 'src'), source: 'startup' }, ctx)
    assert.match(ruled.context, /\.timebraid\.json in .* says: workspace "Ridgeline Studio", project "Brand"/)
  })

  it('ignores a refused start and keeps reminding', async () => {
    const ctx = context()
    await onSessionStart(input({ source: 'startup' }), ctx)
    await onTool(input({ tool_name: START, tool_response: { content: [{ type: 'text', text: 'ambiguous' }], isError: true } }), ctx)
    assert.equal(ctx.store.session('thread-a').status, 'untracked')
  })
})

describe('one timer per thread', () => {
  it('stops the thread\'s previous timer when Claude starts one on other work', async () => {
    const ctx = await trackedThread(context())
    await onTool(input(started(entry({ id: 'entry-2', taskId: 'task-2', task: 'Logout bug' }))), at(ctx, T0 + 5 * MINUTE))
    assert.deepEqual(ctx.client.calls, [{ name: 'stop_timer', args: { entry: 'entry-1' } }])
    assert.equal(ctx.store.session('thread-a').entryId, 'entry-2')
  })

  it('turns tracking off when Claude stops the thread\'s timer, and stops reminding', async () => {
    const ctx = await trackedThread(context())
    const stop = { tool_name: STOP, tool_response: { structuredContent: { stopped: 1, entries: [entry({ endedAt: T0 + MINUTE })] }, isError: false } }
    await onTool(input(stop), at(ctx, T0 + MINUTE))
    assert.equal(ctx.store.session('thread-a').status, 'off')
    assert.deepEqual(await onPrompt(input({ prompt: 'carry on' }), at(ctx, T0 + 2 * MINUTE)), {})
    assert.match((await onSessionStart(input({ source: 'compact' }), at(ctx, T0 + 3 * MINUTE))).context, /Time tracking is off/)
  })
})

describe('breaks', () => {
  it('cuts a break longer than the idle time out of the thread and carries on with the same task', async () => {
    const client = fakeClient({ start_timer: { entry: entry({ id: 'entry-2', startedAt: T0 + 90 * MINUTE }) } })
    const ctx = await trackedThread(context({ client }))
    await onTurnEnd(input(), at(ctx, T0 + 10 * MINUTE))
    const back = await onPrompt(input({ prompt: 'next' }), at(ctx, T0 + 90 * MINUTE))
    assert.deepEqual(back, {})
    assert.deepEqual(client.calls, [
      { name: 'stop_timer', args: { entry: 'entry-1', at: T0 + 25 * MINUTE } },
      { name: 'start_timer', args: { task: 'task-1' } }
    ])
    const state = ctx.store.session('thread-a')
    assert.deepEqual([state.status, state.entryId, state.lastActivity], ['running', 'entry-2', T0 + 90 * MINUTE])
  })

  it('keeps counting a short pause, and the user\'s reading time up to the idle limit', async () => {
    const ctx = await trackedThread(context())
    await onTurnEnd(input(), at(ctx, T0 + 10 * MINUTE))
    await onPrompt(input({ prompt: 'next' }), at(ctx, T0 + 24 * MINUTE))
    assert.equal(ctx.client.calls.length, 0)
    assert.equal(ctx.store.session('thread-a').entryId, 'entry-1')
  })

  it('keeps a long run of tool calls counting, touching at most twice a minute', async () => {
    const ctx = await trackedThread(context())
    const tool = input({ tool_name: 'Bash', tool_response: 'ok' })
    for (let minute = 1; minute <= 60; minute += 1) await onTool(tool, at(ctx, T0 + minute * MINUTE))
    assert.equal(ctx.client.calls.length, 0)
    assert.equal(ctx.store.session('thread-a').lastActivity, T0 + 60 * MINUTE)
  })

  it('cuts the break when a tool call comes after a long wait, such as a permission prompt left open', async () => {
    const client = fakeClient({ start_timer: { entry: entry({ id: 'entry-2' }) } })
    const ctx = await trackedThread(context({ client }))
    await onTool(input({ tool_name: 'Edit', tool_response: 'ok' }), at(ctx, T0 + 60 * MINUTE))
    assert.deepEqual(client.calls.map((call) => call.name), ['stop_timer', 'start_timer'])
    assert.equal(client.calls[0].args.at, T0 + 15 * MINUTE)
  })

  it('leaves the timer alone when the server cannot be reached, and tries again later', async () => {
    const client = fakeClient({ stop_timer: unreachable() })
    const ctx = await trackedThread(context({ client }))
    await onPrompt(input({ prompt: 'next' }), at(ctx, T0 + 60 * MINUTE))
    assert.equal(ctx.store.session('thread-a').entryId, 'entry-1')
    assert.equal(ctx.store.session('thread-a').status, 'running')
  })

  it('treats a timer the server says is no longer running as stopped, and restarts it', async () => {
    const client = fakeClient({ stop_timer: refused('not running any more'), start_timer: { entry: entry({ id: 'entry-3' }) } })
    const ctx = await trackedThread(context({ client }))
    await onPrompt(input({ prompt: 'next' }), at(ctx, T0 + 60 * MINUTE))
    assert.equal(ctx.store.session('thread-a').entryId, 'entry-3')
  })

  it('asks for a new timer when the task is gone, and adopts one that already runs elsewhere', async () => {
    const gone = fakeClient({ start_timer: refused('no task matches') })
    const ctx = await trackedThread(context({ client: gone }))
    const back = await onPrompt(input({ prompt: 'next' }), at(ctx, T0 + 60 * MINUTE))
    assert.match(back.context, /Start one now/)
    assert.equal(ctx.store.session('thread-a').status, 'untracked')

    const running = fakeClient({ start_timer: refused('already running', { entry: entry({ id: 'entry-9' }) }) })
    const other = await trackedThread(context({ client: running }))
    await onPrompt(input({ prompt: 'next' }), at(other, T0 + 60 * MINUTE))
    assert.equal(other.store.session('thread-a').entryId, 'entry-9')
  })
})

describe('ending', () => {
  it('stops the timer when the session ends, at the last activity plus the idle time when that is earlier', async () => {
    const ctx = await trackedThread(context())
    await onTurnEnd(input(), at(ctx, T0 + 20 * MINUTE))
    await onSessionEnd(input({ reason: 'prompt_input_exit' }), at(ctx, T0 + 120 * MINUTE))
    assert.deepEqual(ctx.client.calls, [{ name: 'stop_timer', args: { entry: 'entry-1', at: T0 + 35 * MINUTE } }])
    const state = ctx.store.session('thread-a')
    assert.deepEqual([state.status, state.entryId, state.taskId], ['idle', null, 'task-1'])
  })

  it('picks a resumed thread back up on its next message', async () => {
    const client = fakeClient({ start_timer: { entry: entry({ id: 'entry-2' }) } })
    const ctx = await trackedThread(context({ client }))
    await onSessionEnd(input({ reason: 'other' }), at(ctx, T0 + 5 * MINUTE))
    const resumed = await onSessionStart(input({ source: 'resume' }), at(ctx, T0 + 600 * MINUTE))
    assert.match(resumed.context, /paused after a break/)
    await onPrompt(input({ prompt: 'again' }), at(ctx, T0 + 601 * MINUTE))
    assert.equal(ctx.store.session('thread-a').entryId, 'entry-2')
  })

  it('closes the stale timers of other threads, at most three per event', async () => {
    const ctx = context()
    for (const id of ['old-1', 'old-2', 'old-3', 'old-4']) {
      await onSessionStart({ session_id: id, cwd: '/w', source: 'startup' }, ctx)
      await onTool({ session_id: id, cwd: '/w', ...started(entry({ id: `e-${id}` })) }, ctx)
    }
    await onSessionStart({ session_id: 'fresh', cwd: '/w', source: 'startup' }, at(ctx, T0 + 120 * MINUTE))
    assert.equal(ctx.client.calls.filter((call) => call.name === 'stop_timer').length, 3)
    assert.ok(ctx.client.calls.every((call) => call.args.at === T0 + 15 * MINUTE))
  })
})

describe('not connected', () => {
  it('says so once per thread and never calls the server', async () => {
    const ctx = context({ problem: 'missing-token' })
    assert.match((await onSessionStart(input({ source: 'startup' }), ctx)).context, /not connected: no token is set/)
    assert.deepEqual(await onPrompt(input({ prompt: 'hi' }), ctx), {})
    assert.equal(ctx.client.calls.length, 0)
  })
})
