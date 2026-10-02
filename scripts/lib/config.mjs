import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_URL = 'https://backend-production-e532.up.railway.app'
export const DEFAULT_IDLE_MINUTES = 15
export const MAX_IDLE_MINUTES = 240
export const TOKEN_PREFIX = 'tally_mcp_'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function idleMinutes(raw) {
  const minutes = Number(raw)
  if (raw === undefined || raw === '' || !Number.isFinite(minutes)) return DEFAULT_IDLE_MINUTES
  return Math.min(MAX_IDLE_MINUTES, Math.max(1, minutes))
}

function problemWith(url, token) {
  if (token === '') return 'missing-token'
  if (!token.startsWith(TOKEN_PREFIX)) return 'bad-token'
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return 'bad-url'
  }
  const local = parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname)
  return parsed.protocol === 'https:' || local ? null : 'insecure-url'
}

export function readConfig(env = process.env) {
  const url = (env.CLAUDE_PLUGIN_OPTION_API_URL || DEFAULT_URL).trim().replace(/\/+$/, '')
  const token = (env.CLAUDE_PLUGIN_OPTION_API_TOKEN || '').trim()
  return {
    url,
    token,
    idleMs: idleMinutes(env.CLAUDE_PLUGIN_OPTION_IDLE_MINUTES) * 60_000,
    dataDir: env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'timebraid-local'),
    problem: problemWith(url, token)
  }
}
