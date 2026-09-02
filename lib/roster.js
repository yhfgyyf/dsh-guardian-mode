import { fileURLToPath } from 'node:url'
import { normalizeAuditPresetId } from './capability.js'

export const AUDIT_PRESET_ROOT = fileURLToPath(new URL('../presets/', import.meta.url))

/** Package presets win duplicate ids, matching configured-root precedence. */
export function mergePresetLists (packagePresets, existingPresets) {
  const byId = new Map()
  for (const preset of [...packagePresets, ...existingPresets]) {
    if (!byId.has(preset.id)) byId.set(preset.id, preset)
  }
  return [...byId.values()]
}

/**
 * Extend the public roster list seam (same pattern as dsh-auto-preset-router):
 * AgentPresets.resolve() calls list(), so selection, mounting, resume, and UI
 * discovery all see the audit preset without touching the shipped roster.
 */
export function installPresetRoot (agentPresets, discover, root = AUDIT_PRESET_ROOT, trust = 'system', harnessBase) {
  const previous = agentPresets.list
  const previousResolve = agentPresets.resolve
  async function listWithAudit () {
    const [packagePresets, existingPresets] = await Promise.all([
      discover([{ path: root, trust }], harnessBase),
      previous.call(agentPresets)
    ])
    return mergePresetLists(packagePresets, existingPresets)
  }
  agentPresets.list = listWithAudit
  async function resolveWithAudit (id) {
    return await previousResolve.call(agentPresets, normalizeAuditPresetId(id))
  }
  if (typeof previousResolve === 'function') agentPresets.resolve = resolveWithAudit
  return () => {
    if (agentPresets.list === listWithAudit) agentPresets.list = previous
    if (agentPresets.resolve === resolveWithAudit) agentPresets.resolve = previousResolve
  }
}
