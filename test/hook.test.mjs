import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from './helpers.mjs'

const HOOK = fileURLToPath(new URL('../scripts/hook.mjs', import.meta.url))
const TOKEN = 'tally_mcp_e2e-secret-value'

const received = []
let server
let url

function run(event, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, event], { env: { PATH: process.env.PATH, ...env } })
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.on('close', (code) => resolve({ code, stdout }))
    child.stdin.end(JSON.stringify(input))
  })
}

before(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      received.push({ path: request.url, auth: request.headers.authorization, body: JSON.parse(body) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { stopped: 1, entries: [] }, isError: false } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

describe('the hook script', () => {
  it('adds the start instruction as context on session start, and reminds on a prompt', async () => {
    const data = tempDir()
    const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_OPTION_API_TOKEN: TOKEN, CLAUDE_PLUGIN_OPTION_API_URL: url }
    const start = await run('session-start', { session_id: 's1', cwd: '/w', hook_event_name: 'SessionStart', source: 'startup' }, env)
    assert.equal(start.code, 0)
    const output = JSON.parse(start.stdout)
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(output.hookSpecificOutput.additionalContext, /No timer is running for this thread yet/)

    const prompt = await run('prompt', { session_id: 's1', cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: 'hello' }, env)
    assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  })

  it('keeps the timer alive and stops it automatically at session end through the server with the token, and never writes the token to disk', async () => {
    const data = tempDir()
    const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_OPTION_API_TOKEN: TOKEN, CLAUDE_PLUGIN_OPTION_API_URL: url }
    await run('session-start', { session_id: 's2', cwd: '/w', source: 'startup' }, env)
    const tool = {
      session_id: 's2',
      cwd: '/w',
      tool_name: 'mcp__plugin_timebraid_timebraid__start_timer',
      tool_input: { project: 'Website', task: 'Login' },
      tool_response: { structuredContent: { entry: { id: 'e-42', taskId: 't-1', task: 'Login', projectId: 'p-1', project: 'Website', workspaceId: 'w-1', workspace: 'Baker', startedAt: Date.now() } }, isError: false }
    }
    received.length = 0
    assert.equal((await run('tool', tool, env)).stdout, '')
    assert.deepEqual(received.map((call) => [call.body.params.name, call.body.params.arguments]), [['keep_alive', { entry: 'e-42' }]])
    received.length = 0
    const end = await run('session-end', { session_id: 's2', cwd: '/w', reason: 'prompt_input_exit' }, env)
    assert.equal(end.code, 0)
    assert.equal(received.length, 1)
    assert.equal(received[0].path, '/mcp')
    assert.equal(received[0].auth, `Bearer ${TOKEN}`)
    assert.equal(received[0].body.params.name, 'stop_timer')
    assert.equal(received[0].body.params.arguments.entry, 'e-42')
    assert.equal(received[0].body.params.arguments.automatic, true)

    const files = [join(data, 'places.json'), ...readdirSync(join(data, 'sessions')).map((name) => join(data, 'sessions', name))]
    for (const file of files) assert.equal(readFileSync(file, 'utf8').includes(TOKEN), false)
  })

  it('stays quiet and exits cleanly without a session id, with bad JSON, or for an unknown event', async () => {
    const env = { CLAUDE_PLUGIN_DATA: tempDir() }
    assert.deepEqual(await run('prompt', {}, env), { code: 0, stdout: '' })
    assert.deepEqual(await run('nonsense', { session_id: 's3' }, env), { code: 0, stdout: '' })
  })

  it('tells Claude it is not connected when no token is set, without calling anything', async () => {
    received.length = 0
    const start = await run('session-start', { session_id: 's4', cwd: '/w', source: 'startup' }, { CLAUDE_PLUGIN_DATA: tempDir(), CLAUDE_PLUGIN_OPTION_API_URL: url })
    assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /not connected: no token is set/)
    assert.equal(received.length, 0)
  })
})
