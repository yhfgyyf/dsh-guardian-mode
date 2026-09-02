
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAuditCommand, renderStatus, renderHistory, executeAuditCommand } from '../lib/commands.js'
import { AUDIT_CAPABILITY } from '../lib/capability.js'

test('parseAuditCommand handles all five forms', () => {
  assert.deepEqual(parseAuditCommand(''), { kind: 'status' })
  assert.deepEqual(parseAuditCommand('status'), { kind: 'status' })
  assert.deepEqual(parseAuditCommand('now'), { kind: 'now' })
  assert.deepEqual(parseAuditCommand('history'), { kind: 'history' })
  assert.deepEqual(parseAuditCommand('accept audit-1'), { kind: 'accept', auditId: 'audit-1' })
  assert.deepEqual(parseAuditCommand('resume'), { kind: 'resume' })
  assert.deepEqual(parseAuditCommand('bogus'), { kind: 'invalid' })
})

test('renderStatus shows capability, reviewer ids, pause, and feedback', () => {
  const out = renderStatus({
    active: true, capability: AUDIT_CAPABILITY, status: 'paused', completedSteps: 5, regularAuditCount: 2,
    lastVerdict: 'warning', paused: true, pauseReason: 'safety', failureCount: 0,
    summaryCount: 5, auditCount: 2, traceCursor: 9, threads: { summarizer: 'summary-1', auditor: 'audit-1' },
    models: { summarizer: 'fast-model', auditor: 'strong-model' },
    lastAudit: { summary: 'reviewed', findings: [{ recommendation: 'fix it' }] }, finalAudit: undefined
  })
  assert.match(out, /Capability: audit/)
  assert.match(out, /Steps: 5/)
  assert.match(out, /summarizer=summary-1/)
  assert.match(out, /auditor=strong-model/)
  assert.match(out, /warning/)
  assert.match(out, /Pause: safety/)
  assert.match(out, /fix it/)
  const pending = renderStatus({
    active: true, capability: AUDIT_CAPABILITY, status: 'warning', completedSteps: 5,
    regularAuditCount: 2, lastVerdict: 'warning', paused: false, failureCount: 0,
    summaryCount: 5, auditCount: 2, traceCursor: 9, threads: {}, finalAudit: undefined,
    pendingApproval: { auditId: 'audit-warning', verdict: 'warning', status: 'pending' }
  })
  assert.match(pending, /Web\/TUI edit action/)
  const retry = renderStatus({
    active: true, capability: AUDIT_CAPABILITY, status: 'remediation-execution-failed', completedSteps: 5,
    regularAuditCount: 2, lastVerdict: 'critical', paused: true, pauseReason: 'remediation', failureCount: 0,
    summaryCount: 5, auditCount: 2, traceCursor: 9, threads: {}, finalAudit: undefined,
    pendingApproval: { auditId: 'audit-1', verdict: 'critical', status: 'accepted' },
    remediation: { id: 'remediation-audit-1', auditId: 'audit-1', phase: 'execution-failed' }
  })
  assert.match(retry, /Retry: \/audit accept audit-1/)
  assert.doesNotMatch(retry, /Resume:/)
})

test('renderHistory formats audits', () => {
  assert.equal(renderHistory([]), 'No audits recorded yet.')
  const out = renderHistory([{ sequence: 3, verdict: 'critical', fullAlignment: true, finishedAt: 1000 }])
  assert.match(out, /#3 critical · full-align/)
})

test('executeAuditCommand wires the five verbs through the service', async () => {
  const snapshots = [{ active: true, capability: 'audit', status: 'pass', completedSteps: 2, regularAuditCount: 1, paused: false, failureCount: 0, summaryCount: 1, auditCount: 1, traceCursor: 2, threads: {}, finalAudit: undefined }]
  const service = {
    snapshot: async () => snapshots[0],
    requestNow: async () => ({ auditSequence: 3, paused: false, lastAudit: { verdict: 'pass' } }),
    history: async () => [{ sequence: 1, verdict: 'pass', fullAlignment: false, reason: 'auto', finishedAt: 1 }],
    accept: async () => ({ remediation: { phase: 'queued', id: 'remediation-1' } }),
    resume: async () => ({ paused: false })
  }
  const ctx = { get: (name) => name === 'audits' ? service : undefined }
  const invocation = (rawInput) => ({ rawInput, agent: { id: 's1', session: { id: 's1' } } })
  assert.equal((await executeAuditCommand(ctx, invocation('status'))).kind, 'success')
  assert.match((await executeAuditCommand(ctx, invocation('now'))).text, /Audit #3: pass/)
  assert.match((await executeAuditCommand(ctx, invocation('history'))).text, /#1 pass/)
  assert.match((await executeAuditCommand(ctx, invocation('accept audit-1'))).text, /remediation accepted/)
  assert.match((await executeAuditCommand(ctx, invocation('resume'))).text, /resumed/)
  assert.equal((await executeAuditCommand(ctx, invocation('nope'))).kind, 'error')
  const empty = { get: () => undefined }
  assert.equal((await executeAuditCommand(empty, invocation('status'))).kind, 'error')
})
