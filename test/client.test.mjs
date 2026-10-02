import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_IDLE_MINUTES, DEFAULT_URL, readConfig } from '../scripts/lib/config.mjs'
import { createClient, resultOf, TimebraidError } from '../scripts/lib/timebraid.mjs'

const TOKEN = 'tally_mcp_test-secret'

describe('settings', () => {
  it('uses the live server and a 15 minute break by default, and needs a token', () => {
    const config = readConfig({ CLAUDE_PLUGIN_DATA: '/tmp/x' })
    assert.equal(config.url, DEFAULT_URL)
    assert.equal(config.idleMs, DEFAULT_IDLE_MINUTES * 60_000)
    assert.equal(config.problem, 'missing-token')
    assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_API_TOKEN: TOKEN }).problem, null)
  })

  it('refuses a token that is not a Timebraid one and a server that is not https, except on this machine', () => {
    assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_API_TOKEN: 'sk-something' }).problem, 'bad-token')
    assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_API_TOKEN: TOKEN, CLAUDE_PLUGIN_OPTION_API_URL: 'http://example.com' }).problem, 'insecure-url')
    assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_API_TOKEN: TOKEN, CLAUDE_PLUGIN_OPTION_API_URL: 'http://localhost:3050/' }).problem, null)
    assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_API_TOKEN: TOKEN, CLAUDE_PLUGIN_OPTION_API_URL: 'http://localhost:3050/' }).url, 'http://localhost:3050')
    assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_API_TOKEN: TOKEN, CLAUDE_PLUGIN_OPTION_API_URL: 'not a url' }).problem, 'bad-url')
  })

  it('keeps the break between 1 and 240 minutes', () => {
    assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_IDLE_MINUTES: '0' }).idleMs, 60_000)
    assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_IDLE_MINUTES: '999' }).idleMs, 240 * 60_000)
    assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_IDLE_MINUTES: '30' }).idleMs, 30 * 60_000)
    assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_IDLE_MINUTES: 'soon' }).idleMs, DEFAULT_IDLE_MINUTES * 60_000)
  })
})

describe('reading a tool result handed to a hook', () => {
  it('reads structured content, falls back to JSON text, and keeps the error flag', () => {
    assert.deepEqual(resultOf({ structuredContent: { entry: { id: 'e' } }, isError: false }), { structured: { entry: { id: 'e' } }, isError: false })
    assert.deepEqual(resultOf({ content: [{ type: 'text', text: '{"entry":{"id":"e"}}' }] }), { structured: { entry: { id: 'e' } }, isError: false })
    assert.deepEqual(resultOf([{ type: 'text', text: '{"stopped":1}' }]), { structured: { stopped: 1 }, isError: false })
    assert.deepEqual(resultOf({ content: [{ type: 'text', text: 'no project matches' }], isError: true }), { structured: {}, isError: true })
    assert.equal(resultOf(null), null)
  })
})

describe('the client', () => {
  const answering = (status, body) => {
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push({ url, init })
      return { ok: status < 400, status, json: async () => body }
    }
    return { seen, fetchImpl }
  }

  it('posts a JSON-RPC tool call with the bearer token and returns the structured content', async () => {
    const { seen, fetchImpl } = answering(200, { jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: { stopped: 1 }, isError: false } })
    const client = createClient({ url: 'https://api.test', token: TOKEN, fetchImpl })
    assert.deepEqual(await client.call('stop_timer', { entry: 'e1', at: 5 }), { stopped: 1 })
    assert.equal(seen[0].url, 'https://api.test/mcp')
    assert.equal(seen[0].init.headers.Authorization, `Bearer ${TOKEN}`)
    assert.deepEqual(JSON.parse(seen[0].init.body), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stop_timer', arguments: { entry: 'e1', at: 5 } } })
  })

  it('tells a refused tool, a refused request and an unreachable server apart', async () => {
    const tool = createClient({ url: 'https://api.test', token: TOKEN, fetchImpl: answering(200, { result: { isError: true, content: [{ type: 'text', text: 'not running' }], structuredContent: { entry: { id: 'e' } } } }).fetchImpl })
    await assert.rejects(tool.call('stop_timer', {}), (error) => error instanceof TimebraidError && error.kind === 'tool' && error.message === 'not running' && error.data.entry.id === 'e')
    const http = createClient({ url: 'https://api.test', token: TOKEN, fetchImpl: answering(401, { error: 'unauthenticated' }).fetchImpl })
    await assert.rejects(http.call('list_running'), (error) => error.kind === 'http' && error.status === 401)
    const down = createClient({ url: 'https://api.test', token: TOKEN, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
    await assert.rejects(down.call('list_running'), (error) => error.kind === 'network')
  })

  it('gives up when the server is slow', async () => {
    const slow = createClient({ url: 'https://api.test', token: TOKEN, timeoutMs: 20, fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) })
    await assert.rejects(slow.call('list_running'), (error) => error.kind === 'network' && /in time/.test(error.message))
  })
})
