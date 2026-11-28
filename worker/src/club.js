// @ts-check
// This deployment's club. Every club-specific value (name, rooms, hours, limits, rules,
// colors) comes from this one file. To run the site for another club, give it its own
// clubs/<club>/club.json and point this import at it (README, "The club's settings").
// If the file has a mistake, the Worker refuses to start, and the tests fail in CI.

import raw from "../../clubs/pastime/club.json" with { type: "json" };
import { parseClub } from "./club-config.js";

export const CLUB = parseClub(raw);
