// @ts-check
// The audit log: every admin action, kept 24 months, append-only (a trigger refuses edits).

/**
 * An INSERT for one audit entry, to run alone or inside a batch with the change it records.
 * @param {D1Database} db
 * @param {{ at: number, adminId: number | null, action: string, target?: string | null, details?: Record<string, unknown> }} entry
 * @returns {D1PreparedStatement}
 */
export function auditEntry(db, { at, adminId, action, target = null, details = {} }) {
  return db
    .prepare("INSERT INTO audit_log (at, admin_id, action, target, details) VALUES (?, ?, ?, ?, ?)")
    .bind(at, adminId, action, target, JSON.stringify(details));
}
