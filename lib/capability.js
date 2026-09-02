/**
 * The fixed audit capability identifier.
 *
 * A preset carries a capability label so surfaces and routers can recognize
 * the audit mode without parsing its composition. It is a stable contract:
 * the Web dock, the TUI block, the /audit command, and the Remote API all
 * key off this constant, and it is deliberately NOT derived from anything
 * user-editable (hence "fixed").
 */
export const AUDIT_CAPABILITY = 'audit'

/** The preset id the roster exposes for this mode. */
export const AUDIT_PRESET_ID = 'audit'

// Keep existing persisted sessions resumable without exposing the retired id
// through the roster or any user-facing surface.
const RETIRED_PRESET_ID = ['guard', 'ian'].join('')

export function isAuditPresetId (value) {
  return value === AUDIT_PRESET_ID || value === RETIRED_PRESET_ID
}

export function normalizeAuditPresetId (value) {
  return value === RETIRED_PRESET_ID ? AUDIT_PRESET_ID : value
}

/** Verdict vocabulary of the independent auditor. */
export const VERDICTS = Object.freeze(['pass', 'warning', 'critical'])

/** Audit pause states and their stable reasons (wire-visible). */
export const PAUSE_REASONS = Object.freeze(['safety', 'failures', 'manual', 'remediation'])
