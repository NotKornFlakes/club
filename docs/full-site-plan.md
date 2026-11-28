# Plan: the club's whole website

Status: **plan only. Nothing here is built.** Decisions agreed 2026-11-28 (section 11).
Build steps 1–9 wait until the owner has met the club; only step 0 (PR #16) is under way.
Scope changed on 2026-11-28: this project now
replaces the club's whole Weebly site, not just booking. `CLAUDE.md` has the requirements;
this document says how we'd meet them, the build steps, and what we need from the club.

## 1. What changes

One Worker serves the whole site on `pastimeathleticclub.org`:

- the public pages and the What's On calendar,
- the banquet inquiry form,
- member booking, and the admin and editor pages.

Once the club approves the new site, it goes live on the whole domain. Weebly, the Blogger
blog and the Google Calendar are then retired. The club's Google email stays as it is.

Nothing about member login, PINs, the booking rules, no-shows or the admin pages changes.
Everything already built carries over.

## 2. Public pages

| Page | What's on it | Where it comes from |
|---|---|---|
| Home | The club in a few lines, what's on this week, a "Member login" button | Content file + What's On data |
| History | Since 1892: text and a few photos | Content file |
| Athletics | Gym, pickleball, open gym, ping pong, youth: what each is and when | Content file + programs |
| Bowling | The 8 lanes, leagues, how members book a lane | Content file |
| Bar & Banquets | The bar, the rooms for events, the inquiry form | Content file + the form (section 4) |
| Photos | A gallery | Photo files (see below) |
| Visit | Address, a plain link to the club on OpenStreetMap, directions, parking | Club settings |
| What's On | The calendar (section 3) | Programs and public events in the database |
| Rules, logins | As today | As today |

**Recommendations:**

- **Page text lives with the club's settings, not in the code.** Each page is a small HTML
  file in `clubs/pastime/pages/`, which the Worker puts into the shared layout and menu.
  This keeps the per-club direction: another club brings its own pages.
- **A CI check allows only simple tags** in those files: headings, paragraphs, lists, links,
  bold and italic, and images. No scripts, styles, embeds or event attributes. Links must
  be `https://`, and images must be the club's own files. Page text changes go through a PR.
- **The map is a plain link to OpenStreetMap,** never an embedded map. That means no
  third-party script, no tracking, and no change to the CSP.
- **Photos are static files** in `clubs/pastime/photos/` for launch:
  - resized before they're added, with location data and other metadata stripped by a script;
  - only photos the club has permission to use, and no identifiable children without a
    parent's permission;
  - Workers Paid allows 100,000 files of up to 25 MiB each, far more than a gallery needs.
  - If volunteers later want to add photos themselves, that's a separate upload feature.
- **Old Weebly page addresses redirect** to the matching new page (a permanent redirect).
  Links from search engines and other sites then keep working. This needs the list of old
  pages.

## 3. What's On and programs

- **A program is a recurring block for one season,** like a league: one place, one or more
  weekdays, a start and end time, a public name, and an end date at most 12 months out. It
  is renewed when it ends. The admin or the editor sets it up once per season.
- **A program blocks its times for member booking.** A date that clashes with an existing
  member booking is skipped and listed, the same rule as leagues.
- **Recommended: leagues become programs** with "Show on What's On" turned off. That makes
  one feature instead of two. The site isn't live yet, so there's no live data to move.
- **What's On is public, with no login.** It shows the coming weeks' programs and any club
  events marked public. It never shows member bookings, names or member numbers.
  - The existing club-events calendar (members only today) gets a "Show on What's On" tick.
  - What's On reads from a public, read-only API that changes nothing. Answers can be
    cached for a few minutes.
- **Optional:** a calendar feed that people can subscribe to in their phone's calendar, in
  place of the Google Calendar. Worth it only if members subscribe to the Google Calendar
  today.
- **Starting programs** (the club confirms the end times, places and seasons):

  | Program | When |
  |---|---|
  | Pickleball | Monday to Friday, 11 a.m. |
  | Open gym | Monday to Friday, 3 p.m. |
  | Ping Pong | Sunday, 2 p.m. |
  | Youth | Saturday, 8 a.m. |

## 4. The banquet inquiry form

- **Fields:** name, email, and the request. No payments, and no online booking of the hall.
- **It sends one email to the club's inbox,** with Reply-To set to the visitor's address so
  the club can simply reply.
- **The address typed in never receives anything,** so nobody can use the form to send mail
  to strangers. Line breaks are refused in the name and email, so no extra mail headers can
  be slipped in.
- **The inquiry isn't stored on the site.** The email in the club's inbox is the only copy,
  and the form says so. This keeps the brief's rule of no emails stored.
- **Spam protection:**
  - Turnstile on this form all the time;
  - a hidden field that people never fill in but spam robots do;
  - per-IP limits, configurable and kept private like the other limits (the IP is stored
    only as an HMAC, as for logins);
  - length limits, and server-side checks on every field.
- **How it sends (recommended):** Cloudflare Email Service, from the Worker.
  - It sends from a separate sending subdomain, for example
    `noreply@forms.pastimeathleticclub.org`. Onboarding that subdomain adds its own MX, SPF,
    DKIM and DMARC records on that subdomain only, so the bare domain's Google MX records
    stay as they are. Onboarding the bare domain itself would add MX records there and
    break the club's Google email, so we don't.
  - It sends only to one verified club address, and the Worker's email setting is limited
    to that one recipient. Cloudflare says sends to verified addresses are free on every
    plan.
  - Caveats from Cloudflare's docs:
    - Email Sending is in beta.
    - New accounts start with a cautious daily limit.
    - Sent emails show as "dropped" in the Email Routing summary even when they arrive.
    - It needs the DNS on Cloudflare, so the form can only go live after the DNS move.
  - If that turns out to be unsuitable, the fallback is to show the club's email address
    instead of a form (agreed).

## 5. Courts, rooms and bowling lanes

- **Resources, to confirm with the club:** Gymnasium, 8 bowling lanes, President's Room,
  Century Room, Lounge. They go in the club's settings file as the starting list.
- **Recommended for the lanes:** eight resources, "Lane 1" to "Lane 8", grouped under
  "Bowling lanes" on the Book page. A member books one lane per booking, under the usual
  limits. All of this depends on the club's answers: whether members book lanes at all, for
  how long, and how many at once.

## 6. The editor role (a club volunteer)

**What an editor can do:**

- set up, renew and cancel programs;
- add and edit club events;
- place and cancel the club's own reservations (one-off bookings such as a banquet in the
  Century Room);
