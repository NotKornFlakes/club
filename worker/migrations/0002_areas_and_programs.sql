-- 0002: areas for courts, rooms and lanes, and programs on the week view.
-- Additive only: existing rows keep working with the defaults.

-- Which part of the club a court, room or lane belongs to. The week view's switcher
-- (for Pastime: Gym, Bowling lanes, Rooms) uses it. The ids come from the club's settings
-- file; '' means "not placed yet" and shows in no area until an admin sets it.
ALTER TABLE resources ADD COLUMN area TEXT NOT NULL DEFAULT '' CHECK (length(area) <= 20);

-- A league with public = 1 is a program: This Week and Book show it with its name
-- (Pickleball, Open gym, ...). Any other league shows only as "Taken", like a member's
-- booking. Either way its times are blocked for member booking.
ALTER TABLE leagues ADD COLUMN public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1));
