import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AuditEngine } from '../lib/engine.js'
import { SidecarStore } from '../lib/sidecar.js'

async function fixture (fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'audit-engine-'))
  let now = 0
  const calls = []
  const companion = {
    models: { summarizer: { model: 'gpt-5.6-luna', effort: 'medium' }, auditor: { model: 'gpt-5.6-sol', effort: 'max' } },
    async ensureThreads (state, args) {
      calls.push(['ensure', args])
      state.threads.summarizer = state.threads.summarizer ?? 'summary-thread'
      state.threads.auditor = state.threads.auditor ?? 'audit-thread'
    },
    async runSummary (_state, prompt) {
      calls.push(['summarizer', prompt])
      if (options.failRole === 'summarizer') throw new Error('summarizer unavailable')
      return { text: '{"intent":"fix","progress":"implemented","evidence":["tests"],"risks":[],"next":["verify"]}' }
    },
    async runAudit (_state, prompt) {
      calls.push(['auditor', prompt])
      if (options.failRole === 'auditor') throw new Error('auditor unavailable')
      return { text: JSON.stringify({ verdict: options.verdict ?? 'pass', summary: 'reviewed', findings: options.findings ?? [] }) }
    },
    async archive () { calls.push(['archive']) },
    async close () { calls.push(['close']) }
  }
  const store = new SidecarStore({ env: { DSH_HOME: dir } })
  const engine = new AuditEngine(store, companion, { now: () => now })
  const clock = (value) => { now = value }
  try { await fn({ engine, store, calls, clock }) } finally { await rm(dir, { recursive: true, force: true }) }
}

const events = [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'tool/call', data: { name: 'run_code', arguments: '{"cmd":"test"}' } },
  { seq: 2, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
  { seq: 3, type: 'step/end', data: { turn: 1, step: 1 } }
]

test('summarizer and auditor use independent persistent threads', async () => {
  await fixture(async ({ engine, calls }) => {
    await engine.attach('s1')
    const result = await engine.audit('s1', events, { objective: 'fix tests', reason: 'manual', force: true })
    assert.equal(result.audit.verdict, 'pass')
    assert.equal(result.audit.threads.summarizer, 'summary-thread')
    assert.equal(result.audit.threads.auditor, 'audit-thread')
    assert.deepEqual(calls.filter(([role]) => role === 'summarizer' || role === 'auditor').map(([role]) => role), ['summarizer', 'auditor'])
    assert.equal(result.state.traceCursor, 3)
  })
})

