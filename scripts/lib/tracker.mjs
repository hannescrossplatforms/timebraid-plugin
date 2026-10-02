import * as say from './context.mjs'
import { folderRule, rememberedPlace } from './hints.mjs'
import { freshState, STATE_VERSION } from './store.mjs'
import { resultOf } from './timebraid.mjs'

export const TOOL_PREFIX = 'mcp__plugin_timebraid_timebraid__'
const SWEEP_LIMIT = 3
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000
const TOUCH_MS = 30 * 1000

function load(input, ctx) {
  const held = ctx.store.session(input.session_id)
  if (held && held.version === STATE_VERSION) return { ...held, cwd: input.cwd || held.cwd }
  return freshState(input.session_id, input.cwd || '', ctx.now)
}

function save(state, ctx) {
  ctx.store.saveSession({ ...state, updatedAt: ctx.now })
}

const hintsFor = (state, ctx) => ({ rule: folderRule(state.cwd), place: rememberedPlace(ctx.store.places(), state.cwd) })

const away = (state, ctx) => ctx.now - state.lastActivity > ctx.idleMs

const breakEnd = (state, ctx) => Math.min(ctx.now, Math.max(state.startedAt ?? 0, state.lastActivity + ctx.idleMs))

function adopt(state, entry, ctx) {
  return {
    ...state,
    status: 'running',
    entryId: entry.id,
    startedAt: entry.startedAt ?? ctx.now,
    taskId: entry.taskId ?? state.taskId,
    task: entry.task ?? state.task,
    projectId: entry.projectId ?? state.projectId,
    project: entry.project ?? state.project,
    workspaceId: entry.workspaceId ?? state.workspaceId,
    workspace: entry.workspace ?? state.workspace,
    lastActivity: ctx.now
  }
}

async function stopEntry(state, at, ctx) {
  try {
    await ctx.client.call('stop_timer', at === undefined ? { entry: state.entryId } : { entry: state.entryId, at })
    return true
  } catch (error) {
    ctx.store.log(`stop ${state.entryId} failed: ${error.message}`)
    return error.kind === 'tool'
  }
}

async function closeBreak(state, ctx) {
  const stopped = await stopEntry(state, breakEnd(state, ctx), ctx)
  return stopped ? { ...state, status: 'idle', entryId: null, startedAt: null } : state
}

async function resume(state, ctx) {
  if (!state.taskId) return { ...state, status: 'untracked' }
  try {
    const result = await ctx.client.call('start_timer', { task: state.taskId })
    return result.entry ? adopt(state, result.entry, ctx) : state
  } catch (error) {
    ctx.store.log(`resume ${state.taskId} failed: ${error.message}`)
    if (error.kind !== 'tool') return state
    return error.data?.entry ? adopt(state, error.data.entry, ctx) : { ...state, status: 'untracked', taskId: null }
  }
}

async function settle(state, ctx) {
  let next = state
  if (next.status === 'running' && away(next, ctx)) next = await closeBreak(next, ctx)
  if (next.status === 'idle') next = await resume(next, ctx)
  return next
}

async function sweep(currentId, ctx) {
  let calls = 0
  for (const other of ctx.store.sessions()) {
    if (other.sessionId === currentId || other.version !== STATE_VERSION) continue
    if (other.status === 'running' && away(other, ctx)) {
      if (calls >= SWEEP_LIMIT) continue
      calls += 1
      save(await closeBreak(other, ctx), ctx)
    } else if (other.status !== 'running' && ctx.now - (other.updatedAt ?? 0) > RETAIN_MS) {
      ctx.store.removeSession(other.sessionId)
    }
  }
}

function describe(state, ctx) {
  if (state.status === 'running') return say.tracking(state)
  if (state.status === 'idle') return say.paused(state)
  if (state.status === 'off') return say.off()
  return say.startTracking(hintsFor(state, ctx))
}

export async function onSessionStart(input, ctx) {
  let state = load(input, ctx)
  if (ctx.config.problem) {
    save({ ...state, warned: true }, ctx)
    return { context: say.notConnected(ctx.config.problem) }
  }
  await sweep(state.sessionId, ctx)
  if (state.status === 'running' && away(state, ctx)) state = await closeBreak(state, ctx)
  save(state, ctx)
  return { context: describe(state, ctx) }
}

export async function onPrompt(input, ctx) {
  let state = load(input, ctx)
  if (ctx.config.problem) {
    if (state.warned) return {}
    save({ ...state, warned: true }, ctx)
    return { context: say.notConnected(ctx.config.problem) }
  }
  await sweep(state.sessionId, ctx)
  state = await settle(state, ctx)
  save({ ...state, lastActivity: ctx.now }, ctx)
  return state.status === 'untracked' ? { context: say.reminder(hintsFor(state, ctx)) } : {}
}

async function onTimebraidTool(tool, input, ctx) {
  let state = load(input, ctx)
  const outcome = resultOf(input.tool_response)
  if (outcome && !outcome.isError && tool === 'start_timer' && outcome.structured.entry?.id) {
    const entry = outcome.structured.entry
    if (state.status === 'running' && state.entryId && state.entryId !== entry.id && !ctx.config.problem) await stopEntry(state, undefined, ctx)
    state = adopt(state, entry, ctx)
    if (entry.workspaceId && entry.projectId && state.cwd) {
      ctx.store.savePlace(state.cwd, { workspaceId: entry.workspaceId, workspace: entry.workspace, projectId: entry.projectId, project: entry.project, at: ctx.now })
    }
  }
  if (outcome && !outcome.isError && tool === 'stop_timer') {
    const stopped = (outcome.structured.entries ?? []).map((entry) => entry.id)
    if (state.entryId && stopped.includes(state.entryId)) state = { ...state, status: 'off', entryId: null, startedAt: null }
  }
  save({ ...state, lastActivity: ctx.now }, ctx)
  return {}
}

export async function onTool(input, ctx) {
  const name = String(input.tool_name ?? '')
  if (name.startsWith(TOOL_PREFIX)) return onTimebraidTool(name.slice(TOOL_PREFIX.length), input, ctx)
  const held = ctx.store.session(input.session_id)
  if (!held || held.version !== STATE_VERSION || ctx.config.problem) return {}
  if (held.status === 'running' && away(held, ctx)) {
    save({ ...(await settle(held, ctx)), lastActivity: ctx.now }, ctx)
    return {}
  }
  if (ctx.now - held.lastActivity < TOUCH_MS) return {}
  save({ ...held, lastActivity: ctx.now }, ctx)
  return {}
}

export async function onTurnEnd(input, ctx) {
  const held = ctx.store.session(input.session_id)
  if (!held || held.version !== STATE_VERSION) return {}
  save({ ...held, lastActivity: ctx.now }, ctx)
  return {}
}

export async function onSessionEnd(input, ctx) {
  const held = ctx.store.session(input.session_id)
  if (!held || held.version !== STATE_VERSION || held.status !== 'running' || ctx.config.problem) return {}
  const stopped = await stopEntry(held, breakEnd(held, ctx), ctx)
  if (stopped) save({ ...held, status: 'idle', entryId: null, startedAt: null }, ctx)
  return {}
}

export const HANDLERS = {
  'session-start': onSessionStart,
  prompt: onPrompt,
  tool: onTool,
  'turn-end': onTurnEnd,
  'session-end': onSessionEnd
}
