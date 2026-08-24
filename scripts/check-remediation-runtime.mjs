import assert from 'node:assert/strict'
import { GuardianService } from '../lib/service.js'

const cordisNames = [
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine'
]

function fixture (verdict) {
  const restrictions = []
  const skillDefinitions = []
  const skillDisposals = []
  const sent = []
  const cancellations = []
  const remediationFailures = []
  const tools = {
    get: (name) => cordisNames.includes(name) ? { name } : undefined,
    restrict: (filter) => {
      const record = { filter, disposed: false }
      restrictions.push(record)
      return () => { record.disposed = true }
    }
  }
  const skills = {
    register: (definition) => {
      skillDefinitions.push(definition)
      return () => { skillDisposals.push(definition.name) }
    }
  }
  const agent = {
    status: 'running',
    session: { id: 'session-runtime', events: [] },
    ctx: { get: (name) => name === 'tools' ? tools : name === 'skills' ? skills : undefined },
    cancel: (...args) => cancellations.push(args),
    send: (message, target, wakeup) => sent.push({ message, target, wakeup })
  }
  const engine = {
    get: async () => ({
      pendingApproval: { status: 'pending', verdict },
      remediation: undefined
    }),
    accept: async (_sessionId, auditId) => ({
      remediation: {
        id: `remediation-${auditId}`,
        auditId,
        verdict,
        prompt: `repair ${verdict}`,
        phase: 'queued',
        elevated: verdict === 'critical'
      }
    }),
    remediationRunning: async () => {},
    remediationFailed: async (_sessionId, reason) => remediationFailures.push(reason)
  }
  const service = Object.create(GuardianService.prototype)
  service.runtime = new Map()
  service.ctx = { agents: { get: () => agent }, get: () => undefined }
  service._withLock = async (_sessionId, work) => await work()
  service._activate = async () => engine
  service._pauseGoal = () => {}
  service._emit = () => {}
  return { service, agent, restrictions, skillDefinitions, skillDisposals, sent, cancellations, remediationFailures }
}

const critical = fixture('critical')
critical.service._ensureCordisRestricted(critical.agent)
assert.deepEqual(critical.restrictions[0].filter.deny, cordisNames)
const accepted = await critical.service.accept('session-runtime', 'audit-critical')
assert.equal(accepted.remediation.phase, 'queued')
assert.equal(critical.restrictions[0].disposed, true)
assert.deepEqual(critical.skillDefinitions.map((skill) => skill.name), [
  'editing-cordis-compositions',
  'cordis-plugin-development'
])
assert.equal(critical.sent.length, 1)
assert.equal(critical.sent[0].message.source.kind, 'plugin')
const criticalText = critical.sent[0].message.content.map((block) => block.text ?? '').join('\n')
assert.match(criticalText, /editing-cordis-compositions/)
assert.match(criticalText, /cordis-plugin-development/)
assert.match(criticalText, /<guardian-capability-lease/)
assert.match(criticalText, /search_tools and describe_tools/)
assert.doesNotMatch(criticalText, /<skill_content/)
assert.equal(critical.sent[0].wakeup, true)
assert.equal(critical.cancellations[0][0].kind, 'hook')
assert.equal(critical.cancellations[0][1].keepInbox, true)
critical.service._disableRepairRuntime('session-runtime')
assert.deepEqual(critical.skillDisposals.sort(), ['cordis-plugin-development', 'editing-cordis-compositions'])
assert.equal(critical.restrictions.length, 2)

const warning = fixture('warning')
warning.service._ensureCordisRestricted(warning.agent)
await warning.service.accept('session-runtime', 'audit-warning')
assert.equal(warning.restrictions[0].disposed, false)
assert.equal(warning.skillDefinitions.length, 0)
assert.equal(warning.sent.length, 1)
assert.equal(warning.sent[0].message.source.kind, 'plugin')

const queueFailure = fixture('critical')
queueFailure.agent.send = () => { throw new Error('inbox unavailable') }
await assert.rejects(queueFailure.service.accept('session-runtime', 'audit-critical'), /inbox unavailable/)
assert.equal(queueFailure.remediationFailures[0].error.code, 'QUEUE_FAILED')
assert.equal(queueFailure.skillDisposals.length, 2)
assert.equal(queueFailure.restrictions.length, 1)

console.log('guardian approval runtime, stable tool discovery, and on-demand skill loading passed')
