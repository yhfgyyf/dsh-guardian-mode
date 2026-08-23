/** Compact, incremental and secret-safe DSH trace serialization. */
export const TRACE_LIMITS = Object.freeze({
  maxEvents: 400,
  maxCharsPerPayload: 1200,
  maxCharsTotal: 60_000
})

const SECRET_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|secret|session[-_]?token|token)/iu
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._~+\/-]+|sk-[a-z0-9_-]{12,})/giu
const SECRET_PAIR = /((?:api[-_]?key|authorization|cookie|credential|password|secret|session[-_]?token|token)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu

export function redactText (value) {
  return String(value).replace(SECRET_VALUE, '[REDACTED]').replace(SECRET_PAIR, '$1[REDACTED]')
}

export function redact (value, depth = 0) {
  if (depth > 6) return '[depth-limit]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(item, depth + 1)
  }
  return out
}

export function snippet (value, max = TRACE_LIMITS.maxCharsPerPayload) {
  let json
  try { json = JSON.stringify(redact(value)) } catch { json = JSON.stringify(String(value)) }
  if (json.length <= max) return json
  const kept = Math.floor(max * 0.8)
  return json.slice(0, kept) + `…[truncated:${json.length - kept}]`
}

function messageContent (data) {
  return data?.message?.content ?? data?.content ?? []
}

/** Flatten text and image metadata without ever descending into image bytes. */
function contentStats (content, out = { texts: [], images: 0 }, depth = 0) {
  if (!Array.isArray(content) || depth > 5) return out
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      out.texts.push(block.text)
    } else if (block?.type === 'tool-result' && Array.isArray(block.content)) {
      contentStats(block.content, out, depth + 1)
    } else if (block?.type === 'image' || block?.type === 'image-url' || block?.type === 'image_url') {
      out.images += 1
    }
  }
  return out
}

function textStats (data) {
  const stats = contentStats(messageContent(data))
  return { chars: stats.texts.reduce((total, text) => total + text.length, 0), images: stats.images }
}

function textPreview (data, max = TRACE_LIMITS.maxCharsPerPayload) {
  const text = contentStats(messageContent(data)).texts.join('\n')
  const safe = redactText(text)
  return safe.length <= max ? safe : safe.slice(0, max) + `…[truncated:${safe.length - max}]`
}

/** Only explicitly allowed metadata crosses into the audit context. */
export function lineFor (event) {
  const e = event ?? {}
  const data = e.data ?? {}
  const base = { seq: e.seq, type: String(e.type ?? 'unknown') }
  switch (e.type) {
    case 'user/message':
    case 'assistant/message':
      return { ...base, ...textStats(data), text: textPreview(data), source: data.source?.kind, ...(data.interrupted === true ? { interrupted: true } : {}) }
    case 'assistant/chunk':
      return { ...base, omitted: 'stream-chunk' }
    case 'tool/call':
      return { ...base, name: data.name, arguments: snippet(data.arguments) }
    case 'tool/result':
      {
        const stats = textStats(data.message ?? data)
        return {
          ...base,
          name: data.message?.name,
          contentChars: stats.chars,
          content: textPreview(data.message ?? data),
          error: data.error?.code,
          meta: snippet(data.meta ?? {}, 300)
        }
      }
    case 'tool/code-dispatch':
      return {
        ...base,
        name: data.name,
        arguments: snippet(data.arguments, 500),
        isError: data.isError === true,
        content: textPreview(data)
      }
    case 'tool/code-dispatch-start':
      return { ...base, name: data.name, arguments: snippet(data.arguments, 500) }
    case 'command/run':
      return { ...base, name: data.name, args: snippet(data.args, 400), source: data.source?.kind }
    case 'command/done':
      return { ...base, name: data.name, kind: data.kind }
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end':
      return { ...base, turn: data.turn, step: data.step, reason: data.reason?.kind }
    case 'todo/write':
      return { ...base, items: Array.isArray(data.todos) ? data.todos.length : 0 }
    case 'goal/change':
      return { ...base, action: data.action, phase: data.phase, round: data.round }
    case 'llm/retry':
      return { ...base, code: data.error?.code, attempt: data.attempt }
    default:
      return { ...base, omitted: 'unrecognized-payload' }
  }
}

export function incrementalEvents (events, cursor = -1) {
  return events.filter((event) => Number.isInteger(event?.seq) && event.seq > cursor)
}

export function renderTrace (events, cursor = -1) {
  const selected = incrementalEvents(events, cursor).slice(-TRACE_LIMITS.maxEvents)
  const text = selected.map((event) => JSON.stringify(lineFor(event))).join('\n')
  return text.length <= TRACE_LIMITS.maxCharsTotal ? text : text.slice(-TRACE_LIMITS.maxCharsTotal)
}

export function lastTraceSeq (events, fallback = -1) {
  return incrementalEvents(events, fallback).at(-1)?.seq ?? fallback
}
