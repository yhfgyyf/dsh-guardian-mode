/**
 * `/guardian status|now|history|accept|resume` — the human-facing face of the mode.
 * Registered on the host commands registry so both the Web input trigger and
 * the TUI slash menu see it, exactly like /goal.
 */
export const USAGE = 'Usage: /guardian [status|now|history|accept [audit-id]|resume]'

export function parseGuardianCommand (rawInput) {
  const input = String(rawInput ?? '').trim()
  if (input === '') return { kind: 'status' }
  const [rawControl, auditId, ...extra] = input.split(/\s+/)
  const control = rawControl.toLowerCase()
  if (control === 'status') return { kind: 'status' }
  if (control === 'now') return { kind: 'now' }
  if (control === 'history') return { kind: 'history' }
  if (control === 'accept' && extra.length === 0) return { kind: 'accept', auditId }
  if (control === 'resume') return { kind: 'resume' }
  return { kind: 'invalid' }
}

export function renderStatus (view) {
  if (view?.active !== true) return 'Guardian is not active for this session.'
  const lines = [
    'Guardian',
    'Capability: ' + view.capability,
    'Status: ' + view.status,
    'Steps: ' + view.completedSteps + '  ·  audits: ' + view.auditCount + ' (' + view.regularAuditCount + ' regular)',
    'Last verdict: ' + (view.lastVerdict ?? '—'),
    'Pause: ' + (view.paused ? (view.pauseReason ?? 'paused') : 'no'),
    'Failures: ' + view.failureCount,
    'Summaries: ' + view.summaryCount + '  ·  trace cursor: ' + view.traceCursor,
    'Reviewer threads: luna=' + (view.threads?.luna ?? '—') + '  sol=' + (view.threads?.sol ?? '—'),
    'Final audit: ' + (view.finalAudit === undefined ? 'not yet' : (view.finalAudit.verified ? 'verified' : 'UNVERIFIED') + ' · ' + view.finalAudit.verdict + ' @ ' + view.finalAudit.at)
  ]
  if (view.lastAudit?.summary) lines.push('Feedback: ' + view.lastAudit.summary)
  for (const finding of view.lastAudit?.findings ?? []) lines.push('  - ' + finding.recommendation)
  if (view.pendingApproval?.status === 'pending') {
    lines.push('', 'Approval: ' + view.pendingApproval.verdict + ' audit ' + view.pendingApproval.auditId)
    lines.push('Accept: /guardian accept ' + view.pendingApproval.auditId)
  }
  if (view.remediation !== undefined) lines.push('Remediation: ' + view.remediation.phase + ' · ' + view.remediation.id)
  if (view.remediation !== undefined && ['failed', 'execution-failed', 'verification-failed'].includes(view.remediation.phase)) {
    lines.push('Retry: /guardian accept ' + view.remediation.auditId)
  }
  if (view.paused && (view.remediation === undefined || view.remediation.phase === 'completed') && view.pendingApproval?.verdict !== 'critical') lines.push('', 'Resume: /guardian resume')
  return lines.join(String.fromCharCode(10))
}

export function renderHistory (entries, limit) {
  if (entries.length === 0) return 'No audits recorded yet.'
  const tail = entries.slice(-Math.max(1, limit ?? entries.length))
  return ['Audit history:', ...tail.map((entry) => (
    '#' + entry.sequence + ' ' + (entry.errorCode ?? entry.verdict ?? 'ERROR') + ' · ' + (entry.fullAlignment ? 'full-align' : entry.reason) + ' · ' + new Date(entry.finishedAt).toISOString() +
      (entry.summary ? '\n    ' + entry.summary : '') +
      (entry.findings?.length ? '\n' + entry.findings.map((finding) => '    - ' + finding.recommendation).join('\n') : '')
  ))].join(String.fromCharCode(10))
}

export async function executeGuardianCommand (ctx, invocation) {
  const guardians = ctx.get('guardians')
  if (guardians === undefined) return { kind: 'error', text: 'guardian mode is not mounted in this deployment.' }
  const sessionId = invocation?.agent?.session?.id ?? invocation?.agent?.id
  if (sessionId === undefined) return { kind: 'error', text: 'no live session to guard. ' + USAGE }
  const command = parseGuardianCommand(invocation.rawInput)
  switch (command.kind) {
    case 'status':
      return { kind: 'success', text: renderStatus(await guardians.snapshot(String(sessionId))) }
    case 'now': {
      const view = await guardians.requestNow(String(sessionId), { reason: 'manual' })
      return { kind: 'success', text: 'Guardian audit #' + view.auditSequence + ': ' + (view.lastAudit?.errorCode ?? view.lastAudit?.verdict ?? 'unknown') + '.' + (view.paused ? ' (paused: ' + view.pauseReason + ')' : '') }
    }
    case 'history':
      return { kind: 'success', text: renderHistory(await guardians.history(String(sessionId))) }
    case 'accept': {
      const view = await guardians.accept(String(sessionId), command.auditId)
      return { kind: 'success', text: 'Guardian remediation accepted: ' + view.remediation?.phase + ' · ' + view.remediation?.id }
    }
    case 'resume': {
      const view = await guardians.resume(String(sessionId))
      return { kind: 'success', text: view?.paused ? 'Guardian still paused.' : 'Guardian resumed.' }
    }
    default:
      return { kind: 'error', text: USAGE }
  }
}

export function registerGuardianCommand (ctx) {
  const commands = ctx.get('commands')
  if (commands === undefined) return undefined
  return commands.register({
    name: 'guardian',
    description: 'Guardian mode: status, now (audit), history, accept, resume',
    input: { hint: 'status|now|history|accept [audit-id]|resume' },
    handler: (invocation) => executeGuardianCommand(ctx, invocation)
  })
}
