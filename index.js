import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'
import { GUARDIAN_PRESET_ROOT, installPresetRoot } from './lib/roster.js'
import { GuardianService, Config as ServiceConfig } from './lib/service.js'
import { registerGuardianCommand } from './lib/commands.js'
import { registerGuardianApi } from './lib/api.js'

/** Stable Cordis plugin identity. */
export const name = 'dsh-guardian-mode'

export const inject = ['agentPresets', 'agents', 'sessionPersistence']
export const Config = ServiceConfig

/**
 * Host bundle: add the guardian preset to the roster, provide the guardian
 * service, register /guardian, and mount the Remote API when a webserver
 * exists. Unaccepted reviews remain sidecar-only; an accepted review is queued
 * as a new, bounded remediation message instead of rewriting prior history.
 */
export function apply (ctx, config) {
  const restoreRoster = installPresetRoot(ctx.agentPresets, discoverPresets, GUARDIAN_PRESET_ROOT, 'system')
  ctx.effect(() => restoreRoster, name + '.roster()')

  const service = new GuardianService(ctx, config)
  const disposeCommand = registerGuardianCommand(ctx)
  if (disposeCommand !== undefined) ctx.effect(() => disposeCommand, name + '.command()')
  ctx.inject(['webServer'], (webCtx) => registerGuardianApi(webCtx, service))
}

export { GUARDIAN_CAPABILITY, GUARDIAN_PRESET_ID } from './lib/capability.js'
export { GuardianService } from './lib/service.js'
export { extractJson, coerceVerdict, BOUNDARY_RULES, GuardianEngine } from './lib/engine.js'
export { sidecarRoot, sidecarPath, SidecarStore } from './lib/sidecar.js'
export { CodexClient, CodexError } from './lib/codex.js'
export { GUARDIAN_SERVICE, GUARDIAN_API_BASE, GUARDIAN_DOCK_ORDER, GUARDIAN_SLOT, GUARDIAN_DOCK_ID } from './lib/invariant.js'
