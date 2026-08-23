import { GUARDIAN_API_BASE } from './invariant.js'

/**
 * Guardian Remote API: snapshot / watch / requestNow / resume over the host
 * webserver (third-party routes never touch the fixed RPC map).
 *   GET  /api/guardian/snapshot?session=<id>   ->  JSON view
 *   GET  /api/guardian/watch?session=<id>      ->  text/event-stream (SSE)
 *   POST /api/guardian/request-now             ->  {sessionId, reason?, final?}
 *   POST /api/guardian/resume                  ->  {sessionId}
 */

function sendJson (res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody (req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 32 * 1024) throw new Error('guardian request body is too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return {}
  return JSON.parse(raw)
}

function sessionOf (url) {
  return new URL(url, 'http://x').searchParams.get('session')
}

export function registerGuardianApi (ctx, service) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return undefined
  const disposers = []
  const add = (route) => {
    disposers.push(webServer.register(route))
  }

  add({
    kind: 'exact',
    path: GUARDIAN_API_BASE + '/snapshot',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const sessionId = sessionOf(req.url ?? '')
      if (sessionId === null) return sendJson(res, 400, { error: 'missing session' })
      try {
        sendJson(res, 200, await service.snapshot(sessionId))
      } catch (error) {
        sendJson(res, 500, { error: String(error) })
      }
    }
  })

  add({
    kind: 'exact',
    path: GUARDIAN_API_BASE + '/watch',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const sessionId = sessionOf(req.url ?? '')
      if (sessionId === null) {
        res.writeHead(400)
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      })
      const send = (event) => res.write('event: guardian' + String.fromCharCode(10) + 'data: ' + JSON.stringify(event) + String.fromCharCode(10, 10))
      res.write('event: hello' + String.fromCharCode(10) + 'data: ' + JSON.stringify(await service.snapshot(sessionId)) + String.fromCharCode(10, 10))
      const dispose = service.subscribe(sessionId, (view) => send({ type: 'state', view }))
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
      heartbeat.unref?.()
      req.on('close', () => {
        clearInterval(heartbeat)
        dispose()
        res.end()
      })
    }
  })

  add({
    kind: 'exact',
    path: GUARDIAN_API_BASE + '/history',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const sessionId = sessionOf(req.url ?? '')
      if (sessionId === null) return sendJson(res, 400, { error: 'missing session' })
      sendJson(res, 200, { entries: await service.history(sessionId, 50) })
    }
  })

  add({
    kind: 'exact',
    path: GUARDIAN_API_BASE + '/request-now',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = await readBody(req)
        if (body.sessionId === undefined) return sendJson(res, 400, { error: 'missing sessionId' })
        const view = await service.requestNow(String(body.sessionId), {
          reason: body.final === true ? 'final' : 'manual',
          final: body.final === true
        })
        sendJson(res, 200, { ok: true, view })
      } catch (error) {
        sendJson(res, 500, { error: String(error) })
      }
    }
  })

  add({
    kind: 'exact',
    path: GUARDIAN_API_BASE + '/resume',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = await readBody(req)
        if (body.sessionId === undefined) return sendJson(res, 400, { error: 'missing sessionId' })
        sendJson(res, 200, { ok: true, view: await service.resume(String(body.sessionId)) })
      } catch (error) {
        sendJson(res, 500, { error: String(error) })
      }
    }
  })

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
