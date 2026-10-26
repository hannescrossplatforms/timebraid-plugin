import { readConfig } from './lib/config.mjs'
import { createStore } from './lib/store.mjs'
import { createClient } from './lib/timebraid.mjs'
import { HANDLERS } from './lib/tracker.mjs'

const EVENT_NAMES = { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit' }

async function readInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function main() {
  const event = process.argv[2]
  const handler = HANDLERS[event]
  const input = await readInput()
  if (!handler || typeof input.session_id !== 'string') return
  const config = readConfig()
  const store = createStore(config.dataDir)
  const ctx = { config, store, client: createClient({ url: config.url, token: config.token }), now: Date.now(), env: process.env }
  try {
    const result = await handler(input, ctx)
    if (result?.context && EVENT_NAMES[event]) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT_NAMES[event], additionalContext: result.context } }))
    }
  } catch (error) {
    store.log(`${event} failed: ${error?.message ?? error}`)
  }
}

await main()
