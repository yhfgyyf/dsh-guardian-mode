
import test from 'node:test'
import assert from 'node:assert/strict'
import { incrementalEvents, lineFor, redactText, renderTrace, snippet, TRACE_LIMITS } from '../lib/trace.js'

test('snippet truncates long JSON payloads', () => {
  const long = 'x'.repeat(TRACE_LIMITS.maxCharsPerPayload * 2)
  const out = snippet(long)
  assert.ok(out.length < long.length)
  assert.match(out, /truncated/)
})

test('lineFor maps user/assistant messages to compact counts', () => {
  const user = lineFor({ seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } })
  assert.deepEqual(user, { seq: 1, type: 'user/message', chars: 5, images: 0, text: 'hello', source: 'user' })
  const withImage = lineFor({ seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'x' }, { type: 'image', image: {} }], source: { kind: 'user' } } })
  assert.equal(withImage.images, 1)
})

test('lineFor keeps tool names and error codes', () => {
  const call = lineFor({ seq: 1, type: 'tool/call', data: { name: 'run_code', arguments: '{}' } })
  assert.equal(call.name, 'run_code')
  const result = lineFor({ seq: 2, type: 'tool/result', data: { error: { code: 'E' } } })
  assert.equal(result.error, 'E')
})

test('PTC dispatch and nested tool results preserve bounded textual evidence', () => {
  const dispatch = lineFor({
    seq: 8,
    type: 'tool/code-dispatch',
    data: {
      name: 'bash',
      arguments: { command: 'git rev-parse HEAD' },
      isError: false,
      content: [{ type: 'text', text: 'ba9074035a9879ebdd36f955610c2928a9049e05\n' }]
    }
  })
  assert.equal(dispatch.name, 'bash')
  assert.match(dispatch.content, /ba9074035a9879/)

  const nested = lineFor({
    seq: 9,
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [
            { type: 'text', text: 'python/sglang/srt/models/deepseek_v4.py:120' },
            { type: 'image', data: 'base64-binary' }
          ]
        }]
      }
    }
  })
  assert.match(nested.content, /deepseek_v4\.py:120/)
  assert.equal(nested.contentChars, 43)
  assert.doesNotMatch(nested.content, /base64-binary/)
})

test('trace keeps bounded progress text while redacting common key-value secrets', () => {
  assert.equal(redactText('password=hunter2 token:abc123 api_key="value"'), 'password=[REDACTED] token:[REDACTED] api_key="[REDACTED]"')
  const result = lineFor({ seq: 2, type: 'tool/result', data: { message: { name: 'bash', content: [{ type: 'text', text: 'tests: 4 passed' }] } } })
  assert.equal(result.content, 'tests: 4 passed')
})

test('renderTrace keeps the last window and is bounded', () => {
  const events = Array.from({ length: TRACE_LIMITS.maxEvents + 10 }, (_, i) => ({ seq: i, type: 'user/message', data: { content: [{ type: 'text', text: 't' }], source: { kind: 'user' } } }))
  const text = renderTrace(events)
  const lines = text.split(String.fromCharCode(10))
  assert.equal(lines.length, TRACE_LIMITS.maxEvents)
  assert.ok(text.length <= TRACE_LIMITS.maxCharsTotal)
})

test('trace removes image binary, stream chunks, and sensitive fields', () => {
  const text = renderTrace([
    { seq: 1, type: 'assistant/chunk', data: { chunk: { text: 'secret stream' } } },
    { seq: 2, type: 'tool/call', data: { name: 'x', arguments: { apiKey: 'sk-very-secret-value', nested: { password: 'p' } } } },
    { seq: 3, type: 'user/message', data: { message: { content: [{ type: 'image', data: 'base64-binary' }] }, source: { kind: 'user' } } }
  ])
  assert.doesNotMatch(text, /secret stream|very-secret|base64-binary|"p"/)
  assert.match(text, /REDACTED/)
  assert.match(text, /"images":1/)
})

test('incremental cursor keeps only new events', () => {
  const selected = incrementalEvents([{ seq: 1 }, { seq: 2 }, { seq: 3 }], 1)
  assert.deepEqual(selected.map((event) => event.seq), [2, 3])
})
