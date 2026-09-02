/** Shared failure type for every Audit reviewer backend. */
export class ReviewerError extends Error {
  constructor (message, code = 'REVIEWER_ERROR', details) {
    super(message)
    this.name = 'ReviewerError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}
