
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerGuardianApi } from '../lib/api.js'
import { GUARDIAN_API_BASE } from '../lib/invariant.js'

function fakeWebServer () {
  const routes = []
  return {
    register: (route) => {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    routes
  }
}

test('registerGuardianApi declares all six Remote endpoints', () => {
  const web = fakeWebServer()
  const ctx = { get: (name) => name === 'webServer' ? web : undefined }
  const service = {
    snapshot: async () => ({ capability: 'guardian' }),
    history: async () => [],
    subscribe: () => () => {},
    requestNow: async () => ({ ok: true }),
    accept: async () => ({ ok: true }),
    resume: async () => ({ ok: true })
  }
  const dispose = registerGuardianApi(ctx, service)
  const paths = web.routes.map((r) => r.path)
  assert.deepEqual(paths.sort(), [
    GUARDIAN_API_BASE + '/accept',
    GUARDIAN_API_BASE + '/request-now',
    GUARDIAN_API_BASE + '/resume',
    GUARDIAN_API_BASE + '/snapshot',
    GUARDIAN_API_BASE + '/history',
    GUARDIAN_API_BASE + '/watch'
  ].sort())
  dispose()
})

test('snapshot handler answers with the service view', async () => {
  const web = fakeWebServer()
  const ctx = { get: () => web }
  const service = {
    snapshot: async (id) => ({ sessionId: id, capability: 'guardian' }),
    history: async () => [],
    subscribe: () => () => {},
    requestNow: async () => ({ ok: true }),
    accept: async () => ({ ok: true }),
    resume: async () => ({ ok: true })
  }
  registerGuardianApi(ctx, service)
  const route = web.routes.find((r) => r.path.endsWith('/snapshot'))
  let status = 0
  let body = ''
  const res = {
    writeHead: (code, headers) => { status = code },
    end: (text) => { body = text }
  }
  const req = { method: 'GET', url: '/api/guardian/snapshot?session=session-42' }
  await route.handler(req, res)
  assert.equal(status, 200)
  assert.deepEqual(JSON.parse(body), { sessionId: 'session-42', capability: 'guardian' })
})

test('watch handler streams SSE events until the socket closes', async () => {
  const web = fakeWebServer()
  const ctx = { get: () => web }
  let subscription
  const service = {
    snapshot: async () => ({ paused: false }),
    history: async () => [],
    subscribe: (sessionId, listener) => { subscription = listener; return () => {} },
    requestNow: async () => ({ ok: true }),
    accept: async () => ({ ok: true }),
    resume: async () => ({ ok: true })
  }
  registerGuardianApi(ctx, service)
  const route = web.routes.find((r) => r.path.endsWith('/watch'))
  let frame = ''
  let headers = {}
  const res = {
    writeHead: (code, h) => { headers = h },
    write: (text) => { frame += text; return true },
    end: () => {}
  }
  let closeHandler
  const req = { method: 'GET', url: '/api/guardian/watch?session=s1', on: (ev, fn) => { if (ev === 'close') closeHandler = fn } }
  await route.handler(req, res)
  assert.equal(headers['content-type'], 'text/event-stream')
  assert.match(frame, /event: hello/)
  subscription({ paused: true })
  assert.match(frame, /event: guardian/)
  assert.match(frame, /paused/)
  closeHandler()
})

test('request-now, accept, and resume handlers parse the body', async () => {
  const web = fakeWebServer()
  const ctx = { get: () => web }
  const calls = []
  const service = {
    snapshot: async () => ({}),
    history: async () => [],
    subscribe: () => () => {},
    requestNow: async (sessionId, opts) => { calls.push(['now', sessionId, opts]); return { ok: true } },
    accept: async (sessionId, auditId, editedText) => { calls.push(['accept', sessionId, auditId, editedText]); return { ok: true } },
    resume: async (sessionId) => { calls.push(['resume', sessionId]); return { ok: true } }
  }
  registerGuardianApi(ctx, service)
  const now = web.routes.find((r) => r.path.endsWith('/request-now'))
  const accept = web.routes.find((r) => r.path.endsWith('/accept'))
  const resume = web.routes.find((r) => r.path.endsWith('/resume'))
  async function handler (route, payload) {
    let status = 0; let body = ''
    const res = { writeHead: (code) => { status = code }, end: (text) => { body = text } }
    let sentInput = ''
    const req = {
      method: 'POST',
      url: '/',
      [Symbol.asyncIterator]: async function * () { yield Buffer.from(JSON.stringify(payload)) }
    }
    await route.handler(req, res)
    return { status, body }
  }
  const r1 = await handler(now, { sessionId: 'a', final: true })
  assert.equal(r1.status, 200)
  assert.deepEqual(calls[0], ['now', 'a', { reason: 'final', final: true }])
  const accepted = await handler(accept, { sessionId: 'a', auditId: 'audit-1', editedText: 'Use the narrower repair.' })
  assert.equal(accepted.status, 200)
  assert.deepEqual(calls[1], ['accept', 'a', 'audit-1', 'Use the narrower repair.'])
  const r2 = await handler(resume, { sessionId: 'b' })
  assert.equal(r2.status, 200)
  assert.deepEqual(calls[2], ['resume', 'b'])
  const r3 = await handler(now, {})
  assert.equal(r3.status, 400)
})
