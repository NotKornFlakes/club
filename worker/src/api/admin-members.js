// @ts-check
// Admin: members. Add one, import many (CSV, in chunks), edit the display name, disable or
// enable, reset a PIN, clear a lockout, and record no-shows and suspensions.
// New PINs are returned once, never stored in plain text, and never logged.

import { auditEntry } from "../audit.js";
import { hashRounds, hashSecret, newPin, pepperKeys } from "../crypto.js";
import {
  activeSuspension,
  defaultSuspensionUntil,
  deleteNoShow,
  liftSuspension,
  recordNoShow,
  suspendMember,
  suspensionUntilDate,
} from "../discipline.js";
import { HttpError, json } from "../http.js";
import { endAllMemberSessions } from "../sessions.js";
import { clearLock } from "../throttle.js";
import { addDays, clubToday } from "../time.js";
import { date, idParam, onlyFields, optionalStr, str } from "../validate.js";
import { MEMBER_NUMBER_PATTERN } from "./member-auth.js";

/** @typedef {import("../router.js").Ctx} Ctx */
/** @typedef {import("../router.js").Route} Route */

/** Members per import request: keeps each request well inside the CPU limit. */
export const IMPORT_CHUNK = 25;

/** @param {Ctx} ctx */
const adminId = (ctx) => /** @type {import("../sessions.js").AdminSession} */ (ctx.admin).adminId;

