import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { onPrompt, onSessionEnd, onSessionStart, onTool, onToolStart, onTurnEnd, TOOL_PREFIX } from '../scripts/lib/tracker.mjs'
import { at, context, entry, fakeClient, MINUTE, refused, T0, tempDir, unreachable } from './helpers.mjs'

const START = `${TOOL_PREFIX}start_timer`
const STOP = `${TOOL_PREFIX}stop_timer`
const input = (over = {}) => ({ session_id: 'thread-a', cwd: '/work/baker', ...over })
const started = (row = entry()) => ({ tool_name: START, tool_input: {}, tool_response: { content: [{ type: 'text', text: 'Started.' }], structuredContent: { entry: row, createdTask: false }, isError: false } })
const bash = (tool_input = {}) => input({ tool_name: 'Bash', tool_input: { command: 'npm test', ...tool_input }, tool_response: 'ok' })
const names = (client) => client.calls.map((call) => call.name)
const beats = (client) => client.calls.filter((call) => call.name === 'keep_alive')
const stopsAfterFirstBeat = (message, data) => (args, count) => (args.entry === 'entry-1' && count > 1 ? refused(message, data) : {})

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

  it('records the timer Claude starts, keeps it alive, remembers the folder, and stops reminding', async () => {
    const ctx = await trackedThread(context())
    const state = ctx.store.session('thread-a')
    assert.deepEqual([state.status, state.entryId, state.taskId, state.workspace, state.project], ['running', 'entry-1', 'task-1', 'Baker Street Properties', 'Website'])
    assert.deepEqual(ctx.client.calls, [{ name: 'keep_alive', args: { entry: 'entry-1' } }])
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
    assert.deepEqual(ctx.client.calls.slice(1), [
      { name: 'stop_timer', args: { entry: 'entry-1' } },
      { name: 'keep_alive', args: { entry: 'entry-2' } }
    ])
    assert.equal(ctx.store.session('thread-a').entryId, 'entry-2')
  })

  it('turns tracking off when Claude stops the thread\'s timer, and stops reminding', async () => {
    const ctx = await trackedThread(context())
    const stop = { tool_name: STOP, tool_response: { structuredContent: { stopped: 1, entries: [entry({ endedAt: T0 + MINUTE })] }, isError: false } }
    await onTool(input(stop), at(ctx, T0 + MINUTE))
    assert.equal(ctx.store.session('thread-a').status, 'off')
    assert.deepEqual(await onPrompt(input({ prompt: 'carry on' }), at(ctx, T0 + 2 * MINUTE)), {})
    await onTool(bash(), at(ctx, T0 + 30 * MINUTE))
    assert.deepEqual(names(ctx.client), ['keep_alive'])
    assert.match((await onSessionStart(input({ source: 'compact' }), at(ctx, T0 + 3 * MINUTE))).context, /Time tracking is off/)
  })
})

describe('keeping the timer alive while Claude works', () => {
  it('tells Timebraid the thread is alive every five minutes of tool work, and touches the clock at most twice a minute', async () => {
    const ctx = await trackedThread(context())
    for (let minute = 1; minute <= 60; minute += 1) await onTool(bash(), at(ctx, T0 + minute * MINUTE))
    assert.equal(beats(ctx.client).length, 13)
    assert.equal(ctx.store.session('thread-a').lastActivity, T0 + 60 * MINUTE)
  })

  it('beats more often when the workspace stops quiet timers sooner, using the expiry Timebraid sends', async () => {
    let expires = T0 + 6 * MINUTE
    const client = fakeClient({ keep_alive: () => ({ expiresAt: expires }) })
    const ctx = await trackedThread(context({ client }))
    assert.equal(ctx.store.session('thread-a').leaseUntil, T0 + 6 * MINUTE)
    expires = T0 + 8 * MINUTE
    await onTool(bash(), at(ctx, T0 + MINUTE))
    await onTool(bash(), at(ctx, T0 + 2 * MINUTE))
    assert.equal(beats(client).length, 2)
    assert.equal(ctx.store.session('thread-a').leaseUntil, T0 + 8 * MINUTE)
  })

  it('beats at the end of each turn, so the quiet time counts from Claude\'s last reply', async () => {
    const ctx = await trackedThread(context())
    await onTurnEnd(input(), at(ctx, T0 + 10 * MINUTE))
    await onTurnEnd(input(), at(ctx, T0 + 10 * MINUTE + 20 * 1000))
    assert.equal(beats(ctx.client).length, 2)
    assert.equal(ctx.store.session('thread-a').leaseUntil, T0 + 25 * MINUTE)
  })

  it('asks for a longer lease before a command that may outlast the current one, and only then', async () => {
    const ctx = await trackedThread(context())
    await onToolStart(bash({ timeout: 600000 }), at(ctx, T0 + 4 * MINUTE))
    await onToolStart(bash(), at(ctx, T0 + 6 * MINUTE))
    await onToolStart(bash({ timeout: 600000, run_in_background: true }), at(ctx, T0 + 6 * MINUTE))
    await onToolStart(input({ tool_name: 'Agent', tool_input: { prompt: 'look around' } }), at(ctx, T0 + 6 * MINUTE))
    assert.equal(beats(ctx.client).length, 1)

    await onToolStart(bash({ timeout: 600000 }), at(ctx, T0 + 6 * MINUTE))
    assert.deepEqual(ctx.client.calls.at(-1), { name: 'keep_alive', args: { entry: 'entry-1', busyMinutes: 10 } })
    assert.equal(ctx.store.session('thread-a').leaseUntil, T0 + 31 * MINUTE)
  })
})

