
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGuardianCommand, renderStatus, renderHistory, executeGuardianCommand } from '../lib/commands.js'
import { GUARDIAN_CAPABILITY } from '../lib/capability.js'

test('parseGuardianCommand handles all five forms', () => {
  assert.deepEqual(parseGuardianCommand(''), { kind: 'status' })
  assert.deepEqual(parseGuardianCommand('status'), { kind: 'status' })
  assert.deepEqual(parseGuardianCommand('now'), { kind: 'now' })
  assert.deepEqual(parseGuardianCommand('history'), { kind: 'history' })
  assert.deepEqual(parseGuardianCommand('accept audit-1'), { kind: 'accept', auditId: 'audit-1' })
  assert.deepEqual(parseGuardianCommand('resume'), { kind: 'resume' })
  assert.deepEqual(parseGuardianCommand('bogus'), { kind: 'invalid' })
})

test('renderStatus shows capability, reviewer ids, pause, and feedback', () => {
  const out = renderStatus({
    active: true, capability: GUARDIAN_CAPABILITY, status: 'paused', completedSteps: 5, regularAuditCount: 2,
    lastVerdict: 'warning', paused: true, pauseReason: 'safety', failureCount: 0,
    summaryCount: 5, auditCount: 2, traceCursor: 9, threads: { luna: 'luna-1', sol: 'sol-1' },
    lastAudit: { summary: 'reviewed', findings: [{ recommendation: 'fix it' }] }, finalAudit: undefined
  })
  assert.match(out, /Capability: guardian/)
  assert.match(out, /Steps: 5/)
  assert.match(out, /luna=luna-1/)
  assert.match(out, /warning/)
  assert.match(out, /Pause: safety/)
  assert.match(out, /fix it/)
  const retry = renderStatus({
    active: true, capability: GUARDIAN_CAPABILITY, status: 'remediation-execution-failed', completedSteps: 5,
    regularAuditCount: 2, lastVerdict: 'critical', paused: true, pauseReason: 'remediation', failureCount: 0,
    summaryCount: 5, auditCount: 2, traceCursor: 9, threads: {}, finalAudit: undefined,
    pendingApproval: { auditId: 'audit-1', verdict: 'critical', status: 'accepted' },
    remediation: { id: 'remediation-audit-1', auditId: 'audit-1', phase: 'execution-failed' }
  })
  assert.match(retry, /Retry: \/guardian accept audit-1/)
  assert.doesNotMatch(retry, /Resume:/)
})

test('renderHistory formats audits', () => {
  assert.equal(renderHistory([]), 'No audits recorded yet.')
  const out = renderHistory([{ sequence: 3, verdict: 'critical', fullAlignment: true, finishedAt: 1000 }])
  assert.match(out, /#3 critical · full-align/)
})

test('executeGuardianCommand wires the five verbs through the service', async () => {
  const snapshots = [{ active: true, capability: 'guardian', status: 'pass', completedSteps: 2, regularAuditCount: 1, paused: false, failureCount: 0, summaryCount: 1, auditCount: 1, traceCursor: 2, threads: {}, finalAudit: undefined }]
  const service = {
    snapshot: async () => snapshots[0],
    requestNow: async () => ({ auditSequence: 3, paused: false, lastAudit: { verdict: 'pass' } }),
    history: async () => [{ sequence: 1, verdict: 'pass', fullAlignment: false, reason: 'auto', finishedAt: 1 }],
    accept: async () => ({ remediation: { phase: 'queued', id: 'remediation-1' } }),
    resume: async () => ({ paused: false })
  }
  const ctx = { get: (name) => name === 'guardians' ? service : undefined }
  const invocation = (rawInput) => ({ rawInput, agent: { id: 's1', session: { id: 's1' } } })
  assert.equal((await executeGuardianCommand(ctx, invocation('status'))).kind, 'success')
  assert.match((await executeGuardianCommand(ctx, invocation('now'))).text, /audit #3: pass/)
  assert.match((await executeGuardianCommand(ctx, invocation('history'))).text, /#1 pass/)
  assert.match((await executeGuardianCommand(ctx, invocation('accept audit-1'))).text, /remediation accepted/)
  assert.match((await executeGuardianCommand(ctx, invocation('resume'))).text, /resumed/)
  assert.equal((await executeGuardianCommand(ctx, invocation('nope'))).kind, 'error')
  const empty = { get: () => undefined }
  assert.equal((await executeGuardianCommand(empty, invocation('status'))).kind, 'error')
})
