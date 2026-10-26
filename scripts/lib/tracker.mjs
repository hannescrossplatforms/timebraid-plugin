import * as say from './context.mjs'
import { folderRule, rememberedPlace } from './hints.mjs'
import { freshState, STATE_VERSION } from './store.mjs'
import { resultOf } from './timebraid.mjs'

export const TOOL_PREFIX = 'mcp__plugin_timebraid_timebraid__'
const MINUTE = 60 * 1000
const RETAIN_MS = 30 * 24 * 60 * MINUTE
const TOUCH_MS = 30 * 1000
const BEAT_MS = 5 * MINUTE
const TURN_BEAT_MS = MINUTE
const FALLBACK_QUIET_MS = 15 * MINUTE
const HANDOVER_MS = 2 * MINUTE
const BASH_DEFAULT_MS = 2 * MINUTE
const BASH_MAX_MS = 10 * MINUTE
const MAX_BUSY_MINUTES = 720

function load(input, ctx) {
  const held = ctx.store.session(input.session_id)
  if (held && held.version === STATE_VERSION) return { ...held, cwd: input.cwd || held.cwd }
  return freshState(input.session_id, input.cwd || '', ctx.now)
}

function held(input, ctx) {
  const state = ctx.store.session(input.session_id)
  return state && state.version === STATE_VERSION ? state : null
}

function save(state, ctx) {
  ctx.store.saveSession({ ...state, updatedAt: ctx.now })
}

const hintsFor = (state, ctx) => ({ rule: folderRule(state.cwd), place: rememberedPlace(ctx.store.places(), state.cwd) })

const stopped = (state, status) => ({ ...state, status, entryId: null, startedAt: null, beatAt: null, leaseUntil: null })

const busyMinutes = (ms) => Math.min(MAX_BUSY_MINUTES, Math.ceil(ms / MINUTE))

const leaseEnd = (state, ctx) => Math.min(ctx.now, Math.max(state.startedAt ?? 0, state.leaseUntil ?? ctx.now))

const beatDue = (state, ctx, interval) => {
  if (!state.beatAt || !state.leaseUntil) return true
  return ctx.now - state.beatAt >= Math.min(interval, (state.leaseUntil - state.beatAt) / 3)
}

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
    beatAt: null,
    leaseUntil: null,
    lastActivity: ctx.now
  }
}

const SHARE_FIELDS = ['entryId', 'taskId', 'task', 'projectId', 'project', 'workspaceId', 'workspace']

export function sharedTimer(env = {}) {
  let share
  try {
    share = JSON.parse(env.TIMEBRAID_SHARED_TIMER ?? '')
  } catch {
    return null
  }
  if (!share || typeof share.entryId !== 'string' || share.entryId === '') return null
  return Object.fromEntries(SHARE_FIELDS.map((field) => [field, typeof share[field] === 'string' ? share[field] : null]))
}

export const shareOf = (state) => (state.status === 'running' && state.entryId ? Object.fromEntries(SHARE_FIELDS.map((field) => [field, state[field]])) : null)

const joinShare = (state, share, ctx) => ({ ...adopt(state, { ...share, id: share.entryId }, ctx), shared: true })

async function stopEntry(state, ctx, { at, automatic = false } = {}) {
  const args = { entry: state.entryId }
  if (at !== undefined) args.at = at
  if (automatic) args.automatic = true
  try {
    await ctx.client.call('stop_timer', args)
    return true
  } catch (error) {
    ctx.store.log(`stop ${state.entryId} failed: ${error.message}`)
    if (error.kind === 'tool' && at !== undefined) return stopEntry(state, ctx, { automatic })
    return error.kind === 'tool'
  }
}

async function keepAlive(state, ctx, spanMs = 0) {
  const busy = busyMinutes(spanMs)
  try {
    const result = await ctx.client.call('keep_alive', busy > 0 ? { entry: state.entryId, busyMinutes: busy } : { entry: state.entryId })
    const expires = Number(result.expiresAt)
    return { ...state, beatAt: ctx.now, leaseUntil: expires > 0 ? expires : ctx.now + busy * MINUTE + FALLBACK_QUIET_MS }
  } catch (error) {
    ctx.store.log(`keep alive ${state.entryId} failed: ${error.message}`)
    return error.kind === 'tool' ? stopped(state, 'idle') : state
  }
}

async function resume(state, ctx) {
  if (!state.taskId) return { ...state, status: 'untracked' }
  try {
    const result = await ctx.client.call('start_timer', { task: state.taskId })
    return result.entry ? keepAlive(adopt(state, result.entry, ctx), ctx) : state
  } catch (error) {
    ctx.store.log(`resume ${state.taskId} failed: ${error.message}`)
    if (error.kind !== 'tool') return state
    return error.data?.entry ? keepAlive(adopt(state, error.data.entry, ctx), ctx) : { ...state, status: 'untracked', taskId: null }
  }
}

async function beat(state, ctx, spanMs = 0) {
  let next = state
  if (next.status === 'running') next = await keepAlive(next, ctx, spanMs)
  if (next.status === 'idle') next = await resume(next, ctx)
  return next
}

