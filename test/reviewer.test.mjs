import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexCompanion } from '../lib/codex.js'
import {
  ClaudeCodeClient,
  DshReviewerClient,
  createReviewerCompanion,
  resolveReviewerOptions
} from '../lib/reviewer.js'

const fakeClaude = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs')
const models = {
  luna: { model: 'claude-haiku-4-5', effort: 'medium' },
  sol: { model: 'claude-opus-4-6', effort: 'max' }
}

test('reviewer config defaults to the existing Codex Luna/Sol pair', () => {
  const options = resolveReviewerOptions()
  assert.equal(options.type, 'codex')
  assert.equal(options.binary, 'codex')
  assert.deepEqual(options.models, {
    luna: { model: 'gpt-5.6-luna', effort: 'medium' },
    sol: { model: 'gpt-5.6-sol', effort: 'max' }
  })
})

test('reviewer config preserves old Codex fields and accepts DSH provider overrides', () => {
  const options = resolveReviewerOptions({
    reviewer: 'dsh',
    binary: '/custom/codex',
    args: ['server'],
    dshProvider: 'private-route',
    models: { luna: { model: 'fast', effort: 'off', provider: 'fast-route' }, sol: { model: 'deep', effort: 'high' } }
  })
  assert.equal(options.type, 'dsh')
  assert.equal(options.binary, '/custom/codex')
  assert.deepEqual(options.args, ['server'])
  assert.equal(options.dshProvider, 'private-route')
  assert.equal(options.models.luna.provider, 'fast-route')
  assert.equal(options.models.sol.provider, undefined)
})

test('Claude Code reviewer uses safe print mode and persistent role sessions', async () => {
  const client = new ClaudeCodeClient({ binary: process.execPath, args: [fakeClaude], requestTimeoutMs: 2000 })
  const companion = new CodexCompanion(client, { models, cwd: '/tmp' })
  const state = { sessionId: 'claude-session', threads: {} }
  await companion.ensureThreads(state)
  const original = { ...state.threads }
  const summary = await companion.runSummary(state, 'trace', { type: 'object', properties: { progress: { type: 'string' } } })
  assert.match(summary.text, /claude summarized/)
  assert.deepEqual(state.threads, original)
  const audit = await companion.runAudit(state, 'audit', { type: 'object', properties: { verdict: { type: 'string' } } })
  assert.match(audit.text, /claude reviewed/)
  const repeated = await companion.runSummary(state, 'more trace', { type: 'object', properties: { progress: { type: 'string' } } })
  assert.match(repeated.text, /claude summarized/)
})

test('Claude Code child sessions fork the parent reviewer history handle lazily', async () => {
  const client = new ClaudeCodeClient({ binary: process.execPath, args: [fakeClaude], requestTimeoutMs: 2000 })
  const companion = new CodexCompanion(client, { models, cwd: '/tmp' })
  const child = { sessionId: 'child', threads: {} }
  await companion.ensureThreads(child, { parentThreads: { luna: 'parent-luna', sol: 'parent-sol' } })
  const pending = child.threads.luna
  await companion.runSummary(child, 'trace', { type: 'object', properties: { progress: { type: 'string' } } })
  assert.notEqual(child.threads.luna, pending)
  assert.equal(child.threads.luna, 'forked-parent-luna')
})

test('Claude Code reviewer rejects arguments that could bypass its fixed isolation', () => {
  assert.throws(
    () => new ClaudeCodeClient({ args: ['--fallback-model', 'sonnet'] }),
    error => error.code === 'CLAUDE_ARGS_CONFLICT'
  )
  assert.throws(
    () => new ClaudeCodeClient({ args: ['--tools=default'] }),
    error => error.code === 'CLAUDE_ARGS_CONFLICT'
  )
})

test('DSH reviewer calls the host LLM directly with no model-facing tools', async () => {
  const requests = []
  const llm = {
    async * stream (request) {
      requests.push(request)
      const audit = request.system.includes('independent, read-only reviewer')
      const text = audit
        ? '{"verdict":"pass","summary":"dsh reviewed","findings":[]}'
        : '{"intent":"test","progress":"dsh summarized","evidence":[],"risks":[],"next":[]}'
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const companion = createReviewerCompanion({ llm }, {
    reviewer: 'dsh',
    dshProvider: 'default-route',
    requestTimeoutMs: 2000,
    models: {
      luna: { provider: 'fast-route', model: 'fast-model', effort: 'off' },
      sol: { model: 'audit-model', effort: 'high' }
    }
  }, { cwd: '/tmp' })
  assert.equal(companion.client instanceof DshReviewerClient, true)
  assert.equal(companion.persistent, false)
  const state = { sessionId: 'dsh-session', threads: {} }
  await companion.ensureThreads(state)
  await companion.runSummary(state, 'trace', { type: 'object' })
  await companion.runAudit(state, 'audit', { type: 'object' })
  assert.equal(requests[0].provider, 'fast-route')
  assert.equal(requests[0].model, 'fast-model')
  assert.deepEqual(requests[0].tools, [])
  assert.equal(requests[1].provider, 'default-route')
  assert.equal(requests[1].model, 'audit-model')
  assert.deepEqual(requests[1].tools, [])
})
