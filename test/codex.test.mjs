import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODEX_DEFAULTS, CodexClient, CodexCompanion } from '../lib/codex.js'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.mjs')

test('Codex app-server uses two persistent threads and waits for turn/completed', async () => {
  const client = new CodexClient({ binary: process.execPath, args: [fixture], requestTimeoutMs: 2000 })
  const companion = new CodexCompanion(client, { models: CODEX_DEFAULTS, cwd: '/tmp' })
  const state = { sessionId: 's1', threads: {} }
  await companion.ensureThreads(state)
  assert.deepEqual(state.threads, { luna: 'fake-thread-1', sol: 'fake-thread-2' })
  const summary = await companion.runSummary(state, 'trace', {})
  assert.match(summary.text, /"progress":"tests pass"/)
  const audit = await companion.runAudit(state, 'audit', {})
  assert.match(audit.text, /"verdict":"pass"/)
  await companion.close()
})

test('Codex threads resume and fork without changing the requested models', async () => {
  const client = new CodexClient({ binary: process.execPath, args: [fixture], requestTimeoutMs: 2000 })
  const companion = new CodexCompanion(client, { models: CODEX_DEFAULTS, cwd: '/tmp' })
  const resumed = { sessionId: 'resume', threads: { luna: 'persisted-luna', sol: 'persisted-sol' } }
  await companion.ensureThreads(resumed)
  assert.deepEqual(resumed.threads, { luna: 'persisted-luna', sol: 'persisted-sol' })
  const forked = { sessionId: 'fork', threads: {} }
  await companion.ensureThreads(forked, { parentThreads: resumed.threads })
  assert.notEqual(forked.threads.luna, resumed.threads.luna)
  assert.notEqual(forked.threads.sol, resumed.threads.sol)
  await companion.archive(forked)
  await companion.close()
})