test('auto, manual, and final audit prompts respect approval-gated verdict isolation', async () => {
  await fixture(async ({ engine, calls }) => {
    await engine.attach('s1')
    await engine.audit('s1', events, { objective: 'verify evidence', reason: 'auto', force: true })
    await engine.audit('s1', events, { objective: 'verify evidence', reason: 'manual', force: true })
    await engine.audit('s1', events, { objective: 'verify evidence', reason: 'final', final: true, force: true })
    const summaryPrompts = calls.filter(([role]) => role === 'summarizer').map(([, prompt]) => prompt)
    const auditPrompts = calls.filter(([role]) => role === 'auditor').map(([, prompt]) => prompt)
    for (const [index, kind] of ['auto', 'manual', 'final'].entries()) {
      for (const prompt of [summaryPrompts[index], auditPrompts[index]]) {
        assert.match(prompt, new RegExp(`active ${kind} audit triggered after trace capture`))
        assert.match(prompt, /Unaccepted Audit verdicts and feedback are sidecar\/UI-only/)
        assert.match(prompt, /only inside a <audit-remediation> tail message after explicit user acceptance/)
        assert.match(prompt, /Do not report absent Audit output/)
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
    const secondPrompt = calls.filter(([role]) => role === 'summarizer')[1][1]
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
    assert.equal(result.state.pendingApproval.auditId, result.audit.id)
    assert.equal(result.state.pendingApproval.status, 'pending')
  }, { verdict: 'critical', findings: [{ message: 'bad dispatch', evidence: 'trace', recommendation: 'repair dispatch' }] })
})

test('accepted audit persists remediation lifecycle without rewriting audit history', async () => {
  await fixture(async ({ engine }) => {
    await engine.attach('s1')
    const result = await engine.audit('s1', events, { reason: 'manual', force: true })
    const accepted = await engine.accept('s1', result.audit.id, 'Apply only the reviewed dispatch repair.', 'next-step')
    assert.equal(accepted.remediation.phase, 'queued')
    assert.equal(accepted.remediation.instruction, 'Apply only the reviewed dispatch repair.')
    assert.equal(accepted.remediation.delivery, 'next-step')
    assert.equal(accepted.remediation.edited, true)
    assert.equal(accepted.auditCount, 1)
    await engine.remediationRunning('s1')
    await engine.remediationVerifying('s1')
    const settled = await engine.remediationSettled('s1', { id: 'verify-audit', verdict: 'pass' })
    assert.equal(settled.resumable, true)
    assert.equal(settled.view.remediation.phase, 'completed')
    assert.equal(settled.view.auditCount, 1)
  }, { verdict: 'warning', findings: [{ message: 'gap', evidence: 'trace', recommendation: 'repair it' }] })
})

test('a failed remediation turn is persisted without running verification', async () => {
  await fixture(async ({ engine }) => {
    await engine.attach('s1')
    const result = await engine.audit('s1', events, { reason: 'manual', force: true })
    await engine.accept('s1', result.audit.id)
    await engine.remediationRunning('s1')
    const failed = await engine.remediationFailed('s1', { kind: 'error', error: { code: 'MODEL_DOWN', message: 'offline' } })
    assert.equal(failed.remediation.phase, 'execution-failed')
    assert.equal(failed.remediation.executionFailure.code, 'MODEL_DOWN')
    assert.equal(failed.paused, true)
  }, { verdict: 'critical', findings: [] })
})

test('three consecutive infrastructure failures pause without model fallback', async () => {
  await fixture(async ({ engine }) => {
    await engine.attach('s1')
    for (let index = 0; index < 3; index++) await engine.audit('s1', events, { reason: 'manual', force: true })
    const view = await engine.snapshot('s1')
    assert.equal(view.paused, true)
    assert.equal(view.pauseReason, 'failures')
    assert.match(view.lastAudit.errorCode, /^SUMMARIZER_/)
    assert.equal(view.lastAudit.models.summarizer, 'gpt-5.6-luna')
  }, { failRole: 'summarizer' })
})

test('final audit failure is explicitly unverified', async () => {
  await fixture(async ({ engine }) => {
    await engine.attach('s1')
    const result = await engine.audit('s1', events, { reason: 'final', final: true, force: true })
    assert.equal(result.state.finalAudit.verified, false)
    assert.match(result.state.finalAudit.errorCode, /^AUDITOR_/)
  }, { failRole: 'auditor' })
})

test('malformed audit replies remain available in the sidecar for diagnosis', async () => {
  await fixture(async ({ engine }) => {
    engine.companion.runAudit = async () => ({ text: '{"unexpected":true}' })
    await engine.attach('s1')
    const result = await engine.audit('s1', events, { reason: 'manual', force: true })
    assert.equal(result.audit.errorCode, 'AUDITOR_FAILED')
    assert.equal(result.audit.rawOutput, '{"unexpected":true}')
  })
})

test('every fifth audit includes full objective alignment', async () => {
  await fixture(async ({ engine, calls }) => {
    await engine.attach('s1')
    for (let index = 0; index < 5; index++) await engine.audit('s1', events, { objective: 'objective-x', reason: 'manual', force: true })
    const fifth = calls.filter(([role]) => role === 'auditor')[4][1]
    assert.match(fifth, /Full alignment: true/)
    assert.match(fifth, /FULL OBJECTIVE:\nobjective-x/)
  })
})

test('stateless DSH-style reviewers receive the objective on every audit', async () => {
  await fixture(async ({ engine, calls }) => {
    engine.companion.persistent = false
    await engine.attach('s1')
    await engine.audit('s1', events, { objective: 'keep this exact objective', reason: 'manual', force: true })
    await engine.audit('s1', events, { objective: 'keep this exact objective', reason: 'manual', force: true })
    const secondSummary = calls.filter(([role]) => role === 'summarizer')[1][1]
    const secondAudit = calls.filter(([role]) => role === 'auditor')[1][1]
    assert.match(secondSummary, /CURRENT OBJECTIVE CONTEXT:\nkeep this exact objective/)
    assert.match(secondAudit, /FULL OBJECTIVE:\nkeep this exact objective/)
    assert.match(secondAudit, /PERSISTED PRIOR REVIEW CONTEXT/)
    assert.match(secondAudit, /"progress":"implemented"/)
  })
})

test('changing reviewer backends resets incompatible persisted handles', async () => {
  await fixture(async ({ engine, store, calls }) => {
    await store.save('s1', {
      ...await store.load('s1'),
      reviewer: 'claude-code',
      threads: { luna: 'claude-luna', sol: 'claude-sol' },
      audits: [],
      summaries: []
    })
    await engine.attach('s1')
    const state = await engine.get('s1')
    assert.equal(state.reviewer, 'codex')
    assert.deepEqual(state.threads, { summarizer: 'summary-thread', auditor: 'audit-thread' })
    assert.deepEqual(calls[0], ['ensure', { parentThreads: undefined }])
  })
})

test('legacy Luna/Sol sidecar handles migrate without losing reviewer history', async () => {
  await fixture(async ({ engine, store, calls }) => {
    await store.save('s1', {
      ...await store.load('s1'),
      reviewer: 'codex',
      threads: { luna: 'legacy-summary', sol: 'legacy-audit' },
      audits: [],
      summaries: []
    })
    await engine.attach('s1')
    const state = await engine.get('s1')
    assert.deepEqual(state.threads, { summarizer: 'legacy-summary', auditor: 'legacy-audit' })
    assert.deepEqual(calls[0], ['ensure', { parentThreads: undefined }])
  })
})
