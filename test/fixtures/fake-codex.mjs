#!/usr/bin/env node
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin, terminal: false })
let nextThread = 1
let nextTurn = 1
const summary = '{"intent":"implement","progress":"tests pass","evidence":["test"],"risks":[],"next":["continue"]}'
const audit = process.env.FAKE_CODEX_AUDIT ?? '{"verdict":"pass","summary":"on track","findings":[]}'
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { userAgent: 'fake' } })
      return
    case 'thread/start': {
      const id = `fake-thread-${nextThread++}`
      send({ id: message.id, result: { thread: { id } } })
      return
    }
    case 'thread/resume':
      send({ id: message.id, result: { thread: { id: params.threadId } } })
      return
    case 'thread/fork': {
      const id = `fake-thread-${nextThread++}`
      send({ id: message.id, result: { thread: { id } } })
      return
    }
    case 'thread/archive':
    case 'thread/name/set':
      send({ id: message.id, result: {} })
      return
    case 'turn/start': {
      const turnId = `fake-turn-${nextTurn++}`
      const text = params.threadId?.endsWith('-1') ? summary : audit
      send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } })
      setImmediate(() => {
        send({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, delta: text } })
        send({ method: 'item/completed', params: { threadId: params.threadId, turnId, item: { type: 'agentMessage', id: 'message-1', text } } })
        send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed', items: [{ type: 'agentMessage', id: 'message-1', text }] } } })
      })
      return
    }
    default:
      send({ id: message.id, error: { code: -32601, message: 'unknown method' } })
  }
})

rl.on('close', () => process.exit(0))