function prune(currentId, ctx) {
  for (const other of ctx.store.sessions()) {
    if (other.sessionId !== currentId && ctx.now - (other.updatedAt ?? 0) > RETAIN_MS) ctx.store.removeSession(other.sessionId)
  }
}

function takeHandover(state, ctx) {
  const handover = ctx.store.takeHandover(state.cwd)
  if (!handover || ctx.now - handover.at > HANDOVER_MS || handover.state?.status !== 'running') return state
  const { status, entryId, startedAt, taskId, task, projectId, project, workspaceId, workspace, beatAt, leaseUntil, shared = false } = handover.state
  return { ...state, status, entryId, startedAt, taskId, task, projectId, project, workspaceId, workspace, beatAt, leaseUntil, shared, lastActivity: ctx.now }
}

const tracking = (state) => (state.shared ? say.shared(state) : say.tracking(state))

function describe(state, ctx) {
  if (state.status === 'running') return tracking(state)
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
  prune(state.sessionId, ctx)
  if (input.source === 'clear' && ['untracked', 'idle'].includes(state.status)) state = takeHandover(state, ctx)
  const share = state.status === 'untracked' ? sharedTimer(ctx.env) : null
  if (share) state = await keepAlive(joinShare(state, share, ctx), ctx)
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
  const before = state.entryId
  state = await beat(state, ctx)
  save({ ...state, lastActivity: ctx.now }, ctx)
  if (state.status === 'untracked') return { context: say.reminder(hintsFor(state, ctx)) }
  if (state.status === 'running' && before && state.entryId !== before) return { context: tracking(state) }
  return {}
}

async function onTimebraidTool(tool, input, ctx) {
  let state = load(input, ctx)
  const outcome = resultOf(input.tool_response)
  if (outcome && !outcome.isError && tool === 'start_timer' && outcome.structured.entry?.id) {
    const entry = outcome.structured.entry
    if (state.status === 'running' && state.entryId && state.entryId !== entry.id && !state.shared && !ctx.config.problem) await stopEntry(state, ctx)
    state = { ...adopt(state, entry, ctx), shared: false }
    if (entry.workspaceId && entry.projectId && state.cwd) {
      ctx.store.savePlace(state.cwd, { workspaceId: entry.workspaceId, workspace: entry.workspace, projectId: entry.projectId, project: entry.project, at: ctx.now })
    }
    if (!ctx.config.problem) state = await keepAlive(state, ctx)
  }
  if (outcome && !outcome.isError && tool === 'stop_timer') {
    const ids = (outcome.structured.entries ?? []).map((entry) => entry.id)
    if (state.entryId && ids.includes(state.entryId)) state = stopped(state, 'off')
  }
  save({ ...state, lastActivity: ctx.now }, ctx)
  return {}
}

export async function onTool(input, ctx) {
  const name = String(input.tool_name ?? '')
  if (name.startsWith(TOOL_PREFIX)) return onTimebraidTool(name.slice(TOOL_PREFIX.length), input, ctx)
  const state = held(input, ctx)
  if (!state || ctx.config.problem || !['running', 'idle'].includes(state.status)) return {}
  if (state.status === 'idle' || beatDue(state, ctx, BEAT_MS)) {
    save({ ...(await beat(state, ctx)), lastActivity: ctx.now }, ctx)
  } else if (ctx.now - state.lastActivity >= TOUCH_MS) {
    save({ ...state, lastActivity: ctx.now }, ctx)
  }
  return {}
}

function toolSpan(input) {
  const args = input.tool_input ?? {}
  if (input.tool_name !== 'Bash' || args.run_in_background === true) return 0
  return Math.min(BASH_MAX_MS, Number(args.timeout) > 0 ? Number(args.timeout) : BASH_DEFAULT_MS)
}

export async function onToolStart(input, ctx) {
  const state = held(input, ctx)
  const span = toolSpan(input)
  if (!state || ctx.config.problem || state.status !== 'running' || span === 0) return {}
  if ((state.leaseUntil ?? 0) >= ctx.now + span) return {}
  save({ ...(await keepAlive(state, ctx, span)), lastActivity: ctx.now }, ctx)
  return {}
}

export async function onTurnEnd(input, ctx) {
  const state = held(input, ctx)
  if (!state) return {}
  const due = !ctx.config.problem && (state.status === 'idle' || (state.status === 'running' && beatDue(state, ctx, TURN_BEAT_MS)))
  save({ ...(due ? await beat(state, ctx) : state), lastActivity: ctx.now }, ctx)
  return {}
}

export async function onSessionEnd(input, ctx) {
  const state = held(input, ctx)
  if (!state || state.status !== 'running' || ctx.config.problem) return {}
  if (input.reason === 'clear') {
    ctx.store.saveHandover(state.cwd, { at: ctx.now, state })
    save(stopped(state, 'idle'), ctx)
    return {}
  }
  if (state.shared) {
    save(stopped(state, 'idle'), ctx)
    return {}
  }
  if (await stopEntry(state, ctx, { at: leaseEnd(state, ctx), automatic: true })) save(stopped(state, 'idle'), ctx)
  return {}
}

export const HANDLERS = {
  'session-start': onSessionStart,
  prompt: onPrompt,
  tool: onTool,
  'tool-start': onToolStart,
  'turn-end': onTurnEnd,
  'session-end': onSessionEnd
}