describe('when the thread went quiet', () => {
  it('carries on with a new timer on the same task when Timebraid stopped the quiet one, and tells Claude the new entry', async () => {
    const client = fakeClient({
      keep_alive: stopsAfterFirstBeat('not running any more', { entry: entry({ endedAt: T0 + 25 * MINUTE, autoStop: 'pending' }) }),
      start_timer: { entry: entry({ id: 'entry-2', startedAt: T0 + 90 * MINUTE }) }
    })
    const ctx = await trackedThread(context({ client }))
    const back = await onPrompt(input({ prompt: 'next' }), at(ctx, T0 + 90 * MINUTE))
    assert.match(back.context, /entry entry-2/)
    assert.deepEqual(client.calls.slice(1), [
      { name: 'keep_alive', args: { entry: 'entry-1' } },
      { name: 'start_timer', args: { task: 'task-1' } },
      { name: 'keep_alive', args: { entry: 'entry-2' } }
    ])
    const state = ctx.store.session('thread-a')
    assert.deepEqual([state.status, state.entryId, state.lastActivity], ['running', 'entry-2', T0 + 90 * MINUTE])
  })

  it('also restarts it during tool work, as after a permission prompt left open', async () => {
    const client = fakeClient({ keep_alive: stopsAfterFirstBeat('not running any more'), start_timer: { entry: entry({ id: 'entry-2' }) } })
    const ctx = await trackedThread(context({ client }))
    await onTool(bash(), at(ctx, T0 + 60 * MINUTE))
    assert.deepEqual(names(client), ['keep_alive', 'keep_alive', 'start_timer', 'keep_alive'])
    assert.equal(ctx.store.session('thread-a').entryId, 'entry-2')
  })

  it('takes over the earlier timer when the user continued it in Timebraid and the newer one is gone', async () => {
    const client = fakeClient({ keep_alive: stopsAfterFirstBeat('unknown entry'), start_timer: refused('already running', { entry: entry({ id: 'entry-0' }) }) })
    const ctx = await trackedThread(context({ client }))
    await onPrompt(input({ prompt: 'next' }), at(ctx, T0 + 30 * MINUTE))
    assert.equal(ctx.store.session('thread-a').entryId, 'entry-0')
  })

  it('leaves the timer alone when the server cannot be reached, and tries again later', async () => {
    const client = fakeClient({ keep_alive: (args, count) => (count > 1 ? unreachable() : {}) })
    const ctx = await trackedThread(context({ client }))
    await onPrompt(input({ prompt: 'next' }), at(ctx, T0 + 60 * MINUTE))
    const state = ctx.store.session('thread-a')
    assert.deepEqual([state.status, state.entryId], ['running', 'entry-1'])
  })

  it('asks for a new timer when the task is gone', async () => {
    const client = fakeClient({ keep_alive: stopsAfterFirstBeat('not running any more'), start_timer: refused('no task matches') })
    const ctx = await trackedThread(context({ client }))
    const back = await onPrompt(input({ prompt: 'next' }), at(ctx, T0 + 60 * MINUTE))
    assert.match(back.context, /Start one now/)
    assert.equal(ctx.store.session('thread-a').status, 'untracked')
  })
})

