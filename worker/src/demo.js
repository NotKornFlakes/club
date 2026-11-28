// @ts-check
// Demo sites (the DEMO_MODE setting is exactly "on"): for showing the site with made-up
// members and bookings only, on the Workers Free plan. A demo has lighter PIN and password
// hashing (crypto.js, hashRounds), a banner at the top of every page, and asks search
// engines not to list it. The club's real site never sets it. README, "Demo site".

/** Shown at the top of every page of a demo site. */
export const DEMO_BANNER = "Demo site with made-up members and bookings. It isn't the club's own website.";

/** @param {{ DEMO_MODE?: unknown }} env */
export function isDemo(env) {
  return env.DEMO_MODE === "on";
}
