/**
 * The fixed guardian capability identifier.
 *
 * A preset carries a capability label so surfaces and routers can recognize
 * the guardian mode without parsing its composition. It is a stable contract:
 * the Web dock, the TUI block, the /guardian command, and the Remote API all
 * key off this constant, and it is deliberately NOT derived from anything
 * user-editable (hence "fixed").
 */
export const GUARDIAN_CAPABILITY = 'guardian'

/** The preset id the roster exposes for this mode. */
export const GUARDIAN_PRESET_ID = 'guardian'

/** Verdict vocabulary of the independent auditor. */
export const VERDICTS = Object.freeze(['pass', 'warning', 'critical'])

/** Audit pause states and their stable reasons (wire-visible). */
export const PAUSE_REASONS = Object.freeze(['safety', 'failures', 'manual'])
