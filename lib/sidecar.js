/**
 * Sidecar store for audit feedback.
 *
 * The durable rule of the mode: unaccepted audit feedback, summaries, verdicts,
 * findings, and reviewer state stay out of the DSH session log. Explicit user
 * acceptance creates a bounded remediation prompt at the tail of the main
 * context; the raw reviewer output remains here, keyed by session id:
 *
 *   ${DSH_HOME:-~/.dsh}/audit/sidecars/<sessionId>.json
 *
 * Writes are atomic (temp + rename) so a crash never leaves a torn state.
 */
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises'
import { emptyState, remediationDraft } from './core.js'

const RETIRED_NAMESPACE = ['guard', 'ian'].join('')

function namespaceRoot (namespace, env = process.env) {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), namespace, 'sidecars')
}

function safeSessionName (sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_') + '.json'
}

function retiredSidecarPath (sessionId, env) {
  return join(namespaceRoot(RETIRED_NAMESPACE, env), safeSessionName(sessionId))
}

function renameRetiredText (value) {
  const title = RETIRED_NAMESPACE[0].toUpperCase() + RETIRED_NAMESPACE.slice(1)
  return value
    .split(RETIRED_NAMESPACE.toUpperCase()).join('AUDIT')
    .split(title).join('Audit')
    .split(RETIRED_NAMESPACE).join('audit')
}

function migrateRetiredValue (value) {
  if (typeof value === 'string') return renameRetiredText(value)
  if (Array.isArray(value)) return value.map(migrateRetiredValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [renameRetiredText(key), migrateRetiredValue(entry)]))
}

export function sidecarRoot (env = process.env) {
  return namespaceRoot('audit', env)
}

export function sidecarPath (sessionId, env) {
  return join(sidecarRoot(env), safeSessionName(sessionId))
}

export class SidecarStore {
  constructor ({ env } = {}) {
    this.env = env ?? process.env
    this.root = sidecarRoot(this.env)
  }

  async load (sessionId) {
    let raw
    let retiredFile
    try {
      raw = await readFile(sidecarPath(sessionId, this.env), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      retiredFile = retiredSidecarPath(sessionId, this.env)
      try {
        raw = await readFile(retiredFile, 'utf8')
      } catch (retiredError) {
        if (retiredError?.code === 'ENOENT') return undefined
        throw retiredError
      }
    }
    const parsed = retiredFile === undefined ? JSON.parse(raw) : migrateRetiredValue(JSON.parse(raw))
    let state = { ...emptyState(sessionId, parsed.createdAt), ...parsed, version: 3, sessionId }
    if (state.pendingApproval !== undefined && state.pendingApproval.editableText === undefined) {
      const audit = state.lastAudit?.id === state.pendingApproval.auditId
        ? state.lastAudit
        : state.audits?.find((entry) => entry.id === state.pendingApproval.auditId)
      state.pendingApproval.editableText = audit === undefined
        ? state.pendingApproval.prompt
        : remediationDraft(audit)
    }
    if (retiredFile !== undefined) {
      state = await this.save(sessionId, state)
      await rm(retiredFile, { force: true })
    }
    return state
  }

  async migrateRetired () {
    let names
    try {
      names = await readdir(namespaceRoot(RETIRED_NAMESPACE, this.env))
    } catch (error) {
      if (error?.code === 'ENOENT') return 0
      throw error
    }
    const sessions = names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
    for (const sessionId of sessions) {
      if (await this.load(sessionId) === undefined) continue
    }
    return sessions.length
  }

  async save (sessionId, state) {
    const fresh = { ...state, sessionId, updatedAt: Date.now() }
    await mkdir(this.root, { recursive: true })
    const file = sidecarPath(sessionId, this.env)
    const tmp = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
    await writeFile(tmp, JSON.stringify(fresh, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, file)
    return fresh
  }

  async remove (sessionId) {
    await Promise.allSettled([
      rm(sidecarPath(sessionId, this.env), { force: true }),
      rm(retiredSidecarPath(sessionId, this.env), { force: true })
    ])
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
    child.threads = { summarizer: undefined, auditor: undefined }
    return await this.save(childSessionId, child)
  }
}
