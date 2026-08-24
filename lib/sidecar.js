/**
 * Sidecar store for guardian audit feedback.
 *
 * The durable rule of the mode: unaccepted audit feedback, summaries, verdicts,
 * findings, and reviewer state stay out of the DSH session log. Explicit user
 * acceptance creates a bounded remediation prompt at the tail of the main
 * context; the raw reviewer output remains here, keyed by session id:
 *
 *   ${DSH_HOME:-~/.dsh}/guardian/sidecars/<sessionId>.json
 *
 * Writes are atomic (temp + rename) so a crash never leaves a torn state.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises'
import { emptyState } from './core.js'

export function sidecarRoot (env = process.env) {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'guardian', 'sidecars')
}

export function sidecarPath (sessionId, env) {
  return join(sidecarRoot(env), String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_') + '.json')
}

export class SidecarStore {
  constructor ({ env } = {}) {
    this.env = env ?? process.env
    this.root = sidecarRoot(this.env)
  }

  async load (sessionId) {
    let raw
    try {
      raw = await readFile(sidecarPath(sessionId, this.env), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    const parsed = JSON.parse(raw)
    return { ...emptyState(sessionId, parsed.createdAt), ...parsed, version: 2, sessionId }
  }

  async save (sessionId, state) {
    const fresh = { ...state, sessionId, updatedAt: Date.now() }
    await mkdir(this.root, { recursive: true })
    const file = sidecarPath(sessionId, this.env)
    const tmp = file + '.' + process.pid + '.tmp'
    await writeFile(tmp, JSON.stringify(fresh, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, file)
    return fresh
  }

  async remove (sessionId) {
    try {
      await rm(sidecarPath(sessionId, this.env), { force: true })
    } catch {
      // deletion is best-effort: a tombstone left behind is harmless
    }
  }

  async list () {
    let names
    try { names = await readdir(this.root) } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
  }

  /** Seed a fork without sharing mutable arrays or final-audit state. */
  async clone (parentSessionId, childSessionId, now = Date.now()) {
    const parent = await this.load(parentSessionId)
    if (parent === undefined) return undefined
    const child = structuredClone(parent)
    child.sessionId = childSessionId
    child.createdAt = now
    child.updatedAt = now
    child.paused = false
    child.pauseReason = undefined
    child.status = 'idle'
    child.finalAudit = undefined
    child.pendingApproval = undefined
    child.remediation = undefined
    child.threads = { luna: undefined, sol: undefined }
    return await this.save(childSessionId, child)
  }
}
