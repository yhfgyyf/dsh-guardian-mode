/**
 * The stable identity contract of dsh-guardian-mode. Both package halves and
 * every surface read these instead of re-declaring ids.
 */
export const name = 'dsh-guardian-mode'
export const GUARDIAN_SERVICE = 'guardians'
export const GUARDIAN_EVENT = 'guardian/state'
export const GUARDIAN_API_BASE = '/api/guardian'
export const GUARDIAN_DOCK_ORDER = 5
export const GUARDIAN_DOCK_ID = 'guardian'
export const GUARDIAN_SLOT = 'conversation.input.dock'
export { GUARDIAN_CAPABILITY, GUARDIAN_PRESET_ID, VERDICTS, PAUSE_REASONS } from './capability.js'