/** @param {Ctx} ctx @param {number} id */
async function memberRow(ctx, id) {
  const row = await ctx.env.DB.prepare("SELECT id, member_number, display_name, status FROM members WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "not_found", "We couldn't find that member.");
  return { id: Number(row.id), number: String(row.member_number), name: row.display_name === null ? null : String(row.display_name), status: String(row.status) };
}

/** @param {Record<string, unknown>} body */
function memberNumber(body) {
  return str(body, "member_number", { max: 20, pattern: MEMBER_NUMBER_PATTERN, label: "the member number (letters, numbers and dashes, up to 20)" });
}

/** @param {Ctx} ctx */
async function listMembers(ctx) {
  const q = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { results } = await ctx.env.DB.prepare(
    `SELECT m.id, m.member_number, m.display_name, m.status, m.pin_hash IS NOT NULL AS has_pin,
            CASE WHEN m.locked_until > ?1 THEN m.locked_until END AS locked_until,
            (SELECT MAX(s.ends_at) FROM suspensions s WHERE s.member_id = m.id AND s.lifted_at IS NULL
               AND s.starts_at <= ?1 AND s.ends_at > ?1) AS suspended_until,
            (SELECT COUNT(*) FROM no_shows n WHERE n.member_id = m.id AND n.on_date > ?2) AS no_shows
     FROM members m
     WHERE ?3 = '' OR m.member_number LIKE ?4 ESCAPE '\\' OR m.display_name LIKE ?4 ESCAPE '\\'
     ORDER BY m.member_number LIMIT 200`,
  )
    .bind(ctx.now, addDays(clubToday(ctx.now), -365), q, like)
    .all();
  return json({
    members: results.map((m) => ({
      id: Number(m.id),
      member_number: String(m.member_number),
      display_name: m.display_name === null ? null : String(m.display_name),
      status: String(m.status),
      has_pin: Boolean(m.has_pin),
      locked_until: m.locked_until === null ? null : Number(m.locked_until),
      suspended_until: m.suspended_until === null ? null : suspensionUntilDate(Number(m.suspended_until)),
      no_shows: Number(m.no_shows),
    })),
  });
}

/** @param {Ctx} ctx */
async function memberDetail(ctx) {
  const { env, now } = ctx;
  const member = await memberRow(ctx, idParam(ctx.params[0]));
  const lock = await env.DB.prepare("SELECT locked_until, lock_level, pin_issued_at FROM members WHERE id = ?").bind(member.id).first();
  const noShows = await env.DB.prepare(
    "SELECT id, on_date, note FROM no_shows WHERE member_id = ? AND on_date > ? ORDER BY on_date DESC",
  )
    .bind(member.id, addDays(clubToday(now), -365))
    .all();
  const suspensions = await env.DB.prepare(
    "SELECT id, starts_at, ends_at, reason, lifted_at FROM suspensions WHERE member_id = ? ORDER BY starts_at DESC LIMIT 20",
  )
    .bind(member.id)
    .all();
  const bookings = await env.DB.prepare(
    `SELECT b.id, b.starts_at, b.ends_at, r.name AS resource FROM bookings b JOIN resources r ON r.id = b.resource_id
     WHERE b.member_id = ? AND b.status = 'active' AND b.ends_at > ? ORDER BY b.starts_at`,
  )
    .bind(member.id, now)
    .all();
  const active = await activeSuspension(env.DB, member.id, now);
  return json({
    member: {
      id: member.id,
      member_number: member.number,
      display_name: member.name,
      status: member.status,
      locked_until: Number(lock?.locked_until ?? 0) > now ? Number(lock?.locked_until) : null,
      pin_issued_at: lock?.pin_issued_at === null ? null : Number(lock?.pin_issued_at),
    },
    active_suspension: active,
    default_suspension_until: defaultSuspensionUntil(now),
    no_shows: noShows.results.map((n) => ({ id: Number(n.id), on_date: String(n.on_date), note: n.note === null ? null : String(n.note) })),
    suspensions: suspensions.results.map((s) => ({
      id: Number(s.id),
      from_date: clubToday(Number(s.starts_at)),
      until_date: suspensionUntilDate(Number(s.ends_at)),
      reason: String(s.reason),
      lifted_at: s.lifted_at === null ? null : Number(s.lifted_at),
    })),
    upcoming_bookings: bookings.results.map((b) => ({
      id: Number(b.id),
      resource: String(b.resource),
      starts_at: Number(b.starts_at),
      ends_at: Number(b.ends_at),
    })),
  });
}

/**
 * Creates members with new PINs, in one batch. Existing or repeated numbers are skipped.
 * @param {Ctx} ctx @param {Array<{ number: string, name: string | null }>} wanted
 */
async function createMembers(ctx, wanted) {
  const { env, now } = ctx;
  const keys = await pepperKeys(env.PEPPER);
  const numbers = wanted.map((w) => w.number);
  const { results } = await env.DB.prepare("SELECT member_number FROM members WHERE member_number IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(numbers))
    .all();
  const taken = new Set(results.map((r) => String(r.member_number)));
  /** @type {Array<{ member_number: string, display_name: string | null, pin: string }>} */
  const created = [];
  /** @type {Array<{ member_number: string, reason: string }>} */
  const skipped = [];
  /** @type {D1PreparedStatement[]} */
  const statements = [];
  for (const { number, name } of wanted) {
    if (taken.has(number)) {
      skipped.push({ member_number: number, reason: "Already exists" });
      continue;
    }
    taken.add(number);
    const pin = newPin();
    statements.push(
      env.DB.prepare(
        "INSERT INTO members (member_number, display_name, pin_hash, pin_issued_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(number, name, await hashSecret(pin, keys, hashRounds(env)), now, now, now),
    );
    created.push({ member_number: number, display_name: name, pin });
  }
  if (statements.length > 0) {
    statements.push(
      auditEntry(env.DB, {
        at: now,
        adminId: adminId(ctx),
        action: created.length === 1 ? "member.create" : "member.import",
        target: created.length === 1 ? `member:${created[0]?.member_number}` : null,
        details: { members: created.map((c) => c.member_number) },
      }),
    );
    await env.DB.batch(statements);
  }
  return { created, skipped };
}

/** @param {Ctx} ctx */
async function addMember(ctx) {
  onlyFields(ctx.body, ["member_number", "display_name"]);
  const number = memberNumber(ctx.body);
  const name = optionalStr(ctx.body, "display_name", { max: 100, label: "the name" });
  const { created } = await createMembers(ctx, [{ number, name }]);
  if (created.length === 0) throw new HttpError(409, "exists", "A member with that number already exists.");
  return json({ created }, 201);
}

/** @param {Ctx} ctx */
async function importMembers(ctx) {
  onlyFields(ctx.body, ["members"]);
  const rows = ctx.body.members;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > IMPORT_CHUNK) {
    throw new HttpError(400, "bad_input", `Send between 1 and ${IMPORT_CHUNK} members at a time.`);
  }
  /** @type {Array<{ number: string, name: string | null }>} */
  const wanted = [];
  /** @type {Array<{ member_number: string, reason: string }>} */
  const invalid = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new HttpError(400, "bad_input", "Please check the file.");
    const record = /** @type {Record<string, unknown>} */ (row);
    onlyFields(record, ["member_number", "display_name"]);
    const raw = typeof record.member_number === "string" ? record.member_number.trim() : "";
    if (!MEMBER_NUMBER_PATTERN.test(raw)) {
      invalid.push({ member_number: raw.slice(0, 20), reason: "Not a valid member number" });
      continue;
    }
    const name = optionalStr(record, "display_name", { max: 100, label: "a name" });
    wanted.push({ number: raw, name });
  }
  const { created, skipped } = await createMembers(ctx, wanted);
  return json({ created, skipped: [...invalid, ...skipped] });
}

/** @param {Ctx} ctx */
async function updateMember(ctx) {
  onlyFields(ctx.body, ["display_name"]);
  const member = await memberRow(ctx, idParam(ctx.params[0]));
  const name = optionalStr(ctx.body, "display_name", { max: 100, label: "the name" });
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE members SET display_name = ?, updated_at = ? WHERE id = ?").bind(name, ctx.now, member.id),
    auditEntry(ctx.env.DB, { at: ctx.now, adminId: adminId(ctx), action: "member.rename", target: `member:${member.number}` }),
  ]);
  return json({ ok: true });
}

