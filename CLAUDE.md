# Club Website and Booking: Project Brief

Read this at the start of every session. It is the source of truth for scope and decisions.

## Overview
Secure, simple website for Pastime Athletic Club, a private members club in Syracuse, NY
(500–1,000 members, mostly non-technical). It's the club's whole website: public pages,
a What's On calendar, a banquet inquiry form, and member booking. At launch, once the club
approves, it replaces the club's Weebly site (pastimeathleticclub.org); the club's Blogger
blog and Google Calendar are retired after that. The old WordPress site is already shut
down.
Scope changed 2026-11-28 from booking only to the whole site: `docs/full-site-plan.md`.

Product direction: I plan to offer this to other clubs. Pastime is the first. Everything
club-specific lives in the club's own folder, `clubs/<club>/`: its settings file
(`club.json`, built in #14) and, from the full-site work, its page text and photos.

Same pattern as my portfolio repo: everything in Terraform (except the club's own DNS
records; see Launch plan), GitHub Actions CI, changes
merged only via PR that I approve (MFA on), no secrets in the repo. No Microsoft services
other than GitHub. Repo is PUBLIC, so never commit secrets, member data, or PINs.

## Stack (decided)
- Cloudflare only, in a NEW Cloudflare account owned by the club. I'm the only member.
  Emergency access is the shared Proton Pass vault (see Admin).
- ONE Worker serves both the static pages and `/api/*` from a single origin
  (not Pages + Worker: SameSite=Strict cookies break across pages.dev/workers.dev,
  and Terraform can't upload Pages assets).
- Static files are uploaded by Terraform itself: `cloudflare_workers_script` supports
  `assets.directory` (checked in the provider docs on github.com, v5.29.0). No need to
  bundle pages into the Worker script.
- D1 database. Terraform with the Cloudflare provider.
- Terraform state: a private R2 bucket in the club's Cloudflare account. Never public (no
  r2.dev address, no custom domain); only a token scoped to that one bucket can read it.
- Worker code: plain JavaScript with `// @ts-check` and JSDoc types, type-checked in CI
  (`tsc --noEmit`). No compile step.
- Done by hand, once (agreed): create the state bucket; set `PEPPER` and `IP_HASH_KEY` with
  `wrangler secret put`. D1 migrations run through wrangler in the deploy job.
- Workers Paid plan ($5/month) needed for PIN hashing CPU time: Free allows 10 ms CPU per
  request, Paid defaults to 30 s (developers.cloudflare.com/workers/platform/limits/).
  [confirm with management]
- Worker sets all security headers itself, also after launch: the zone and its settings
  belong to the club, not this project.
- Plain HTML/CSS/JS, mobile-first, large buttons, simple wording.
- Use the workers.dev URL until launch, then the whole domain: pastimeathleticclub.org, with
  www redirecting to it (see Launch plan).

## Public vs. private
- Public pages: Home, History, Athletics, Bowling, Bar & Banquets, Photos, Visit (address
  and a plain OpenStreetMap link; no Google or other map embed), What's On, Rules, and the
  login pages.
- Page text and photos are the club's content, kept in `clubs/pastime/`, not in the code.
- Everything else requires login (member, editor or admin).

## Out of scope
- Payments of any kind.
- Booking or renting the banquet hall online (no contracts or deposits). The site takes
  inquiries only (see Banquet inquiries).
- Analytics.

## Member login (no email, no signup)
- Members already have member numbers. Login = member number + 6-digit PIN that I issue.
- PINs: PBKDF2-SHA256 at 100,000 iterations PLUS a secret pepper stored as a Worker secret
  (never in D1, the repo, or Terraform state). 100,000 is the Workers runtime's hard cap
  (verified: github.com/cloudflare/workerd, `src/workerd/io/limit-enforcer.h`).
- IP addresses (for rate limiting) are stored only as HMAC-SHA256 with a separate secret key,
  `IP_HASH_KEY` (Worker secret, same handling as the pepper). Never raw, never a plain hash.
- Copies of the pepper and the IP-hash key are kept in the shared Proton Pass vault
  (emergency access, see Admin).
- Lockouts are timed and escalating (15 min → 1 hour → 24 hours), never permanent.
  Admin can clear a lockout. Rate-limit per member number and per IP.
  Accepted risk: anyone who knows a member number can lock that member out for up to 24 h.
- Club-wide alarm: if failed logins spike, slow all logins, show warning on admin page,
  and show Cloudflare Turnstile on the login form only while the alarm is on.
- Alarm thresholds (and the per-IP and flood-gate limits) are Worker settings. NEVER publish
  their actual values: not in the repo, docs, README, PRs, commits or CI logs. Public text
  says "configurable thresholds".
- Session: secure, HttpOnly, SameSite=Strict cookie, 30-day expiry.
- Disabling a member or resetting their PIN logs them out everywhere.
- PIN sheets can only be printed at import/reset time (PINs are hashed; lost PIN = reset).

## Booking rules
- Resources (confirm with the club): Gymnasium, 8 bowling lanes, President's Room, Century
  Room, Lounge. Open hours: [hours], configurable per resource, in the club's local time
  (America/New_York for Pastime; stays correct across DST). Whether and how members book
  bowling lanes: pending club answer.
- 15-minute blocks; a booking is 1+ consecutive blocks, max 2 hours.
- Max 2 upcoming bookings per member (a booking counts until it ends).
- Book up to 30 days ahead (rolling 30 days, not calendar months). Show it to members as
  "up to 30 days ahead".
- Booked slots show only "Taken". Never show names or member numbers to members.
- Members can cancel their own booking up to 24 hours before start; not within 24 hours.
  Show this rule clearly before they confirm.
- "Add to calendar" (.ics download) after booking, for reminders.
- Calendar of club events at other locations (view only).
- Double booking prevented by a database constraint, not just the UI.
- All times stored in UTC, displayed in the club's time zone.

## What's On and programs
- A public "What's On" calendar, generated from the booking system: programs and club
  events marked public. Never member bookings, names or member numbers.
- Programs are recurring blocks set once per season (end date at most 12 months out,
  renewed when it ends): one place, one or more weekdays, a start and end time.
  Starting programs (the club confirms end times, places and seasons): Mon–Fri 11 a.m.
  Pickleball, Mon–Fri 3 p.m. Open gym, Sun 2 p.m. Ping Pong, Sat 8 a.m. Youth.
- A program blocks its times for member booking. A date that clashes with an existing
  member booking is skipped and listed (same rule as leagues).
- Planned: leagues become programs that don't show on What's On.

## Banquet inquiries
- A public form on Bar & Banquets: name, email, request. It emails the club's inbox. No
  payments, no online booking.
- Spam protection: Turnstile always on this form, a hidden honeypot field, per-IP limits
  (configurable; values kept private like the other limits), length limits, server-side
  validation.
- Sent only to the club's one fixed address, never to the address typed in, so the form
  can't be used to email strangers. No line breaks allowed in header fields.
- Not stored on the site: the email in the club's inbox is the only copy. The form says so.
- Sent with Cloudflare Email Service from a sending subdomain to one verified club address.
  Never onboard the bare domain for email (it would break the club's Google MX). Email
  Sending is in beta; it needs the DNS move first.

## Editor (club volunteer)
- One club volunteer can have an editor login: same rules as admins (strong password +
  TOTP, 12-hour sessions, own lockouts), created, reset and disabled by the admin; never
  through the setup token. The editor limit is a club setting (Pastime: 1).
- Editors can: programs, club events, and the club's own reservations (one-off bookings,
  e.g. a banquet in the Century Room). They see member bookings only as "Member booking",
  never names or numbers.
- Editors may cancel a member booking, but only with a required reason. The cancellation
  and reason go in the audit log, and the member sees a notice that the club cancelled it
  (decided 2026-11-28).
- Editors can't: members, PINs, PIN sheets, no-shows, suspensions, lockouts, admin or editor
  accounts, courts, rooms and hours, club settings, the alarm panel, the audit log.
- Enforced on the server, deny by default, with a test listing every route an editor may
  call. Every editor action goes in the audit log.

## No-shows (honor system)
- No check-in, no QR codes, no automatic tracking. Management reports problems to me.
- Admin can record a no-show against a member (date + note).
- Admin can suspend a member from booking for a chosen period (default 6 months), with a
  required reason, logged in the audit log. Admin can lift a suspension early.
- Suspending a member cancels their upcoming bookings (logged), freeing the slots.
- Suspended members can still log in and view, but see:
  "Your booking access is suspended until [date]. Contact management."
- Members see their own no-show count for the last 12 months (dates only).
  Notes are admin-only. No-show records deleted after 12 months.

## Booking rules disclaimer
Show on the booking confirmation screen with a required "I agree" checkbox, and on a
Rules page linked in the footer:

> **Booking Rules**
> - Bookings can be cancelled up to 24 hours before the start time. Within 24 hours, they can't be cancelled.
> - If you can't make your booking, please let management know.
> - Missed bookings are tracked by management. Members who miss 3 bookings may lose booking privileges for 6 months.
> - Please book only the time you'll use, so other members get a turn.
> - Your member number and PIN are for you only. Don't share them.

## Admin (me only)
- There is no backup admin. Emergency access: a Proton Pass vault shared between me and one
  club officer.
- The admin limit is a per-club config setting: default 2 (room for a future helper).
  Pastime uses 1.
- Separate admin login: strong password + TOTP 2FA. Separate cookie, 12-hour sessions.
- Create/edit resources, hours, and club events.
- Place one-off bookings with no date limit, and recurring blocks (leagues and programs),
  both overriding member rules.
- Create, reset and disable the editor's login.
- Every league has a season with an end date, at most 12 months out. I renew a season
  when it ends.
- When a league block clashes with an existing member booking: skip that date and list
  the clashes for me.
- Admins can cancel any booking at any time, including within 24 hours.
- See who booked each slot.
- Record no-shows, suspend/unsuspend members.
- Members: bulk-import member numbers from CSV, add/disable a member, reset a PIN,
  export a printable PIN sheet (only at creation/reset).
- Audit log of all admin and editor actions, kept 24 months.

## Data & privacy
- Store only: member number, optional display name (admin-only), hashed PIN, bookings,
  no-shows, suspensions, and the programs and events behind What's On. No emails or phone
  numbers. Banquet inquiries are emailed to the club and never stored on the site.
- Photos only with permission from the people in them. No identifiable children without a
  parent's permission. Location data is removed from photo files.
- Auto-delete bookings older than 12 months.
- Auto-delete suspension records 12 months after the suspension ends (same as no-shows).
  The audit log entry about the suspension stays for its full 24 months.
- No analytics. No third-party scripts except Turnstile: on the login pages while the alarm
  is on, and always on the banquet inquiry form. Links to other sites (OpenStreetMap) are
  plain links, never embeds.

## Security requirements
- Server-side validation on every request; parameterized D1 queries only.
- CSRF protection on every state-changing request.
- Headers: strict CSP (no inline scripts), HSTS, X-Frame-Options DENY, Referrer-Policy,
  Permissions-Policy.
- CI: terraform fmt/validate, Checkov, dependency + secret scanning.
- Cloudflare API token scoped as tightly as possible (separate account makes account-wide
  rights = this project only); stored as a GitHub Actions secret.
- Branch ruleset + required reviewer on production environment (set up after first PR).
- The threat model also covers the new public surfaces: form spam and attempts to misuse it
  for sending email, a stolen editor login, and photos of people.
- The threat model must say plainly: a 6-digit PIN has only 1,000,000 possible values. If
  the D1 database ever leaked, hashing alone would not stop someone trying every PIN
  offline. The pepper, kept outside D1, is what protects PINs in that case.

## Club details
- Club name: Pastime Athletic Club
- Location: Syracuse, NY. Founded 1892.
- Mission: health, wellness, charity and sport.
- Today: pastimeathleticclub.org on Weebly, a Blogger blog and a Google Calendar. All three
  are retired after launch, once the club approves the new site.
- This site: pastimeathleticclub.org, with www redirecting to it (workers.dev address until
  launch). The planned book. address is dropped.
- Email: Google, and it stays.
- Contact: [ ]
- Street address: [ ] (Syracuse, NY)
- Rooms (confirm with club): Gymnasium, 8 bowling lanes, President's Room, Century Room,
  Lounge.
- Hours: [ ]
- These values live in `clubs/pastime/club.json` (built in #14; the bowling lanes are added
  once the club confirms).

## Launch plan (whole domain)
- Launch serves the whole domain (pastimeathleticclub.org; www redirects to it), only once
  the club approves the new site. Old Weebly page addresses redirect to the new pages.
- After a settling period agreed with the club: retire Weebly (cancel the plan), the Blogger
  blog and the Google Calendar. Until then, rollback is putting the Weebly records back.
- A Worker custom domain needs the domain to be an active zone on Cloudflare. Moving only
  one name (partial or subdomain setup) needs a Business or Enterprise plan. So all of
  pastimeathleticclub.org's DNS moves to the club's Cloudflare account ("full setup").
- The DNS move comes first and changes nothing anyone can see. The Weebly site and email
  keep working: every existing DNS record is copied exactly, as "DNS only", before the
  nameservers change.
- After the move, the zone and all existing records belong to the club and are edited in the
  Cloudflare dashboard. No club DNS accounts: the club's DNS rarely changes, and any
  future change is a small task I do.
- Optional after launch: SPF, DKIM and DMARC (`p=none` first) for the club's Google email
  (`docs/launch-dns.md`, step 8).
- Terraform manages ONLY what this project needs: the custom domains for the bare domain and
  www, plus CAA records if ever needed. It never creates or imports the zone or the club's
  records, so the drift check never sees them. A CI check enforces this. The email sending
  subdomain is onboarded by me in the dashboard.
- Step-by-step plan, checks and rollback: `docs/launch-dns.md`.
- No DNS, nameserver or registrar changes until I say go. The registrar side (DNSSEC,
  nameservers) is mine alone.

## How to work
1. Propose the architecture and D1 schema and wait for my approval before writing code.
2. Build in small PRs: infra → member auth → availability view → booking →
   no-shows and suspensions → admin → hardening → per-club config (all built) → get the
   stack onto main → editor role → programs and What's On → site layout and content pages →
   bowling lanes → banquet inquiry form → hardening, second pass → launch on the whole
   domain (after the DNS move and the club's approval) → retire Weebly, Blogger and Google
   Calendar. Details: `docs/full-site-plan.md`, section 9.
3. Explain each step in plain language. I'm learning as we go.
4. README: setup, issuing/resetting PINs, adding leagues and programs, suspending a member,
   the editor role, changing page text and photos, threat model, and a one-page "How to
   book" guide for members.
5. Only cite official sources (developers.cloudflare.com, github.com, owasp.org).
   Exception: Google's help (support.google.com, and knowledge.workspace.google.com where
   its Workspace pages now redirect), for the Google email-record step only
   (`docs/launch-dns.md`, step 8).
6. Claude never merges PRs, never approves PRs or deployments, and never changes repo
   settings, rulesets, environments or secrets. Only the owner does these, in the GitHub web
   UI. Claude may read settings (GET requests) to verify them.
   Partly enforced by deny rules in `.claude/settings.json`. Where those can't match a
   command, this rule is the only guard.
7. Claude pushes only feature branches, always naming the branch
   (`git push origin <branch>`), never `main`.

## Status
- [x] Requirements agreed
- [x] Repo created (public) and cloned
- [x] Brief committed to the repo
- [x] Architecture + D1 schema approved 2026-11-26, with changes (`docs/architecture.md`)
- [ ] Branch ruleset + `production` environment reviewer set up (before the first merge)
- [x] Build steps 1–7 and per-club config merged (#6–#12, #14)
- [ ] Get #7–#12 and #14 onto main: each was merged into its parent branch, after that
  parent had already been merged, so only #6 reached main. PR #16 brings the rest over.
- [ ] Full site (planned 2026-11-28 in `docs/full-site-plan.md`; decisions agreed; not
  built). Steps 1–9 wait until I've met the club.
- [ ] DNS move and launch (planned in `docs/launch-dns.md`; nothing changed yet)
