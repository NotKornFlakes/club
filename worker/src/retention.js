// @ts-check
// Nightly clean-up: deletes data once it is past its retention period.
// The periods come from CLAUDE.md ("Data & privacy") and docs/architecture.md, section 8.

const DAY = 86_400;

/** Days to keep each kind of data. 12 months = 365 days, 24 months = 730 days. */
export const RETENTION_DAYS = Object.freeze({
  bookings: 365, // after the booking ends
  noShows: 365, // after the no-show date
  suspensions: 365, // after the suspension ends or was lifted
  leagues: 365, // after the league's last date
  clubEvents: 365, // after the event ends
  auditLog: 730, // after the entry was written
  loginFailures: 7,
});

/**
 * Deletes everything past its retention period, in one transaction, and writes
 * one audit log entry with the counts.
 *
 * @param {D1Database} db
 * @param {number} now Unix seconds
 * @returns {Promise<Record<string, number>>} rows deleted per table
 */
export async function runRetention(db, now) {
  /** @param {number} days */
  const before = (days) => now - days * DAY;
  /** @param {number} days the UTC date `days` ago, as YYYY-MM-DD */
  const beforeDate = (days) => new Date(before(days) * 1000).toISOString().slice(0, 10);

  /** @type {Array<[string, D1PreparedStatement]>} */
  const steps = [
    ["bookings", db.prepare("DELETE FROM bookings WHERE ends_at < ? RETURNING 1").bind(before(RETENTION_DAYS.bookings))],
    ["no_shows", db.prepare("DELETE FROM no_shows WHERE on_date < ? RETURNING 1").bind(beforeDate(RETENTION_DAYS.noShows))],
    [
      "suspensions",
      db
        .prepare("DELETE FROM suspensions WHERE COALESCE(lifted_at, ends_at) < ? RETURNING 1")
        .bind(before(RETENTION_DAYS.suspensions)),
    ],
    ["leagues", db.prepare("DELETE FROM leagues WHERE last_date < ? RETURNING 1").bind(beforeDate(RETENTION_DAYS.leagues))],
    ["club_events", db.prepare("DELETE FROM club_events WHERE ends_at < ? RETURNING 1").bind(before(RETENTION_DAYS.clubEvents))],
    ["audit_log", db.prepare("DELETE FROM audit_log WHERE at < ? RETURNING 1").bind(before(RETENTION_DAYS.auditLog))],
    [
      "login_failures",
      db.prepare("DELETE FROM login_failures WHERE at < ? RETURNING 1").bind(before(RETENTION_DAYS.loginFailures)),
    ],
    ["member_sessions", db.prepare("DELETE FROM member_sessions WHERE expires_at <= ? RETURNING 1").bind(now)],
    ["admin_sessions", db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ? RETURNING 1").bind(now)],
  ];

  const results = await db.batch(steps.map(([, statement]) => statement));

  /** @type {Record<string, number>} */
  const deleted = {};
  steps.forEach(([table], i) => {
    // Count the RETURNING rows: meta.changes would also count slot rows removed by the cascade.
    deleted[table] = results[i]?.results.length ?? 0;
  });

  await db
    .prepare("INSERT INTO audit_log (at, admin_id, action, target, details) VALUES (?, NULL, 'retention.run', NULL, ?)")
    .bind(now, JSON.stringify({ deleted }))
    .run();

  return deleted;
}