- see the schedule.

**What an editor can't do:**

- anything with members: PINs, PIN sheets, no-shows, suspensions, lockouts;
- admin or editor accounts;
- courts, rooms and hours, or the club's settings;
- the alarm panel or the audit log.

**Rules and how it's built:**

- **Editors see member bookings only as "Member booking",** with no name or number, ever.
- **Editors may cancel a member booking, with a required reason** (decided 2026-11-28):
  - The cancellation and the reason go in the audit log, under the editor's name.
  - The slot is freed, the same as when an admin cancels.
  - The member sees a notice on "My bookings" that the club cancelled the booking.
  - To settle in the editor PR, with my recommendations:
    - Should the notice show the reason, or a fixed message such as "Cancelled by the
      club. Please contact management"? Recommended: the fixed message. Reasons are
      written for the audit log and may not suit the member.
    - Should a booking an admin cancels get the same notice? Recommended: yes.
  - When a program clashes, editors see the clash list without names.
- **Login:** the same as admins: a long password, an authenticator code, 12-hour sessions
  and their own lockouts. The admin creates the editor account, with a one-time password
  and key, and can reset or disable it. Editors never use the setup token. How many editors
  a club may have is a club setting (1 for Pastime).
- **Enforced on the server, deny by default.**
  - Every admin route is marked either admin-only or admin-and-editor.
  - A test lists the routes an editor may use and checks that every other route refuses
    them.
  - The editor's pages hide admin links, but the server is what enforces the rules.
- **Every editor action goes in the audit log** under the editor's name, kept 24 months.

## 7. Launch on the whole domain

- The site serves `pastimeathleticclub.org`, and `www` redirects to it. **Recommended: drop
  the planned `book.` address.** Nobody uses it yet, and one address is simpler.
- **The DNS move happens first and changes nothing anyone can see,** as already planned in
  `docs/launch-dns.md` (steps 0–5). It can happen well before launch.
- **Launch happens only once the club approves the new site.**
  - Terraform adds custom domains for the bare domain and `www`.
  - The owner removes the Weebly records for those names, and the catch-all.
  - The steps are in `docs/launch-dns.md`, step 6.
- **Weebly, Blogger and the Google Calendar are retired after a settling period** (step 7).
  Until then, rollback is simply putting the Weebly records back.

## 8. Changes to security and privacy

- **Turnstile:** on the login pages while the alarm is on (as today), and always on the
  inquiry form.
- **New public surfaces:** the form, What's On and the content pages. The threat model gains:
  - form spam and attempts to misuse it for sending email;
  - a stolen editor login (limited rights, an authenticator code, everything logged);
  - photos of people (permission first).
- **Data:** inquiries are not stored. Nothing new about members is stored. Still no
  analytics.
- **Cost:** sending to the club's own verified inbox is free. The Workers Paid plan is
  needed anyway.

## 9. New build steps

The current build order ends with hardening, then the per-club config, then the custom
domain. The new order, one PR each:

