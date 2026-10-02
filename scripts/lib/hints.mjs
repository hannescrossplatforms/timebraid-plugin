import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const RULE_FILE = '.timebraid.json'
const MAX_LEVELS = 12

function* upwards(start) {
  const stop = homedir()
  let folder = start
  for (let level = 0; level < MAX_LEVELS && folder; level += 1) {
    yield folder
    const parent = dirname(folder)
    if (folder === stop || parent === folder) return
    folder = parent
  }
}

const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

export function folderRule(cwd) {
  if (!cwd) return null
  for (const folder of upwards(cwd)) {
    let raw
    try {
      raw = readFileSync(join(folder, RULE_FILE), 'utf8')
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(raw)
      const workspace = text(parsed.workspace)
      return workspace === null ? null : { workspace, project: text(parsed.project), folder }
    } catch {
      return null
    }
  }
  return null
}

export function rememberedPlace(places, cwd) {
  if (!cwd || places === null || typeof places !== 'object') return null
  for (const folder of upwards(cwd)) {
    const place = places[folder]
    if (place && place.workspace && place.project) return { ...place, folder }
  }
  return null
}
