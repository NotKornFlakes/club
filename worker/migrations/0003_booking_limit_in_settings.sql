-- 0003: the member booking limit moves to the club's settings file.
-- 0001 refused a member's third upcoming booking right in the database. Each club now
-- chooses its own limit (none, a number of upcoming bookings, or hours in any 7 days), and
-- the Worker applies it in the same statement that saves the booking (src/bookings.js), so
-- two quick requests still can't both get past it. This trigger keeps the rules that are
-- the same for every club: an active member, and no suspension in force.

DROP TRIGGER bookings_member_rules;

CREATE TRIGGER bookings_member_rules BEFORE INSERT ON bookings
WHEN NEW.kind = 'member'
BEGIN
  SELECT RAISE(ABORT, 'member_not_active')
  WHERE (SELECT status FROM members WHERE id = NEW.member_id) <> 'active';

  SELECT RAISE(ABORT, 'member_suspended')
  WHERE EXISTS (SELECT 1 FROM suspensions
                WHERE member_id = NEW.member_id AND lifted_at IS NULL
                  AND starts_at <= NEW.created_at AND ends_at > NEW.created_at);
END;