0. **Get the stacked PRs onto `main`** (PR #16).
   - #7–#12 and #14 were each merged into their parent branch after that parent had already
     been merged, so their code isn't on `main`.
   - One PR brings them all over.
   - A dry run applied #7–#12 cleanly. #14 needs a small hand-merge in two seed files:
     `main` has the seed guard from #6, which the stack was built without.
1. **Editor role:** roles, editor accounts, per-route permissions, and the deny-by-default
   test.
2. **Programs and What's On:**
   - programs, with leagues folded in;
   - the public What's On page and its read-only API;
   - a "Show on What's On" tick for events;
   - optionally, the calendar feed.
3. **Site layout and content pages:**
   - the menu and shared layout;
   - Home, History, Athletics, Bowling, Bar & Banquets, Photos and Visit, from
     `clubs/pastime/pages/`;
   - the allowed-tags check, the photo script, and the redirects from old Weebly
     addresses.
4. **Bowling lanes,** once the club has answered: lane resources and the grouped Book page.
5. **Banquet inquiry form:**
   - Turnstile, the hidden field and the per-IP limit;
   - sending through Cloudflare Email Service.
   - The code and tests come first. Real sending is switched on after the DNS move.
6. **Hardening, second pass:** a security and accessibility review of the new public
   pages, the form and the editor role, plus threat model updates.
7. **DNS move** (`docs/launch-dns.md`, steps 0–5). Nothing visible changes. This can run in
   parallel with steps 1–6.
8. **Launch** (step 6 there): the custom domains, the email sending subdomain, the cutover,
   and the checks.
9. **Retire the old services** (step 7 there): Weebly, Blogger and the Google Calendar.

## 10. What we need from the club

1. **Approval of the plan:** the new site replaces Weebly. Who signs off on the finished
   site, and roughly when?
2. **The domain renewal** before 2027-01-11: auto-renew on, and a current card on file
   (already asked).
3. **The DNS questions** in `docs/launch-dns.md`, step 0 (the registrar login and so on).
4. **Rooms:** confirm the Gymnasium, 8 bowling lanes, President's Room, Century Room and
   Lounge. Send the real opening hours for each, and say which ones members may book.
5. **Bowling:** do members book lanes? If so, one lane or several at a time, and for how
   long? Are there bowling leagues?
6. **Programs:** for Pickleball, Open gym, Ping Pong and Youth:
   - the end time and the room;
   - the season dates;
   - whether each is for members only or open to the public;
   - a one-line description.
   Also: should leagues show on What's On?
7. **Youth program:** what may be said publicly about it, and confirmation that no names or
   photos of children go on the site without a parent's permission.
8. **Page text** for Home, History, Athletics, Bowling, Bar & Banquets and Visit, including
   parking, directions, accessibility and bar hours. Also the street address, and the
   contact details to show publicly.
9. **Photos:** which ones to use, permission from the people in them, credits, and
   permission to use the logo.
10. **Banquet inquiries:**
    - which inbox receives them, and who answers them;
    - whether anything is needed besides name, email and request (a date, the number of
      guests);
    - approval of the privacy wording.
11. **The editor:** who the volunteer is. They'll need an authenticator app on their phone.
12. **The old site:**
    - the list of Weebly pages (or permission for me to read the public site and its page
      list);
    - the Blogger blog's address, and which posts to keep;
    - which Google Calendars there are, and whether members subscribe to them;
    - who holds the Weebly, Blogger and Google Calendar accounts, so they can be closed
      after launch;
    - whether the club pays for Weebly, so the plan can be cancelled after launch.

## 11. Decisions (agreed 2026-11-28)

All seven are agreed as recommended, except number 2, which changed.

1. **Fold leagues into programs.** Agreed.
2. **Editors and member bookings.** Changed: editors never see names, but they *may* cancel
   a member booking with a required reason. It's logged in the audit log, and the member
   sees a notice (section 6).
3. **Inquiries are emailed, never stored.** Agreed.
4. **Send email through Cloudflare Email Service,** from a sending subdomain, to one
   verified club inbox. Agreed, with the beta caveat and the fallback of showing the club's
   email address.
5. **Photos as static files for launch,** with an upload feature later if wanted. Agreed.
6. **The bare domain is the main address, `www` redirects to it, and no `book.` address.**
   Agreed.
7. **Page text as small HTML files in `clubs/pastime/pages/`,** changed by PR. Editors don't
   edit page text, at least at first. Agreed.

## 12. Sources

| Fact | Source |
|---|---|
| Email Sending (beta) from a Worker with the `send_email` binding; recipients can be restricted; verified-address sends are free on every plan | developers.cloudflare.com/email-service/, …/email-service/api/send-emails/workers-api/, …/email-service/platform/pricing/ |
| Onboarding the root domain adds MX at the root; a subdomain is a separate sending domain and gets its own MX, SPF, DKIM and DMARC; needs Cloudflare DNS | developers.cloudflare.com/email-service/get-started/route-emails/, …/email-service/configuration/subdomains/ |
| New accounts start with a cautious daily quota; sent emails show as "dropped" in the Email Routing summary | developers.cloudflare.com/email-service/platform/limits/ |
| Static assets on Workers Paid: 100,000 files per version, 25 MiB per file | developers.cloudflare.com/workers/platform/limits/ |