/** @param {"active" | "disabled"} status */
function setStatus(status) {
  /** @param {Ctx} ctx */
  return async (ctx) => {
    onlyFields(ctx.body, []);
    const member = await memberRow(ctx, idParam(ctx.params[0]));
    /** @type {D1PreparedStatement[]} */
    const statements = [
      ctx.env.DB.prepare("UPDATE members SET status = ?, updated_at = ? WHERE id = ?").bind(status, ctx.now, member.id),
      auditEntry(ctx.env.DB, {
        at: ctx.now,
        adminId: adminId(ctx),
        action: status === "disabled" ? "member.disable" : "member.enable",
        target: `member:${member.number}`,
      }),
    ];
    // Disabling logs the member out everywhere.
    if (status === "disabled") statements.push(endAllMemberSessions(ctx.env.DB, member.id));
    await ctx.env.DB.batch(statements);
    return json({ ok: true });
  };
}

/** A new PIN, shown once. Logs the member out everywhere and clears any lockout. @param {Ctx} ctx */
async function resetPin(ctx) {
  onlyFields(ctx.body, []);
  const member = await memberRow(ctx, idParam(ctx.params[0]));
  const pin = newPin();
  const hash = await hashSecret(pin, await pepperKeys(ctx.env.PEPPER), hashRounds(ctx.env));
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE members SET pin_hash = ?, pin_issued_at = ?, failed_logins = 0, lock_level = 0, locked_until = NULL,
              last_failed_at = NULL, updated_at = ? WHERE id = ?`,
    ).bind(hash, ctx.now, ctx.now, member.id),
    endAllMemberSessions(ctx.env.DB, member.id),
    auditEntry(ctx.env.DB, { at: ctx.now, adminId: adminId(ctx), action: "member.reset_pin", target: `member:${member.number}` }),
  ]);
  return json({ created: [{ member_number: member.number, display_name: member.name, pin }] });
}

/** @param {Ctx} ctx */
async function clearMemberLockout(ctx) {
  onlyFields(ctx.body, []);
  const member = await memberRow(ctx, idParam(ctx.params[0]));
  await clearLock(ctx.env.DB, "member", member.id, ctx.now);
  await auditEntry(ctx.env.DB, { at: ctx.now, adminId: adminId(ctx), action: "member.clear_lockout", target: `member:${member.number}` }).run();
  return json({ ok: true });
}

/** @param {Ctx} ctx */
async function addNoShow(ctx) {
  onlyFields(ctx.body, ["on_date", "note"]);
  const member = await memberRow(ctx, idParam(ctx.params[0]));
  const onDate = date(ctx.body, "on_date", "the date of the missed booking");
  const note = optionalStr(ctx.body, "note", { max: 500, label: "the note" });
  const id = await recordNoShow(ctx.env.DB, { memberId: member.id, onDate, note, adminId: adminId(ctx), now: ctx.now });
  return json({ id }, 201);
}

/** @param {Ctx} ctx */
async function removeNoShow(ctx) {
  onlyFields(ctx.body, []);
  await deleteNoShow(ctx.env.DB, { id: idParam(ctx.params[0]), adminId: adminId(ctx), now: ctx.now });
  return json({ ok: true });
}

/** @param {Ctx} ctx */
async function suspend(ctx) {
  onlyFields(ctx.body, ["until_date", "reason"]);
  const member = await memberRow(ctx, idParam(ctx.params[0]));
  const untilDate = date(ctx.body, "until_date", "the end date");
  const reason = str(ctx.body, "reason", { max: 500, label: "the reason" });
  const result = await suspendMember(ctx.env.DB, { memberId: member.id, untilDate, reason, adminId: adminId(ctx), now: ctx.now });
  return json({ until_date: result.untilDate, cancelled: result.cancelled }, 201);
}

/** @param {Ctx} ctx */
async function lift(ctx) {
  onlyFields(ctx.body, []);
  await liftSuspension(ctx.env.DB, { suspensionId: idParam(ctx.params[0]), adminId: adminId(ctx), now: ctx.now });
  return json({ ok: true });
}

/** @type {Route[]} */
export const adminMemberRoutes = [
  { method: "GET", path: "/api/admin/members", access: "admin", handler: listMembers },
  { method: "POST", path: "/api/admin/members", access: "admin", handler: addMember },
  { method: "POST", path: "/api/admin/members/import", access: "admin", handler: importMembers },
  { method: "GET", path: "/api/admin/members/:id", access: "admin", handler: memberDetail },
  { method: "POST", path: "/api/admin/members/:id/update", access: "admin", handler: updateMember },
  { method: "POST", path: "/api/admin/members/:id/disable", access: "admin", handler: setStatus("disabled") },
  { method: "POST", path: "/api/admin/members/:id/enable", access: "admin", handler: setStatus("active") },
  { method: "POST", path: "/api/admin/members/:id/reset-pin", access: "admin", handler: resetPin },
  { method: "POST", path: "/api/admin/members/:id/clear-lockout", access: "admin", handler: clearMemberLockout },
  { method: "POST", path: "/api/admin/members/:id/no-shows", access: "admin", handler: addNoShow },
  { method: "POST", path: "/api/admin/members/:id/suspend", access: "admin", handler: suspend },
  { method: "POST", path: "/api/admin/no-shows/:id/delete", access: "admin", handler: removeNoShow },
  { method: "POST", path: "/api/admin/suspensions/:id/lift", access: "admin", handler: lift },
];
