-- 0001_init.sql: first D1 schema. Source of truth for the design: docs/architecture.md, section 7.
-- Times: *_at = Unix seconds UTC; *_local = club time HH:MM; *_date = club date YYYY-MM-DD.

-- ---------- People ----------

CREATE TABLE members (
  id              INTEGER PRIMARY KEY,
  member_number   TEXT    NOT NULL UNIQUE CHECK (length(member_number) BETWEEN 1 AND 20),
  display_name    TEXT    CHECK (display_name IS NULL OR length(display_name) <= 100), -- admin-only
  pin_hash        TEXT,                    -- NULL until a PIN is issued
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  lock_level      INTEGER NOT NULL DEFAULT 0 CHECK (lock_level BETWEEN 0 AND 3),
  locked_until    INTEGER,
  last_failed_at  INTEGER,
  pin_issued_at   INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE TABLE admins (
  id               INTEGER PRIMARY KEY,
  username         TEXT    NOT NULL UNIQUE CHECK (length(username) BETWEEN 3 AND 40),
  password_hash    TEXT    NOT NULL,
  totp_secret_enc  TEXT    NOT NULL,       -- AES-GCM, key derived from PEPPER
  totp_last_step   INTEGER NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_logins    INTEGER NOT NULL DEFAULT 0,
  lock_level       INTEGER NOT NULL DEFAULT 0 CHECK (lock_level BETWEEN 0 AND 3),
  locked_until     INTEGER,
  last_failed_at   INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;

-- ---------- Sessions and login protection ----------

CREATE TABLE member_sessions (
  token_hash  TEXT    PRIMARY KEY,         -- SHA-256 of the cookie value, never the value
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  csrf_token  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX member_sessions_member ON member_sessions(member_id);
CREATE INDEX member_sessions_expires ON member_sessions(expires_at);

CREATE TABLE admin_sessions (
  token_hash  TEXT    PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX admin_sessions_admin ON admin_sessions(admin_id);

CREATE TABLE login_failures (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('member', 'admin')),
  ip_hash    TEXT    NOT NULL,             -- HMAC-SHA256(IP_HASH_KEY, IP or IPv6 /64); never the raw IP
  member_id  INTEGER REFERENCES members(id) ON DELETE SET NULL  -- NULL if no such member
) STRICT;
CREATE INDEX login_failures_at ON login_failures(at);
CREATE INDEX login_failures_ip ON login_failures(ip_hash, at);

CREATE TABLE system_state (                -- e.g. key 'login_alarm_until'
  key         TEXT    PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

-- ---------- Resources and hours ----------

CREATE TABLE resources (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),   -- retire, never delete
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE opening_hours (               -- no row for a weekday = closed that day
  resource_id  INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),     -- 0 = Sunday
  opens_local  TEXT    NOT NULL CHECK (opens_local  GLOB '[0-2][0-9]:[0-5][05]'
                                       AND substr(opens_local, 4, 2)  IN ('00','15','30','45')),
  closes_local TEXT    NOT NULL CHECK (closes_local GLOB '[0-2][0-9]:[0-5][05]'
                                       AND substr(closes_local, 4, 2) IN ('00','15','30','45')
                                       AND closes_local <= '24:00'),
  CHECK (opens_local < closes_local),
  PRIMARY KEY (resource_id, weekday, opens_local)  -- allows split hours, e.g. 9-12 and 14-20
) STRICT;

-- ---------- Leagues ----------

CREATE TABLE leagues (
  id                   INTEGER PRIMARY KEY,
  name                 TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  resource_id          INTEGER NOT NULL REFERENCES resources(id),
  weekday              INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_local         TEXT    NOT NULL CHECK (starts_local GLOB '[0-2][0-9]:[0-5][05]'
                                             AND substr(starts_local, 4, 2) IN ('00','15','30','45')),
  ends_local           TEXT    NOT NULL CHECK (ends_local GLOB '[0-2][0-9]:[0-5][05]'
                                             AND substr(ends_local, 4, 2) IN ('00','15','30','45')
                                             AND ends_local <= '24:00'),
  first_date           TEXT    NOT NULL,
  last_date            TEXT    NOT NULL,   -- at most 12 months after creation (checked by Worker)
  renewed_from         INTEGER REFERENCES leagues(id) ON DELETE SET NULL,
  created_by_admin_id  INTEGER NOT NULL REFERENCES admins(id),
  created_at           INTEGER NOT NULL,
  cancelled_at         INTEGER,
  CHECK (starts_local < ends_local),
  CHECK (first_date <= last_date)
) STRICT;

-- ---------- Bookings ----------

CREATE TABLE bookings (
  id                     INTEGER PRIMARY KEY,
  resource_id            INTEGER NOT NULL REFERENCES resources(id),
  kind                   TEXT    NOT NULL CHECK (kind IN ('member', 'admin', 'league')),
  member_id              INTEGER REFERENCES members(id),
  league_id              INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
  label                  TEXT    CHECK (label IS NULL OR length(label) <= 80),  -- admin-only
  starts_at              INTEGER NOT NULL,
  ends_at                INTEGER NOT NULL,
  status                 TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at             INTEGER NOT NULL,
  created_by_admin_id    INTEGER REFERENCES admins(id),     -- NULL when a member booked
  cancelled_at           INTEGER,
  cancelled_by           TEXT    CHECK (cancelled_by IN ('member', 'admin', 'suspension')),
  cancelled_by_admin_id  INTEGER REFERENCES admins(id),
  CHECK (starts_at % 900 = 0 AND ends_at % 900 = 0 AND ends_at > starts_at),
  CHECK (ends_at - starts_at <= 30 * 86400),
  CHECK (kind <> 'member' OR ends_at - starts_at <= 7200),
  CHECK (kind <> 'member' OR starts_at > created_at),
  CHECK ((kind = 'member') = (member_id IS NOT NULL)),
  CHECK ((kind = 'league') = (league_id IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
) STRICT;
CREATE INDEX bookings_member_upcoming ON bookings(member_id, status, ends_at);
CREATE INDEX bookings_resource_time   ON bookings(resource_id, starts_at);
CREATE INDEX bookings_league          ON bookings(league_id);
CREATE INDEX bookings_ends            ON bookings(ends_at);

-- The double-booking guard: one row per taken 15-minute slot.
CREATE TABLE booking_slots (
  resource_id  INTEGER NOT NULL,
  slot_start   INTEGER NOT NULL CHECK (slot_start % 900 = 0),
  booking_id   INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  PRIMARY KEY (resource_id, slot_start)
) STRICT;
CREATE INDEX booking_slots_booking ON booking_slots(booking_id);

-- 0..2879 = enough 15-minute offsets for a 30-day booking. Triggers can't use WITH RECURSIVE,
-- so they join against this table instead.
CREATE TABLE slot_offsets (n INTEGER PRIMARY KEY) STRICT;
INSERT INTO slot_offsets (n)
  WITH RECURSIVE c(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM c WHERE n < 2879)
  SELECT n FROM c;

CREATE TABLE league_skips (
  league_id            INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  on_date              TEXT    NOT NULL,
  clashing_booking_id  INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  PRIMARY KEY (league_id, on_date)
) STRICT;

-- ---------- No-shows and suspensions ----------

CREATE TABLE no_shows (
  id                    INTEGER PRIMARY KEY,
  member_id             INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  on_date               TEXT    NOT NULL CHECK (on_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  note                  TEXT    CHECK (note IS NULL OR length(note) <= 500),   -- admin-only
  recorded_by_admin_id  INTEGER NOT NULL REFERENCES admins(id),
  recorded_at           INTEGER NOT NULL
) STRICT;
CREATE INDEX no_shows_member ON no_shows(member_id, on_date);

CREATE TABLE suspensions (
  id                   INTEGER PRIMARY KEY,
  member_id            INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  starts_at            INTEGER NOT NULL,
  ends_at              INTEGER NOT NULL,
  reason               TEXT    NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by_admin_id  INTEGER NOT NULL REFERENCES admins(id),
  created_at           INTEGER NOT NULL,
  lifted_at            INTEGER,
  lifted_by_admin_id   INTEGER REFERENCES admins(id),
  CHECK (ends_at > starts_at),
  CHECK ((lifted_at IS NULL) = (lifted_by_admin_id IS NULL))
) STRICT;
CREATE INDEX suspensions_member ON suspensions(member_id, ends_at);

-- ---------- Club events (other locations, view only) ----------

CREATE TABLE club_events (
  id                   INTEGER PRIMARY KEY,
  title                TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  location             TEXT    NOT NULL CHECK (length(location) BETWEEN 1 AND 120),
  details              TEXT    CHECK (details IS NULL OR length(details) <= 2000),
  starts_at            INTEGER NOT NULL,
  ends_at              INTEGER NOT NULL,
  created_by_admin_id  INTEGER NOT NULL REFERENCES admins(id),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
) STRICT;
CREATE INDEX club_events_starts ON club_events(starts_at);

-- ---------- Audit log ----------

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  admin_id  INTEGER REFERENCES admins(id),     -- NULL = system (e.g. nightly clean-up)
  action    TEXT    NOT NULL,                  -- e.g. 'member.suspend', 'booking.cancel'
  target    TEXT,                              -- e.g. 'member:1234', 'booking:567'
  details   TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(details))
) STRICT;
CREATE INDEX audit_log_at ON audit_log(at);

-- ================= Triggers =================

-- Fill in a booking's slots. If any slot is taken, the whole insert fails.
CREATE TRIGGER bookings_fill_slots AFTER INSERT ON bookings
WHEN NEW.status = 'active'
BEGIN
  INSERT INTO booking_slots (resource_id, slot_start, booking_id)
    SELECT NEW.resource_id, NEW.starts_at + n * 900, NEW.id
    FROM slot_offsets
    WHERE NEW.starts_at + n * 900 < NEW.ends_at;
END;

-- Belt and braces: refuse a taken slot even if someone writes INSERT OR IGNORE / OR REPLACE.
CREATE TRIGGER booking_slots_no_overwrite BEFORE INSERT ON booking_slots
BEGIN
  SELECT RAISE(ABORT, 'slot_taken')
  WHERE EXISTS (SELECT 1 FROM booking_slots
                WHERE resource_id = NEW.resource_id AND slot_start = NEW.slot_start);
END;

-- Cancelling frees the slots.
CREATE TRIGGER bookings_free_slots AFTER UPDATE OF status ON bookings
WHEN OLD.status = 'active' AND NEW.status = 'cancelled'
BEGIN
  DELETE FROM booking_slots WHERE booking_id = NEW.id;
END;

-- Bookings can't be moved, resized or un-cancelled (the slots would go out of step).
CREATE TRIGGER bookings_immutable BEFORE UPDATE OF resource_id, starts_at, ends_at, kind,
                                                   member_id, league_id ON bookings
BEGIN
  SELECT RAISE(ABORT, 'booking_immutable');
END;
CREATE TRIGGER bookings_no_uncancel BEFORE UPDATE OF status ON bookings
WHEN OLD.status = 'cancelled'
BEGIN
  SELECT RAISE(ABORT, 'booking_immutable');
END;

-- Member rules that must hold even if two requests race.
-- "Now" is the booking's created_at, which the Worker sets (and tests can control).
CREATE TRIGGER bookings_member_rules BEFORE INSERT ON bookings
WHEN NEW.kind = 'member'
BEGIN
  SELECT RAISE(ABORT, 'member_not_active')
  WHERE (SELECT status FROM members WHERE id = NEW.member_id) <> 'active';

  SELECT RAISE(ABORT, 'member_suspended')
  WHERE EXISTS (SELECT 1 FROM suspensions
                WHERE member_id = NEW.member_id AND lifted_at IS NULL
                  AND starts_at <= NEW.created_at AND ends_at > NEW.created_at);

  SELECT RAISE(ABORT, 'too_many_upcoming')
  WHERE (SELECT COUNT(*) FROM bookings
         WHERE member_id = NEW.member_id AND status = 'active'
           AND ends_at > NEW.created_at) >= 2;
END;

-- The audit log can be added to and pruned, never edited.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log_append_only');
END;
