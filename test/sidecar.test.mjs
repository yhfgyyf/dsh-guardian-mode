
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SidecarStore, sidecarPath, sidecarRoot } from '../lib/sidecar.js'

test('sidecar round-trips state and never touches the session log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-sidecar-'))
  const env = { DSH_HOME: dir }
  const store = new SidecarStore({ env })
  assert.equal(store.root, join(dir, 'guardian', 'sidecars'))
  assert.ok(sidecarPath('session-abc', env).endsWith('session-abc.json'))
  assert.equal(await store.load('session-abc'), undefined)
  await store.save('session-abc', { version: 1, round: 3, audits: [{ round: 1, verdict: 'pass' }] })
  const loaded = await store.load('session-abc')
  assert.equal(loaded.round, 3)
  assert.equal(loaded.audits.length, 1)
  assert.equal(loaded.version, 2)
  assert.equal(loaded.pendingApproval, undefined)
  assert.equal(loaded.remediation, undefined)
  // sanitized sidecar file name for hostile ids
  assert.equal(sidecarPath('../evil', env).startsWith(sidecarRoot(env) + '/'), true)
  assert.equal(sidecarPath('../evil', env).split('/').pop().includes('/'), false)
})

test('sidecar removal is best-effort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-sidecar-'))
  const env = { DSH_HOME: dir }
  const store = new SidecarStore({ env })
  await store.save('s1', { round: 1 })
  await store.remove('s1')
  assert.equal(await store.load('s1'), undefined)
  await store.remove('nope') // no throw
  await rm(dir, { recursive: true, force: true })
})

test('fork clone keeps history but resets thread ids and pause state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-sidecar-'))
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
