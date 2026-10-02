import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const LOG_LIMIT = 256 * 1024

export const STATE_VERSION = 1

export function freshState(sessionId, cwd, now) {
  return {
    version: STATE_VERSION,
    sessionId,
    cwd,
    status: 'untracked',
    entryId: null,
    startedAt: null,
    taskId: null,
    task: null,
    projectId: null,
    project: null,
    workspaceId: null,
    workspace: null,
    beatAt: null,
    leaseUntil: null,
    lastActivity: now,
    warned: false,
    updatedAt: now
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export function createStore(dataDir) {
  const sessionsDir = join(dataDir, 'sessions')
  const placesFile = join(dataDir, 'places.json')
  const handoverFile = join(dataDir, 'handover.json')
  const logFile = join(dataDir, 'hook.log')
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 })

  const sessionFile = (id) => join(sessionsDir, `${id}.json`)

  return {
    session(id) {
      return SAFE_ID.test(String(id)) ? readJson(sessionFile(id)) : null
    },

    saveSession(state) {
      if (SAFE_ID.test(String(state.sessionId))) writeJson(sessionFile(state.sessionId), state)
    },

    removeSession(id) {
      if (!SAFE_ID.test(String(id))) return
      try {
        unlinkSync(sessionFile(id))
      } catch {}
    },

    sessions() {
      let names = []
      try {
        names = readdirSync(sessionsDir).filter((name) => name.endsWith('.json'))
      } catch {}
      return names.map((name) => readJson(join(sessionsDir, name))).filter((state) => state !== null && typeof state.sessionId === 'string')
    },

    places() {
      return readJson(placesFile) ?? {}
    },

    savePlace(folder, place) {
      const all = readJson(placesFile) ?? {}
      all[folder] = place
      writeJson(placesFile, all)
    },

    saveHandover(folder, handover) {
      const all = readJson(handoverFile) ?? {}
      all[folder] = handover
      writeJson(handoverFile, all)
    },

    takeHandover(folder) {
      const all = readJson(handoverFile) ?? {}
      const handover = all[folder] ?? null
      if (handover) {
        delete all[folder]
        writeJson(handoverFile, all)
      }
      return handover
    },

    log(line) {
      try {
        if (statSync(logFile).size > LOG_LIMIT) truncateSync(logFile, 0)
      } catch {}
      try {
        appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
      } catch {}
    }
  }
}
