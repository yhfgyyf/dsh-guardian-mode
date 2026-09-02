import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'
import { AUDIT_PRESET_ROOT, installPresetRoot } from './lib/roster.js'
import { AuditService, Config as ServiceConfig } from './lib/service.js'
import { registerAuditCommand } from './lib/commands.js'
import { registerAuditApi } from './lib/api.js'

/** Stable Cordis plugin identity. */
export const name = 'dsh-audit-mode'

export const inject = ['agentPresets', 'agents', 'sessionPersistence', 'llm']
export const Config = ServiceConfig

/**
 * Host bundle: add the audit preset to the roster, provide the audit
 * service, register /audit, and mount the Remote API when a webserver
 * exists. Unaccepted reviews remain sidecar-only; an accepted review is queued
 * as a new, bounded remediation message instead of rewriting prior history.
 */
export function apply (ctx, config) {
  const restoreRoster = installPresetRoot(ctx.agentPresets, discoverPresets, AUDIT_PRESET_ROOT, 'system', ctx.baseUrl)
  ctx.effect(() => restoreRoster, name + '.roster()')

  const service = new AuditService(ctx, config)
  const disposeCommand = registerAuditCommand(ctx)
  if (disposeCommand !== undefined) ctx.effect(() => disposeCommand, name + '.command()')
  ctx.inject(['webServer'], (webCtx) => registerAuditApi(webCtx, service))
}

export { AUDIT_CAPABILITY, AUDIT_PRESET_ID } from './lib/capability.js'
export { AuditService } from './lib/service.js'
export { extractJson, coerceVerdict, BOUNDARY_RULES, AuditEngine } from './lib/engine.js'
export { sidecarRoot, sidecarPath, SidecarStore } from './lib/sidecar.js'
export { CodexClient, CodexError, REVIEWER_MODEL_DEFAULTS } from './lib/codex.js'
export { ClaudeCodeClient, DshReviewerClient, ReviewerError, REVIEWER_TYPES, REVIEWER_DEFAULTS, resolveReviewerOptions, createReviewerCompanion } from './lib/reviewer.js'
export { AUDIT_SERVICE, AUDIT_API_BASE, AUDIT_DOCK_ORDER, AUDIT_SLOT, AUDIT_DOCK_ID } from './lib/invariant.js'
