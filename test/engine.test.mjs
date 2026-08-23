import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GuardianEngine } from '../lib/engine.js'
import { SidecarStore } from '../lib/sidecar.js'

async function fixture (fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-engine-'))
  let now = 0
  const calls = []
  const companion = {
    models: { luna: { model: 'gpt-5.6-luna', effort: 'medium' }, sol: { model: 'gpt-5.6-sol', effort: 'max' } },
    async ensureThreads (state, args) {
      calls.push(['ensure', args])
      state.threads.luna = state.threads.luna ?? 'luna-thread'
      state.threads.sol = state.threads.sol ?? 'sol-thread'
    },
    async runSummary (_state, prompt) {
      calls.push(['luna', prompt])
      if (options.failRole === 'luna') throw new Error('luna unavailable')
      return { text: '{"intent":"fix","progress":"implemented","evidence":["tests"],"risks":[],"next":["verify"]}' }
    },
    async runAudit (_state, prompt) {
      calls.push(['sol', prompt])
      if (options.failRole === 'sol') throw new Error('sol unavailable')
      return { text: JSON.stringify({ verdict: options.verdict ?? 'pass', summary: 'reviewed', findings: options.findings ?? [] }) }
    },
    async archive () { calls.push(['archive']) },
    async close () { calls.push(['close']) }
  }
  const store = new SidecarStore({ env: { DSH_HOME: dir } })
  const engine = new GuardianEngine(store, companion, { now: () => now })
  const clock = (value) => { now = value }
  try { await fn({ engine, store, calls, clock }) } finally { await rm(dir, { recursive: true, force: true }) }
}

const events = [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'tool/call', data: { name: 'run_code', arguments: '{"cmd":"test"}' } },
  { seq: 2, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
  { seq: 3, type: 'step/end', data: { turn: 1, step: 1 } }
]

test('Luna summary and Sol audit use independent persistent threads', async () => {
  await fixture(async ({ engine, calls }) => {
    await engine.attach('s1')
    const result = await engine.audit('s1', events, { objective: 'fix tests', reason: 'manual', force: true })
    assert.equal(result.audit.verdict, 'pass')
    assert.equal(result.audit.threads.luna, 'luna-thread')
    assert.equal(result.audit.threads.sol, 'sol-thread')
    assert.deepEqual(calls.filter(([role]) => role === 'luna' || role === 'sol').map(([role]) => role), ['luna', 'sol'])
    assert.equal(result.state.traceCursor, 3)
  })
})

test('auto, manual, and final audit prompts respect sidecar-only verdict isolation', async () => {
  await fixture(async ({ engine, calls }) => {
    await engine.attach('s1')
    await engine.audit('s1', events, { objective: 'verify evidence', reason: 'auto', force: true })
    await engine.audit('s1', events, { objective: 'verify evidence', reason: 'manual', force: true })
    await engine.audit('s1', events, { objective: 'verify evidence', reason: 'final', final: true, force: true })
    const lunaPrompts = calls.filter(([role]) => role === 'luna').map(([, prompt]) => prompt)
    const solPrompts = calls.filter(([role]) => role === 'sol').map(([, prompt]) => prompt)
    for (const [index, kind] of ['auto', 'manual', 'final'].entries()) {
      for (const prompt of [lunaPrompts[index], solPrompts[index]]) {
        assert.match(prompt, new RegExp(`active ${kind} audit triggered after trace capture`))
        assert.match(prompt, /verdicts and feedback are intentionally sidecar\/UI-only/)
        assert.match(prompt, /never enter the main DSH trace/)
        assert.match(prompt, /Do not report absent Guardian output/)
      }
    }
  })
})

test('incremental trace advances cursor and does not mutate main session events', async () => {
  await fixture(async ({ engine, calls }) => {
    await engine.attach('s1')
    const original = structuredClone(events)
    await engine.audit('s1', events, { reason: 'manual', force: true })
    const later = [...events, { seq: 4, type: 'step/end', data: { turn: 1, step: 2 } }]
    await engine.audit('s1', later, { reason: 'manual', force: true })
    const secondPrompt = calls.filter(([role]) => role === 'luna')[1][1]
    assert.doesNotMatch(secondPrompt, /"seq":1/)
    assert.match(secondPrompt, /"seq":4/)
    assert.deepEqual(events, original)
  })
})

test('critical feedback pauses at the boundary and preserves recommendations', async () => {
  await fixture(async ({ engine }) => {
    await engine.attach('s1')
    const result = await engine.audit('s1', events, { reason: 'manual', force: true })
    assert.equal(result.state.paused, true)
    assert.equal(result.state.pauseReason, 'safety')
    assert.equal(result.state.lastAudit.findings[0].recommendation, 'repair dispatch')
  }, { verdict: 'critical', findings: [{ message: 'bad dispatch', evidence: 'trace', recommendation: 'repair dispatch' }] })
})

test('three consecutive infrastructure failures pause without model fallback', async () => {
  await fixture(async ({ engine }) => {
    await engine.attach('s1')
    for (let index = 0; index < 3; index++) await engine.audit('s1', events, { reason: 'manual', force: true })
    const view = await engine.snapshot('s1')
    assert.equal(view.paused, true)
    assert.equal(view.pauseReason, 'failures')
    assert.match(view.lastAudit.errorCode, /^LUNA_/)
    assert.equal(view.lastAudit.models.luna, 'gpt-5.6-luna')
  }, { failRole: 'luna' })
})

test('final audit failure is explicitly unverified', async () => {
  await fixture(async ({ engine }) => {
    await engine.attach('s1')
    const result = await engine.audit('s1', events, { reason: 'final', final: true, force: true })
    assert.equal(result.state.finalAudit.verified, false)
    assert.match(result.state.finalAudit.errorCode, /^SOL_/)
  }, { failRole: 'sol' })
})

test('every fifth audit includes full objective alignment', async () => {
  await fixture(async ({ engine, calls }) => {
    await engine.attach('s1')
    for (let index = 0; index < 5; index++) await engine.audit('s1', events, { objective: 'objective-x', reason: 'manual', force: true })
    const fifth = calls.filter(([role]) => role === 'sol')[4][1]
    assert.match(fifth, /Full alignment: true/)
    assert.match(fifth, /FULL OBJECTIVE:\nobjective-x/)
  })
})
