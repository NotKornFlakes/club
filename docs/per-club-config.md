# Plan: one config file per club

Status: **plan only. Nothing is built.** This PR comes after the stacked build PRs
(#6–#12) merge, and before the custom-domain PR.

## Goal

Everything that differs from one club to the next lives in a single file per club.
Pastime Athletic Club is the first. Adding another club later means writing a new config
file and setting up its own Cloudflare account, secrets and deploy. No code changes.

## Why this order

- **After the stacked PRs:** this change touches almost every page and several Worker
  modules from #6–#12. Doing it sooner would conflict with every PR in the stack.
- **Before the custom domain:** the hostname then comes from the config, so the
  custom-domain PR reads it from there from the start.

## Where it lives

```
clubs/
  pastime/
    club.json   # every club-specific value
    logo.svg    # or logo.png
```

The file is JSON so that the Worker, Terraform (`jsondecode(file(...))`) and the tests all
read the same file. The deploy picks the club with one setting; while Pastime is the only
club, it's the default.

## What moves into the config

| Value | Where it is today |
|---|---|
| Club name | `[Club name]` placeholders in 16 pages (titles, home page heading) |
| Contact text, main website address (the "back to the main site" link) | Home page; not built yet |
| Brand colors (accent and its text color, light and dark mode) | `--accent` and `--accent-text` in `worker/public/styles.css` |
| Logo | New |
| Time zone | `CLUB_TIME_ZONE = "America/New_York"` in `worker/src/time.js` and `worker/public/js/common.js` |
| Resources and opening hours: the starting list | Created in the admin pages today (see decision 1) |
| Booking limits: max length, max upcoming bookings, days ahead, cancel cutoff, default suspension length, the no-show count in the rules | `worker/src/bookings.js`, `availability.js`, `discipline.js`; also written out by hand in `book.html`, `app.html`, `js/book.js`, `js/app.js` |
| Booking rules text | Three copies today: `rules.html`, `js/rules.js`, `app.html` |
| Hostname (and its zone) | `SITE_HOSTNAME` GitHub variable (Turnstile widget, smoke test) |

Only the brand colors move. The status colors (error, OK, free, taken) stay the same for
every club, so they always mean the same thing.

## What never goes in the config

The repo is public, so these stay where they are today:

- `PEPPER`, `IP_HASH_KEY`, the Turnstile secret, API tokens and account IDs: secrets.
- The alarm thresholds and the per-IP and flood-gate limits. They're never published, and
  they stay a sensitive Worker setting for each club.
- Member data, admin names, anything personal.

To make that stick, the config test accepts only a fixed list of keys. An unknown key fails
CI, so a threshold can't be added by accident.

## What stays the same for every club (product rules, not config)

- **15-minute blocks.** The database is built around them: one row per 15-minute slot, and
  `% 900` checks in `0001_init.sql`.
- **Retention:** bookings and no-shows 12 months, suspensions 12 months after they end,
  the audit log 24 months. These are privacy promises.
- **Security:** PIN login, the lockout steps, sessions, headers, CSRF.
- **League seasons:** at most 12 months.

## How the values reach the pages (recommendation)

- The Worker bundles `club.json` at build time. The deploy already bundles the Worker
  (`npm run build`).
- **Page text:** pages mark the spots (for example `data-club="name"`), and the Worker fills
  them in as it serves each page, using HTMLRewriter. No HTML build step, no files moved, no
  inline scripts, so the CSP doesn't change.
- **Colors:** the Worker serves a small `/club.css` with the club's color variables,
  loaded after `styles.css`.
- **Browser code** (time zone, limits for messages, rules text): a public `/club.json` from
  the Worker, holding only the public fields.
- **Logo:** served by the Worker. SVG files get a test that rejects scripts and event
  handlers, because an SVG can carry script.
- **Terraform** reads the hostname from `club.json`, for the Turnstile widget and later the
  custom domain. The `SITE_HOSTNAME` GitHub variable then retires (the owner removes it).
  The smoke test reads the hostname from the config too.

## Decisions for the owner

1, 2, 3 and 5 were agreed on 2026-11-28, as recommended. 4 is still open.

1. **Resources and hours.** Today they live in the database and are edited on the admin
   pages. **Recommended:** the config holds the starting list, loaded once into an empty
   database, and the admin pages own them after that. Otherwise every change to the hours
   needs a PR, and admin edits would be overwritten. (Alternative: the config is the only
   source and the admin pages for resources and hours go away.)
2. **Max booking length.** The database itself refuses member bookings over 2 hours (a
   check in `0001_init.sql`). **Recommended:** keep 2 hours as a ceiling for every club,
   enforced by the database. A club's config can set 2 hours or less, and the test rejects
   more. Raising the ceiling later needs a database migration.
3. **Time zone in the config.** It wasn't on the list, but it's club-specific.
   **Recommended:** yes. The nightly clean-up time (now picked for New York) then follows
   it.
4. **Rules text. (Open.)** **Recommended:** one copy in the config, with the numbers filled
   in from the limits (for example `{cancel_hours}`). Then the text can't disagree with the
   actual rules.
5. **How other clubs run it.** **Recommended:** one separate deployment per club, each with
   its own Cloudflare account, database, secrets and admin. That keeps each club's member
   data apart and leaves the threat model as it is. Not one shared site for many clubs.
   Where a second club's config and deploy live (this public repo with one environment per
   club, or their own copy) is decided before the second club. It's not part of this PR.

## Tests the PR adds

- Every `clubs/*/club.json` passes validation: allowed keys only, correct types, limits
  within the product ceilings, colors that meet WCAG AA contrast, a valid hostname, and
  only known placeholders in the rules text.
- No page has a `[Club name]` placeholder left, and pages show the configured name.
- Booking limits come from the config. The existing tests run with Pastime's values, plus
  one test with different values to prove nothing is hard-coded.
- The rules page, the booking confirmation and the "My bookings" page all show the same
  rules, from one source.

## Not in this PR

Setting up a second club, a deploy workflow for several clubs, and translations.

## To check while building it

- HTMLRewriter works on pages served from the static files
  (developers.cloudflare.com/workers/runtime-apis/html-rewriter/).
- The bundler can include `club.json` and the logo.
- `docs/architecture.md` and the README get matching sections in the same PR.
