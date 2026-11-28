# Club Booking Site: Project Brief

Read this at the start of every session. It is the source of truth for scope and decisions.

## Overview
Secure, simple booking website for Pastime Athletic Club, a private members club in
Syracuse, NY (500–1,000 members, mostly non-technical). The club's old WordPress site is
shut down. The club's public website stays on Weebly (pastimeathleticclub.org); this
project is only the member booking site, at book.pastimeathleticclub.org.

Product direction: I plan to offer this to other clubs. Pastime is the first. Everything
club-specific moves into one config file per club (planned in `docs/per-club-config.md`).

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
- Use the workers.dev URL until launch, then book.pastimeathleticclub.org (see Launch plan).

## Public vs. private
- Public: simple landing page (club name, contact, "Member login", a link back to
  pastimeathleticclub.org), Rules page. The main public website is the Weebly site; the
  booking site doesn't duplicate it.
- Everything else requires login.

## Out of scope
- Banquet hall rentals.
- Payments of any kind.

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
- Resources: basketball court, [room names]; possibly bowling lanes (pending club answer).
  Open hours: [hours], configurable per resource, in America/New_York local time (stays
  correct across DST).
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
- All times stored in UTC, displayed in America/New_York.

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
- Place one-off bookings with no date limit, and recurring blocks (leagues), both
  overriding member rules.
- Every league has a season with an end date, at most 12 months out. I renew a season
  when it ends.
- When a league block clashes with an existing member booking: skip that date and list
  the clashes for me.
- Admins can cancel any booking at any time, including within 24 hours.
- See who booked each slot.
- Record no-shows, suspend/unsuspend members.
- Members: bulk-import member numbers from CSV, add/disable a member, reset a PIN,
  export a printable PIN sheet (only at creation/reset).
- Audit log of all admin actions, kept 24 months.

## Data & privacy
- Store only: member number, optional display name (admin-only), hashed PIN, bookings,
  no-shows, suspensions. No emails or phone numbers.
- Auto-delete bookings older than 12 months.
- Auto-delete suspension records 12 months after the suspension ends (same as no-shows).
  The audit log entry about the suspension stays for its full 24 months.
- No analytics. No third-party scripts except Turnstile while the alarm is on.

## Security requirements
- Server-side validation on every request; parameterized D1 queries only.
- CSRF protection on every state-changing request.
- Headers: strict CSP (no inline scripts), HSTS, X-Frame-Options DENY, Referrer-Policy,
  Permissions-Policy.
- CI: terraform fmt/validate, Checkov, dependency + secret scanning.
- Cloudflare API token scoped as tightly as possible (separate account makes account-wide
  rights = this project only); stored as a GitHub Actions secret.
- Branch ruleset + required reviewer on production environment (set up after first PR).
- The threat model must say plainly: a 6-digit PIN has only 1,000,000 possible values. If
  the D1 database ever leaked, hashing alone would not stop someone trying every PIN
  offline. The pepper, kept outside D1, is what protects PINs in that case.

## Club details
- Club name: Pastime Athletic Club
- Location: Syracuse, NY. Founded 1892.
- Mission: health, wellness, charity and sport.
- Public website: pastimeathleticclub.org, on Weebly, and it stays there. Its menu gets a
  "Member Booking" link to the booking site.
- Booking site: book.pastimeathleticclub.org (workers.dev address until launch).
- Contact: [ ]
- Rooms: [ ]
- Bowling lanes: [pending club answer]
- Hours: [ ]
- With the per-club config PR, these values move to `clubs/pastime/club.json`.

## Launch plan (custom domain)
- A Worker custom domain needs the domain to be an active zone on Cloudflare. Moving only
  one name (partial or subdomain setup) needs a Business or Enterprise plan. So all of
  pastimeathleticclub.org's DNS moves to the club's Cloudflare account ("full setup").
- The Weebly site and email must keep working: every existing DNS record is copied
  exactly, as "DNS only", before the nameservers change. The only new name is `book`.
- After the move, the zone and all existing records belong to the club and are edited in the
  Cloudflare dashboard. No club DNS accounts: the club's DNS rarely changes, and any
  future change is a small task I do.
- Optional after launch: SPF, DKIM and DMARC (`p=none` first) for the club's Google email
  (`docs/launch-dns.md`, step 8).
- Terraform manages ONLY what this project needs: the `book` custom domain, plus CAA
  records if ever needed. It never creates or imports the zone or the club's records, so
  the drift check never sees them. A CI check enforces this.
- Step-by-step plan, checks and rollback: `docs/launch-dns.md`.
- No DNS, nameserver or registrar changes until I say go. The registrar side (DNSSEC,
  nameservers) is mine alone.

## How to work
1. Propose the architecture and D1 schema and wait for my approval before writing code.
2. Build in small PRs: infra → member auth → availability view → booking →
   no-shows and suspensions → admin → hardening → per-club config (after the stacked PRs
   merge; `docs/per-club-config.md`) → custom domain (after the DNS move).
3. Explain each step in plain language. I'm learning as we go.
4. README: setup, issuing/resetting PINs, adding leagues, suspending a member,
   threat model, and a one-page "How to book" guide for members.
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
- [ ] Build steps (see How to work)
- [ ] Per-club config (planned in `docs/per-club-config.md`; not built yet)
- [ ] DNS move and custom domain (planned in `docs/launch-dns.md`; nothing changed yet)
