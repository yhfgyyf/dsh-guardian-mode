import { PAUSE_REASONS, VERDICTS } from './capability.js'

/** Scheduling rules from the Guardian design. Times are milliseconds. */
export const CADENCE = Object.freeze({
  firstMinSteps: 2,
  firstMinMs: 60_000,
  regularStepInterval: 3,
  regularMs: 180_000,
  minGapMs: 60_000,
  fullAlignmentEvery: 5,
  failurePauseThreshold: 3,
  maxSummaries: 200,
  maxAudits: 1000
})

export function emptyState (sessionId, now = Date.now()) {
  return {
    version: 1,
    sessionId,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    status: 'idle',
    completedSteps: 0,
    auditSequence: 0,
    regularAuditCount: 0,
    lastVerdict: undefined,
    lastAuditAt: undefined,
    lastAuditStep: 0,
    lastAttemptAt: undefined,
    lastAttemptStep: 0,
    traceCursor: -1,
    pendingAnomaly: false,
    paused: false,
    pauseReason: undefined,
    failureCount: 0,
    threads: { luna: undefined, sol: undefined },
    lastSummary: undefined,
    lastAudit: undefined,
    finalAudit: undefined,
    summaries: [],
    audits: []
  }
}

/** Every fifth completed audit replays the full objective-alignment frame. */
export function shouldFullAlign (auditSequence) {
  return auditSequence > 0 && auditSequence % CADENCE.fullAlignmentEvery === 0
}

/** Decide whether a regular audit is due at a safe boundary. */
export function auditDue (state, {
  now = Date.now(),
  completedSteps = state.completedSteps,
  anomaly = state.pendingAnomaly,
  manual = false,
  final = false
} = {}) {
  if (manual || final || anomaly) return true
  if (state.regularAuditCount === 0) {
    return completedSteps >= CADENCE.firstMinSteps && now - state.startedAt >= CADENCE.firstMinMs
  }
  if (state.lastAttemptAt !== undefined && now - state.lastAttemptAt < CADENCE.minGapMs) return false
  return completedSteps - state.lastAttemptStep >= CADENCE.regularStepInterval ||
    (state.lastAttemptAt !== undefined && now - state.lastAttemptAt >= CADENCE.regularMs)
}

/** Apply one auditor outcome without silently converting infrastructure errors. */
export function applyOutcome (state, outcome) {
  if (outcome.errorCode !== undefined) {
    state.failureCount += 1
    state.lastVerdict = 'warning'
    if (state.failureCount >= CADENCE.failurePauseThreshold) {
      state.paused = true
      state.pauseReason = 'failures'
      state.status = 'paused'
    } else {
      state.status = 'warning'
    }
    return
  }

  state.failureCount = 0
  state.lastVerdict = assertVerdict(outcome.verdict)
  if (outcome.verdict === 'critical') {
    state.paused = true
    state.pauseReason = 'safety'
    state.status = 'paused'
  } else {
    state.status = outcome.verdict
  }
}

export function resume (state) {
  if (!state.paused) return false
  state.paused = false
  state.pauseReason = undefined
  state.failureCount = 0
  state.pendingAnomaly = false
  state.status = 'idle'
  return true
}

const KNOWN_VERDICTS = new Set(VERDICTS)

export function assertVerdict (value) {
  if (!KNOWN_VERDICTS.has(value)) throw new TypeError('guardian: unknown verdict ' + JSON.stringify(value))
  return value
}

export { PAUSE_REASONS }
