export class TimebraidError extends Error {
  constructor(message, { kind, status, data } = {}) {
    super(message)
    this.name = 'TimebraidError'
    this.kind = kind
    this.status = status
    this.data = data ?? {}
  }
}

const firstText = (result) => (Array.isArray(result?.content) ? result.content.find((block) => block?.type === 'text')?.text ?? '' : '')

export function createClient({ url, token, timeoutMs = 4000, fetchImpl = globalThis.fetch }) {
  let sequence = 0

  async function call(name, args = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      sequence += 1
      const response = await fetchImpl(`${url}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: sequence, method: 'tools/call', params: { name, arguments: args } }),
        signal: controller.signal
      })
      if (!response.ok) throw new TimebraidError(`the server answered ${response.status}`, { kind: 'http', status: response.status })
      const body = await response.json()
      if (body?.error) throw new TimebraidError(String(body.error.message ?? 'the server refused the call'), { kind: 'rpc' })
      const result = body?.result ?? {}
      if (result.isError) throw new TimebraidError(firstText(result) || 'the tool refused the call', { kind: 'tool', data: result.structuredContent })
      return result.structuredContent ?? {}
    } catch (error) {
      if (error instanceof TimebraidError) throw error
      throw new TimebraidError(error?.name === 'AbortError' ? 'the server did not answer in time' : 'the server could not be reached', { kind: 'network' })
    } finally {
      clearTimeout(timer)
    }
  }

  return { call }
}

export function resultOf(toolResponse) {
  if (toolResponse === null || typeof toolResponse !== 'object') {
    if (typeof toolResponse !== 'string') return null
    try {
      return { structured: JSON.parse(toolResponse), isError: false }
    } catch {
      return null
    }
  }
  if (Array.isArray(toolResponse)) return resultOf({ content: toolResponse })
  if (toolResponse.structuredContent && typeof toolResponse.structuredContent === 'object') {
    return { structured: toolResponse.structuredContent, isError: toolResponse.isError === true }
  }
  try {
    return { structured: JSON.parse(firstText(toolResponse)), isError: toolResponse.isError === true }
  } catch {
    return { structured: {}, isError: toolResponse.isError === true }
  }
}
