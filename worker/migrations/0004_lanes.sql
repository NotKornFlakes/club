-- 0004: bowling lanes. A member can book 1-2 lanes in one booking; admins can book every
-- lane in an area at once, one-off or as a league season. Additive only.

-- Lanes booked together are one booking: the first lane's row leads (group_id NULL) and
-- the others point at it. Members see, cancel and get one calendar entry for the group,
-- and the club's booking limit counts it once.
ALTER TABLE bookings ADD COLUMN group_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE;
CREATE INDEX bookings_group ON bookings(group_id);

-- A league season that books every active court, room or lane in its resource's area each
-- week (for example all 8 lanes for a Friday league).
ALTER TABLE leagues ADD COLUMN whole_area INTEGER NOT NULL DEFAULT 0 CHECK (whole_area IN (0, 1));
