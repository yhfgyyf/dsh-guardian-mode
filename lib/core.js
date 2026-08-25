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
    version: 2,
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
    reviewer: undefined,
    threads: { summarizer: undefined, auditor: undefined },
    lastSummary: undefined,
    lastAudit: undefined,
    finalAudit: undefined,
    pendingApproval: undefined,
    remediation: undefined,
    summaries: [],
    audits: []
  }
}

function remediationPrompt (audit) {
  const findings = (audit.findings ?? []).map((finding, index) => [
    `${index + 1}. ${finding.message || 'Guardian finding'}`,
    finding.evidence ? `   Evidence: ${finding.evidence}` : '',
    finding.recommendation ? `   Required remediation: ${finding.recommendation}` : ''
  ].filter(Boolean).join('\n')).join('\n')
  return [
    '<guardian-remediation>',
    `The user accepted Guardian audit ${audit.id} (${audit.verdict}).`,
    'Treat the following reviewer output as an approved remediation request, not as a new objective.',
    `Audit summary: ${audit.summary || '(no summary)'}`,
    findings || 'No structured findings were supplied; inspect the task evidence and repair the audited issue.',
    '',
    'Preserve the original user objective and unrelated work. Make the smallest necessary change, verify it, and then continue the original task.',
    'Do not rewrite or compact prior conversation history merely to apply this remediation. Newly loaded tools and skills are temporary and appear only in the current tail context.',
    '</guardian-remediation>'
  ].join('\n')
}

/** Publish one user-approvable audit without putting it in the DSH transcript. */
export function setPendingApproval (state, audit, now = Date.now()) {
  if (audit?.verdict !== 'warning' && audit?.verdict !== 'critical') {
    state.pendingApproval = undefined
    return undefined
  }
  const approval = {
    auditId: audit.id,
    sequence: audit.sequence,
    verdict: audit.verdict,
    createdAt: now,
    status: 'pending',
    prompt: remediationPrompt(audit)
  }
  state.pendingApproval = approval
  return approval
}

/** Convert the current approval into a durable, paused remediation round. */
export function acceptPendingApproval (state, auditId, now = Date.now()) {
  const approval = state.pendingApproval
  const retryable = approval?.status === 'accepted' && state.remediation !== undefined &&
    ['failed', 'execution-failed', 'verification-failed'].includes(state.remediation.phase)
  if (approval === undefined || (approval.status !== 'pending' && !retryable)) throw new Error('guardian: no review is awaiting approval')
  if (auditId !== undefined && String(auditId) !== String(approval.auditId)) throw new Error('guardian: stale review approval')
  if (retryable) {
    state.remediation.phase = 'queued'
    state.remediation.acceptedAt = now
    state.remediation.retryCount = (state.remediation.retryCount ?? 0) + 1
    for (const key of ['startedAt', 'finishedAt', 'verifiedAt', 'completedAt', 'verificationAuditId', 'executionFailure']) delete state.remediation[key]
    state.paused = true
    state.pauseReason = 'remediation'
    state.status = 'remediation-queued'
    return state.remediation
  }
  approval.status = 'accepted'
  approval.acceptedAt = now
  state.remediation = {
    id: `remediation-${approval.auditId}`,
    auditId: approval.auditId,
    verdict: approval.verdict,
    prompt: approval.prompt,
    phase: 'queued',
    acceptedAt: now,
    elevated: approval.verdict === 'critical'
  }
  state.paused = true
  state.pauseReason = 'remediation'
  state.status = 'remediation-queued'
  return state.remediation
}

export function markRemediationRunning (state, now = Date.now()) {
  if (state.remediation?.phase !== 'queued') return false
  state.remediation.phase = 'running'
  state.remediation.startedAt = now
  state.status = 'remediating'
  return true
}

export function markRemediationVerifying (state, now = Date.now()) {
  if (state.remediation?.phase !== 'running') return false
  state.remediation.phase = 'verifying'
  state.remediation.finishedAt = now
  state.status = 'remediation-verifying'
  return true
}

/** Fail closed when the approved repair turn itself did not complete. */
export function failRemediationExecution (state, reason, now = Date.now()) {
  if (state.remediation?.phase !== 'running') return false
  state.remediation.phase = 'execution-failed'
  state.remediation.finishedAt = now
  state.remediation.executionFailure = {
    kind: String(reason?.kind ?? 'error'),
    code: reason?.error?.code === undefined ? undefined : String(reason.error.code),
    message: String(reason?.error?.message ?? reason?.reason?.reason ?? 'the remediation turn did not complete').slice(0, 2000)
  }
  state.paused = true
  state.pauseReason = 'remediation'
  state.status = 'remediation-execution-failed'
  return true
}

/** Finish a repair only after a fresh Guardian audit of the repair trace. */
export function settleRemediation (state, audit, now = Date.now()) {
  if (state.remediation === undefined) return false
  state.remediation.verificationAuditId = audit?.id
  state.remediation.verifiedAt = now
  if (audit?.errorCode !== undefined) {
    state.remediation.phase = 'verification-failed'
    state.paused = true
    state.pauseReason = 'remediation'
    state.status = 'remediation-verification-failed'
    return false
  }
  if (audit?.verdict === 'critical') {
    state.remediation.phase = 'failed'
    state.paused = true
    state.pauseReason = 'safety'
    state.status = 'paused'
    return false
  }
  state.remediation.phase = 'completed'
  state.remediation.completedAt = now
  state.paused = false
  state.pauseReason = undefined
  state.failureCount = 0
  state.status = audit?.verdict ?? 'idle'
  return true
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