describe('ending', () => {
  it('stops the timer as an automatic stop when the session ends, at the end of the quiet time when that is earlier', async () => {
    const ctx = await trackedThread(context())
    await onTurnEnd(input(), at(ctx, T0 + 20 * MINUTE))
    await onSessionEnd(input({ reason: 'prompt_input_exit' }), at(ctx, T0 + 120 * MINUTE))
    assert.deepEqual(ctx.client.calls.at(-1), { name: 'stop_timer', args: { entry: 'entry-1', at: T0 + 35 * MINUTE, automatic: true } })
    const state = ctx.store.session('thread-a')
    assert.deepEqual([state.status, state.entryId, state.taskId], ['idle', null, 'task-1'])

    const soon = await trackedThread(context())
    await onSessionEnd(input({ reason: 'other' }), at(soon, T0 + 3 * MINUTE))
    assert.deepEqual(soon.client.calls.at(-1).args, { entry: 'entry-1', at: T0 + 3 * MINUTE, automatic: true })
  })

  it('stops at the server\'s now when it refuses the time, as when this machine\'s clock runs ahead', async () => {
    const client = fakeClient({ stop_timer: (args) => (args.at === undefined ? { stopped: 1, entries: [entry()] } : refused('at is in the future; it may be at most 60 seconds ahead.')) })
    const ctx = await trackedThread(context({ client }))
    await onSessionEnd(input({ reason: 'other' }), at(ctx, T0 + 5 * MINUTE))
    assert.deepEqual(client.calls.slice(1).map((call) => call.args), [
      { entry: 'entry-1', at: T0 + 5 * MINUTE, automatic: true },
      { entry: 'entry-1', automatic: true }
    ])
    assert.equal(ctx.store.session('thread-a').status, 'idle')
  })

  it('picks a resumed thread back up on its next message', async () => {
    const client = fakeClient({ start_timer: { entry: entry({ id: 'entry-2' }) } })
    const ctx = await trackedThread(context({ client }))
    await onSessionEnd(input({ reason: 'other' }), at(ctx, T0 + 5 * MINUTE))
    const resumed = await onSessionStart(input({ source: 'resume' }), at(ctx, T0 + 600 * MINUTE))
    assert.match(resumed.context, /stopped while the thread was quiet or closed/)
    await onPrompt(input({ prompt: 'again' }), at(ctx, T0 + 601 * MINUTE))
    assert.equal(ctx.store.session('thread-a').entryId, 'entry-2')
  })

  it('hands the running timer to the fresh thread after /clear instead of stopping it', async () => {
    const ctx = await trackedThread(context())
    await onSessionEnd(input({ reason: 'clear' }), at(ctx, T0 + 5 * MINUTE))
    const fresh = await onSessionStart({ session_id: 'thread-b', cwd: '/work/baker', source: 'clear' }, at(ctx, T0 + 5 * MINUTE + 1000))
    assert.match(fresh.context, /tracked in Timebraid: "Login redirect bug" in Baker Street Properties \/ Website, entry entry-1/)
    assert.equal(names(ctx.client).includes('stop_timer'), false)
    assert.equal(ctx.store.session('thread-b').entryId, 'entry-1')
    assert.equal(ctx.store.session('thread-a').status, 'idle')

    const later = await trackedThread(context())
    await onSessionEnd(input({ reason: 'clear' }), at(later, T0 + 5 * MINUTE))
    const stale = await onSessionStart({ session_id: 'thread-c', cwd: '/work/baker', source: 'clear' }, at(later, T0 + 10 * MINUTE))
    assert.match(stale.context, /No timer is running/)
  })

  it('forgets threads untouched for a month', async () => {
    const ctx = await trackedThread(context())
    await onSessionStart({ session_id: 'thread-z', cwd: '/w', source: 'startup' }, at(ctx, T0 + 31 * 24 * 60 * MINUTE))
    assert.equal(ctx.store.session('thread-a'), null)
    assert.notEqual(ctx.store.session('thread-z'), null)
  })
})

describe('not connected', () => {
  it('says so once per thread and never calls the server', async () => {
    const ctx = context({ problem: 'missing-token' })
    assert.match((await onSessionStart(input({ source: 'startup' }), ctx)).context, /not connected: no token is set/)
    assert.deepEqual(await onPrompt(input({ prompt: 'hi' }), ctx), {})
    await onTool(bash(), ctx)
    await onTurnEnd(input(), ctx)
    assert.equal(ctx.client.calls.length, 0)
  })
})
