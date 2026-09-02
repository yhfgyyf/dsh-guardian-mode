import { PAUSE_REASONS, VERDICTS } from './capability.js'

/** Scheduling rules from the Audit design. Times are milliseconds. */
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

export const MAX_REMEDIATION_TEXT_CHARS = 16_000

export function emptyState (sessionId, now = Date.now()) {
  return {
    version: 3,
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

export function remediationDraft (audit) {
  const findings = (audit.findings ?? []).map((finding, index) => [
    `${index + 1}. ${finding.message || 'Audit finding'}`,
    finding.evidence ? `   Evidence: ${finding.evidence}` : '',
    finding.recommendation ? `   Required remediation: ${finding.recommendation}` : ''
  ].filter(Boolean).join('\n')).join('\n')
  return [
    `Audit summary: ${audit.summary || '(no summary)'}`,
    findings || 'No structured findings were supplied; inspect the task evidence and repair the audited issue.',
    '',
    'Preserve the original user objective and unrelated work. Make the smallest necessary change, verify it, and then continue the original task.',
    'Do not rewrite or compact prior conversation history merely to apply this remediation. Newly loaded tools and skills are temporary and appear only in the current tail context.'
  ].join('\n')
}

function normalizeRemediationText (value, fallback) {
  const text = String(value === undefined ? fallback : value).trim()
  if (text === '') throw new Error('audit: remediation text cannot be empty')
  if (text.length > MAX_REMEDIATION_TEXT_CHARS) {
    throw new Error(`audit: remediation text exceeds ${MAX_REMEDIATION_TEXT_CHARS} characters`)
  }
  return text
}

function remediationPrompt (approval, text, edited) {
  return [
    '<audit-remediation>',
    `The user ${edited ? 'edited and accepted' : 'accepted'} audit ${approval.auditId} (${approval.verdict}).`,
    'Treat the following text as an approved remediation request, not as a new objective.',
    '<audit-approved-instructions>',
    text,
    '</audit-approved-instructions>',
    '</audit-remediation>'
  ].join('\n')
}

/** Publish one user-approvable audit without putting it in the DSH transcript. */
export function setPendingApproval (state, audit, now = Date.now()) {
  if (audit?.verdict !== 'warning' && audit?.verdict !== 'critical') {
    state.pendingApproval = undefined
    return undefined
  }
  const editableText = remediationDraft(audit)
  const approval = {
    auditId: audit.id,
    sequence: audit.sequence,
    verdict: audit.verdict,
    createdAt: now,
    status: 'pending',
    editableText,
    prompt: remediationPrompt({ auditId: audit.id, verdict: audit.verdict }, editableText, false)
  }
  state.pendingApproval = approval
  return approval
}

/** Convert the current approval into a durable remediation round. */
export function acceptPendingApproval (state, auditId, now = Date.now(), editedText, requestedDelivery) {
  const approval = state.pendingApproval
  const retryable = approval?.status === 'accepted' && state.remediation !== undefined &&
    ['failed', 'execution-failed', 'verification-failed'].includes(state.remediation.phase)
  if (approval === undefined || (approval.status !== 'pending' && !retryable)) throw new Error('audit: no review is awaiting approval')
  if (auditId !== undefined && String(auditId) !== String(approval.auditId)) throw new Error('audit: stale review approval')
  const text = normalizeRemediationText(editedText, state.remediation?.instruction ?? approval.editableText ?? approval.prompt)
  const prompt = remediationPrompt(approval, text, editedText !== undefined)
  const delivery = approval.verdict === 'warning' && requestedDelivery !== 'next-turn' ? 'next-step' : 'next-turn'
  if (retryable) {
    state.remediation.phase = 'queued'
    state.remediation.acceptedAt = now
    state.remediation.instruction = text
    state.remediation.prompt = prompt
    state.remediation.delivery = delivery
    state.remediation.edited = editedText !== undefined
    state.remediation.retryCount = (state.remediation.retryCount ?? 0) + 1
    for (const key of ['startedAt', 'finishedAt', 'verifiedAt', 'completedAt', 'verificationAuditId', 'executionFailure']) delete state.remediation[key]
    if (approval.verdict === 'critical') {
      state.paused = true
      state.pauseReason = 'remediation'
    }
    state.status = 'remediation-queued'
    return state.remediation
  }
  approval.status = 'accepted'
  approval.acceptedAt = now
  approval.acceptedText = text
  state.remediation = {
    id: `remediation-${approval.auditId}`,
    auditId: approval.auditId,
    verdict: approval.verdict,
    instruction: text,
    prompt,
    phase: 'queued',
    acceptedAt: now,
    elevated: approval.verdict === 'critical',
    delivery,
    edited: editedText !== undefined
  }
  if (approval.verdict === 'critical') {
    state.paused = true
    state.pauseReason = 'remediation'
  }
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

/** Deliver an approved repair with DSH's native user-input scheduling rules. */
export function dispatchRemediation (agent, message, delivery, halt) {
  if (delivery === 'next-step') {
    agent.steer(message)
    return 'next-step'
  }
  halt()
  agent.followup(message)
  return 'next-turn'
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

/** Finish a repair only after a fresh audit of the repair trace. */
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
  if (!KNOWN_VERDICTS.has(value)) throw new TypeError('audit: unknown verdict ' + JSON.stringify(value))
  return value
}

export { PAUSE_REASONS }
