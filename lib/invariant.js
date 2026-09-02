/**
 * The stable identity contract of dsh-audit-mode. Both package halves and
 * every surface read these instead of re-declaring ids.
 */
export const name = 'dsh-audit-mode'
export const AUDIT_SERVICE = 'audits'
export const AUDIT_EVENT = 'audit/state'
export const AUDIT_API_BASE = '/api/audit'
export const AUDIT_DOCK_ORDER = 5
export const AUDIT_DOCK_ID = 'audit'
export const AUDIT_SLOT = 'conversation.input.dock'
export { AUDIT_CAPABILITY, AUDIT_PRESET_ID, VERDICTS, PAUSE_REASONS } from './capability.js'
