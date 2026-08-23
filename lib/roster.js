import { fileURLToPath } from 'node:url'

export const GUARDIAN_PRESET_ROOT = fileURLToPath(new URL('../presets/', import.meta.url))

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
 * discovery all see the guardian preset without touching the shipped roster.
 */
export function installPresetRoot (agentPresets, discover, root = GUARDIAN_PRESET_ROOT, trust = 'system') {
  const previous = agentPresets.list
  async function listWithGuardian () {
    const [packagePresets, existingPresets] = await Promise.all([
      discover([{ path: root, trust }]),
      previous.call(agentPresets)
    ])
    return mergePresetLists(packagePresets, existingPresets)
  }
  agentPresets.list = listWithGuardian
  return () => {
    if (agentPresets.list === listWithGuardian) agentPresets.list = previous
  }
}
