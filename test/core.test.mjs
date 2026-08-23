import test from 'node:test'
import assert from 'node:assert/strict'
import { CADENCE, applyOutcome, auditDue, emptyState, resume, shouldFullAlign } from '../lib/core.js'

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
