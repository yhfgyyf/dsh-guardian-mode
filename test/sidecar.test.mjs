
import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emptyState } from '../lib/core.js'
import { SidecarStore, sidecarPath, sidecarRoot } from '../lib/sidecar.js'

test('sidecar round-trips state and never touches the session log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-sidecar-'))
  const env = { DSH_HOME: dir }
  const store = new SidecarStore({ env })
  assert.equal(store.root, join(dir, 'audit', 'sidecars'))
  assert.ok(sidecarPath('session-abc', env).endsWith('session-abc.json'))
  assert.equal(await store.load('session-abc'), undefined)
  await store.save('session-abc', { version: 1, round: 3, audits: [{ round: 1, verdict: 'pass' }] })
  const loaded = await store.load('session-abc')
  assert.equal(loaded.round, 3)
  assert.equal(loaded.audits.length, 1)
  assert.equal(loaded.version, 3)
  assert.equal(loaded.pendingApproval, undefined)
  assert.equal(loaded.remediation, undefined)
  // sanitized sidecar file name for hostile ids
  assert.equal(sidecarPath('../evil', env).startsWith(sidecarRoot(env) + '/'), true)
  assert.equal(sidecarPath('../evil', env).split('/').pop().includes('/'), false)
})

test('retired sidecars migrate once into the audit namespace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-migration-'))
  const env = { DSH_HOME: dir }
  const retired = ['guard', 'ian'].join('')
  const retiredDir = join(dir, retired, 'sidecars')
  const retiredFile = join(retiredDir, 'session-old.json')
  await mkdir(retiredDir, { recursive: true })
  await writeFile(retiredFile, JSON.stringify({
    version: 2,
    sessionId: 'session-old',
    status: 'warning',
    summaries: [],
    audits: [],
    threads: { summarizer: 'summary-thread', auditor: 'audit-thread' },
    pendingApproval: { auditId: 'audit-old', verdict: 'warning', status: 'pending', prompt: `<${retired}-remediation>repair</${retired}-remediation>` }
  }))
  const store = new SidecarStore({ env })
  assert.equal(await store.migrateRetired(), 1)
  const loaded = await store.load('session-old')
  assert.equal(loaded.version, 3)
  assert.match(loaded.pendingApproval.prompt, /<audit-remediation>/)
  assert.doesNotMatch(await readFile(sidecarPath('session-old', env), 'utf8'), new RegExp(retired, 'i'))
  await assert.rejects(access(retiredFile), { code: 'ENOENT' })
  await rm(dir, { recursive: true, force: true })
})

test('legacy pending approvals gain an editable draft when loaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-sidecar-'))
  const env = { DSH_HOME: dir }
  const store = new SidecarStore({ env })
  const state = emptyState('legacy-edit', 1)
  state.lastAudit = {
    id: 'audit-legacy',
    verdict: 'warning',
    summary: 'legacy summary',
    findings: [{ message: 'legacy gap', recommendation: 'repair legacy gap' }]
  }
  state.pendingApproval = {
    auditId: 'audit-legacy',
    verdict: 'warning',
    status: 'pending',
    prompt: '<audit-remediation>legacy</audit-remediation>'
  }
  await store.save('legacy-edit', state)
  const loaded = await new SidecarStore({ env }).load('legacy-edit')
  assert.match(loaded.pendingApproval.editableText, /legacy summary/)
  assert.match(loaded.pendingApproval.editableText, /repair legacy gap/)
  await rm(dir, { recursive: true, force: true })
})

test('sidecar removal is best-effort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-sidecar-'))
  const env = { DSH_HOME: dir }
  const store = new SidecarStore({ env })
  await store.save('s1', { round: 1 })
  await store.remove('s1')
  assert.equal(await store.load('s1'), undefined)
  await store.remove('nope') // no throw
  await rm(dir, { recursive: true, force: true })
})

test('fork clone keeps history but resets thread ids and pause state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-sidecar-'))
  const store = new SidecarStore({ env: { DSH_HOME: dir } })
  await store.save('parent', {
    paused: true,
    pauseReason: 'safety',
    threads: { luna: 'legacy-summary-parent', sol: 'legacy-audit-parent' },
    audits: [{ id: 'audit-1', verdict: 'pass' }],
    summaries: []
  })
  const child = await store.clone('parent', 'child', 10)
  assert.equal(child.paused, false)
  assert.deepEqual(child.threads, { summarizer: undefined, auditor: undefined })
  assert.equal(child.audits.length, 1)
  assert.equal(child.pendingApproval, undefined)
  assert.equal(child.remediation, undefined)
  assert.deepEqual((await store.list()).sort(), ['child', 'parent'])
  await rm(dir, { recursive: true, force: true })
})
