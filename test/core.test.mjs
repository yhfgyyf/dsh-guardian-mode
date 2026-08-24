import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CADENCE,
  acceptPendingApproval,
  applyOutcome,
  auditDue,
  emptyState,
  failRemediationExecution,
  markRemediationRunning,
  markRemediationVerifying,
  resume,
  setPendingApproval,
  settleRemediation,
  shouldFullAlign
} from '../lib/core.js'

test('first regular audit requires two steps and sixty seconds', () => {
  const state = emptyState('s1', 0)
  assert.equal(auditDue(state, { now: 59_999, completedSteps: 2 }), false)
  assert.equal(auditDue(state, { now: 60_000, completedSteps: 1 }), false)
  assert.equal(auditDue(state, { now: 60_000, completedSteps: 2 }), true)
})

test('later audit fires after three steps or three minutes with a one-minute gap', () => {
  const state = emptyState('s1', 0)
  state.regularAuditCount = 1
  state.lastAttemptAt = 60_000
  state.lastAttemptStep = 2
  assert.equal(auditDue(state, { now: 119_999, completedSteps: 5 }), false)
  assert.equal(auditDue(state, { now: 120_000, completedSteps: 5 }), true)
  assert.equal(auditDue(state, { now: 239_999, completedSteps: 2 }), false)
  assert.equal(auditDue(state, { now: 240_000, completedSteps: 2 }), true)
})

test('anomaly, manual, and final audit at the next safe boundary', () => {
  const state = emptyState('s1', 0)
  assert.equal(auditDue(state, { now: 1, anomaly: true }), true)
  assert.equal(auditDue(state, { now: 1, manual: true }), true)
  assert.equal(auditDue(state, { now: 1, final: true }), true)
})

test('every fifth audit is a full goal alignment', () => {
  for (let index = 1; index <= 15; index++) assert.equal(shouldFullAlign(index), index % CADENCE.fullAlignmentEvery === 0)
})

test('pass continues, warning continues, critical pauses', () => {
  const state = emptyState('s1', 0)
  applyOutcome(state, { verdict: 'pass' })
  assert.equal(state.paused, false)
  applyOutcome(state, { verdict: 'warning' })
  assert.equal(state.paused, false)
  applyOutcome(state, { verdict: 'critical' })
  assert.equal(state.paused, true)
  assert.equal(state.pauseReason, 'safety')
})

test('third consecutive reviewer failure pauses and resume clears it', () => {
  const state = emptyState('s1', 0)
  applyOutcome(state, { errorCode: 'LUNA_FAILED' })
  applyOutcome(state, { errorCode: 'LUNA_FAILED' })
  assert.equal(state.paused, false)
  applyOutcome(state, { errorCode: 'LUNA_FAILED' })
  assert.equal(state.pauseReason, 'failures')
  assert.equal(resume(state), true)
  assert.equal(state.paused, false)
  assert.equal(state.failureCount, 0)
})

test('warning approval is optional until accepted, then runs a paused repair round', () => {
  const state = emptyState('s1', 0)
  const audit = { id: 'audit-warning', sequence: 2, verdict: 'warning', summary: 'fix validation', findings: [{ message: 'gap', evidence: 'trace', recommendation: 'add the missing check' }] }
  applyOutcome(state, audit)
  setPendingApproval(state, audit, 10)
  assert.equal(state.paused, false)
  assert.equal(state.pendingApproval.status, 'pending')
  assert.match(state.pendingApproval.prompt, /add the missing check/)
  acceptPendingApproval(state, 'audit-warning', 20)
  assert.equal(state.paused, true)
  assert.equal(state.pauseReason, 'remediation')
  assert.equal(state.remediation.elevated, false)
  assert.equal(markRemediationRunning(state, 30), true)
  assert.equal(markRemediationVerifying(state, 40), true)
  assert.equal(settleRemediation(state, { id: 'verify', verdict: 'pass' }, 50), true)
  assert.equal(state.paused, false)
  assert.equal(state.remediation.phase, 'completed')
})

test('critical approval enables elevation and failed verification remains paused', () => {
  const state = emptyState('s1', 0)
  const audit = { id: 'audit-critical', sequence: 3, verdict: 'critical', summary: 'unsafe', findings: [] }
  applyOutcome(state, audit)
  setPendingApproval(state, audit, 10)
  acceptPendingApproval(state, 'audit-critical', 20)
  assert.equal(state.remediation.elevated, true)
  markRemediationRunning(state, 30)
  markRemediationVerifying(state, 40)
  assert.equal(settleRemediation(state, { id: 'verify', verdict: 'critical' }, 50), false)
  assert.equal(state.paused, true)
  assert.equal(state.pauseReason, 'safety')
  assert.equal(state.remediation.phase, 'failed')
})

test('stale approval is rejected and verification infrastructure failure fails closed', () => {
  const state = emptyState('s1', 0)
  const audit = { id: 'audit-1', sequence: 1, verdict: 'warning', findings: [] }
  setPendingApproval(state, audit, 10)
  assert.throws(() => acceptPendingApproval(state, 'audit-old', 20), /stale/)
  acceptPendingApproval(state, 'audit-1', 20)
  markRemediationRunning(state, 30)
  markRemediationVerifying(state, 40)
  assert.equal(settleRemediation(state, { id: 'verify', errorCode: 'SOL_FAILED' }, 50), false)
  assert.equal(state.status, 'remediation-verification-failed')
  assert.equal(state.paused, true)
})

test('failed repair execution stays paused and the same approval can be retried', () => {
  const state = emptyState('s1', 0)
  const audit = { id: 'audit-critical', sequence: 1, verdict: 'critical', findings: [] }
  setPendingApproval(state, audit, 10)
  acceptPendingApproval(state, audit.id, 20)
  markRemediationRunning(state, 30)
  assert.equal(failRemediationExecution(state, { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no key' } }, 40), true)
  assert.equal(state.remediation.phase, 'execution-failed')
  assert.equal(state.remediation.executionFailure.code, 'MISSING_CREDENTIAL')
  assert.equal(state.paused, true)
  acceptPendingApproval(state, audit.id, 50)
  assert.equal(state.remediation.phase, 'queued')
  assert.equal(state.remediation.retryCount, 1)
  assert.equal(state.remediation.executionFailure, undefined)
})
