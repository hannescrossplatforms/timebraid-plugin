import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../scripts/lib/store.mjs'
import { TimebraidError } from '../scripts/lib/timebraid.mjs'

export const MINUTE = 60 * 1000
export const T0 = Date.UTC(2026, 9, 2, 7, 0)

export function tempDir(prefix = 'timebraid-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function entry(over = {}) {
  return {
    id: 'entry-1',
    taskId: 'task-1',
    task: 'Login redirect bug',
    projectId: 'project-1',
    project: 'Website',
    workspaceId: 'ws-1',
    workspace: 'Baker Street Properties',
    startedAt: T0,
    endedAt: null,
    ...over
  }
}

export function fakeClient(script = {}) {
  const calls = []
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args })
      const answer = script[name]
      const value = typeof answer === 'function' ? answer(args, calls.length) : answer
      if (value instanceof Error) throw value
      return value ?? {}
    }
  }
}

export const refused = (message, data) => new TimebraidError(message, { kind: 'tool', data })
export const unreachable = () => new TimebraidError('the server could not be reached', { kind: 'network' })

export function context({ now = T0, idleMinutes = 15, problem = null, client = fakeClient(), dataDir = tempDir() } = {}) {
  return {
    config: { problem, idleMs: idleMinutes * MINUTE, dataDir },
    store: createStore(dataDir),
    client,
    idleMs: idleMinutes * MINUTE,
    now
  }
}

export const at = (ctx, now) => ({ ...ctx, now })
