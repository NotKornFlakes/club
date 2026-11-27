# Club Booking Site: Project Brief

Read this at the start of every session. It is the source of truth for scope and decisions.

## Overview
Secure, simple booking website for a private members club (500–1,000 members, mostly
non-technical). Replaces the club's old WordPress site, which is shut down.

Same pattern as my portfolio repo: everything in Terraform, GitHub Actions CI, changes
merged only via PR that I approve (MFA on), no secrets in the repo. No Microsoft services
other than GitHub. Repo is PUBLIC, so never commit secrets, member data, or PINs.

## Stack (decided)
- Cloudflare only, in a NEW Cloudflare account owned by the club (me + backup admin as members).
- ONE Worker serves both the static pages and `/api/*` from a single origin
  (not Pages + Worker: SameSite=Strict cookies break across pages.dev/workers.dev,
  and Terraform can't upload Pages assets).
- D1 database. Terraform with the Cloudflare provider.
- Workers Paid plan ($5/month) needed for PIN hashing CPU time. [confirm with management]
- Worker sets all security headers itself until the custom domain/zone is added.
- Plain HTML/CSS/JS, mobile-first, large buttons, simple wording.
- Use the workers.dev URL until I add the club's domain at the end.

## Public vs. private
- Public: simple home page (club name, contact, "Member login"), Rules page.
- Everything else requires login.

## Member login (no email, no signup)
- Members already have member numbers. Login = member number + 6-digit PIN that I issue.
- PINs: PBKDF2-SHA256 at 100,000 iterations (Workers limit; verify against Cloudflare docs)
  PLUS a secret pepper stored as a Worker secret (never in D1 or the repo).
- Lockouts are timed and escalating (15 min → 1 hour → 24 hours), never permanent.
  Admin can clear a lockout. Rate-limit per member number and per IP.
- Club-wide alarm: if failed logins spike, slow all logins, show warning on admin page,
  and show Cloudflare Turnstile on the login form only while the alarm is on.
- Session: secure, HttpOnly, SameSite=Strict cookie, 30-day expiry.
- Disabling a member or resetting their PIN logs them out everywhere.
- PIN sheets can only be printed at import/reset time (PINs are hashed; lost PIN = reset).

## Booking rules
- Resources: basketball court, [room names]. Open hours: [hours], configurable per
  resource, in America/New_York local time (stays correct across DST).
- 15-minute blocks; a booking is 1+ consecutive blocks, max 2 hours.
- Max 2 upcoming bookings per member (a booking counts until it ends).
- Book up to 1 month in advance.
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

## Admin (me + one backup admin)
- Separate admin login: strong password + TOTP 2FA. Separate cookie, 12-hour sessions.
- Create/edit resources, hours, and club events.
- Place bookings and recurring blocks (leagues) with no date limit, overriding member rules.
  When a league block clashes with an existing member booking: skip that date and list
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

## Club details (to fill in)
- Club name: [ ]
- Contact: [ ]
- Rooms: [ ]
- Hours: [ ]

## How to work
1. Propose the architecture and D1 schema and wait for my approval before writing code.
2. Build in small PRs: infra → member auth → availability view → booking →
   no-shows and suspensions → admin → hardening → custom domain.
3. Explain each step in plain language. I'm learning as we go.
4. README: setup, issuing/resetting PINs, adding leagues, suspending a member,
   threat model, and a one-page "How to book" guide for members.
5. Only cite official sources (developers.cloudflare.com, github.com, owasp.org).

## Status
- [x] Requirements agreed
- [x] Repo created (public) and cloned
- [ ] Architecture + D1 schema approved
- [ ] Build steps (see How to work)
