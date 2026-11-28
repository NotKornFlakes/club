# Launch: moving the DNS to Cloudflare, then the whole domain to the new site

Status: **plan only. Nothing here has been done.** No DNS, nameserver or registrar changes
happen until the owner says go.

Goal, in two stages:

1. First, move the domain's DNS to Cloudflare without changing anything anyone can see. The
   Weebly site and the club's email keep working (steps 0–5).
2. Then, once the club approves the new site, launch it on the whole domain,
   `pastimeathleticclub.org` and `www` (step 6). After that, retire Weebly, the Blogger blog
   and the Google Calendar (step 7).

The club's email keeps working throughout. Scope changed 2026-11-28 from a `book.`
subdomain to the whole domain (`docs/full-site-plan.md`).

## 1. Why the DNS has to move

DNS is the internet's address book for the domain. It says where the website lives
(Weebly), where email goes, and so on. Some company runs that address book for the club
today (step 0 confirms which one).

To put the new site on `pastimeathleticclub.org`, Cloudflare must run the whole address
book:

- A Workers custom domain needs "an active Cloudflare zone", meaning the domain is set up
  in Cloudflare.
- Cloudflare can run just some names while another company runs the rest, but only on
  paid plans: CNAME ("partial") setup needs Business or Enterprise, and subdomain setup
  needs Enterprise.
- So we use **full setup**: the domain's nameservers point to Cloudflare, and Cloudflare
  answers for every name in the domain. The zone itself can be on the Free plan.

Moving the address book does **not** move the website or the email. Weebly keeps hosting
the site until launch, and the email provider keeps handling mail. We copy every existing
entry exactly, so the copies point to the same places they do now. Nothing new is added
until launch.

### Who owns what after the move

| Owner | What | Edited where |
|---|---|---|
| **The club** | The zone, and every record that exists today (website, email, any catch-all, anything else). Zone settings and DNSSEC. Any record added later. | Cloudflare dashboard, by the owner |
| **This project** | From launch: the custom domains for the bare domain and `www`. CAA records too, but only if they're ever needed (step 6). The email sending subdomain's records are added by Cloudflare when the owner onboards it. | Terraform PRs in this repo; the sending subdomain in the dashboard |

- Terraform never creates, imports or changes the zone or the club's records. It only
  refers to the zone (by its ID or name, which aren't secret).
- **Who edits the club's DNS:** the owner, as a small task when one comes up. The club
  doesn't get its own DNS accounts. Changes are rare.
- **Two rules when editing the club's DNS after launch:** leave the site's own names alone
  (the bare domain, `www` and the sending subdomain), and don't add CAA records without
  checking step 6 first.

### How the drift check stays out of the club's records

The weekly drift check runs `terraform plan`, which only compares the things Terraform
manages. Records made in the dashboard aren't part of Terraform at all. So the check never
sees them, never reports them as drift, and a deploy never undoes them.

To keep it that way, the custom-domain PR adds a CI check that fails if `infra/` ever:

- declares a `cloudflare_zone` resource, or any zone-wide resource (zone settings, DNSSEC,
  rules), since those belong to the club;
- declares a `cloudflare_dns_record` that isn't a CAA record, since the site's records come
  with the custom domains and need no records of their own;
- uses any Cloudflare resource type outside a short allowed list.

Nobody runs `terraform import` on the club's records.

What the drift check still watches: the custom domains, any CAA records Terraform owns,
and everything it watches today. One gap: the DNS records for the custom domains are made by
Cloudflare, not by Terraform resources, so the drift check may not notice if someone deletes
one in the dashboard. The site going down would show it. That's why the site's names are
left alone when editing the club's DNS.

### What stays the same, and what changes

| Stays the same | Changes |
|---|---|
| Weebly hosts the public site until launch | The domain's nameservers point to Cloudflare |
| The email provider and mailboxes | DNS changes are made in the Cloudflare dashboard (by the owner) instead of at the old DNS host |
| Where the domain is registered and renewed | At launch: the bare domain and `www` point to the new site, and Weebly, Blogger and the Google Calendar are retired afterwards |

### Who does what

- **Claude:** writes the launch PR (custom domains, redirects) and the CI check. Never logs in to the
  registrar or the Cloudflare dashboard. Never changes nameservers, DNSSEC, DNS records, or
  GitHub settings, variables or secrets.
- **Owner:** the registrar (DNSSEC, nameservers), setting up the zone and copying the records
  in the Cloudflare dashboard, onboarding the email sending subdomain, the cutover (removing
  the Weebly records), any later DNS change, API token permissions, the `SITE_HOSTNAME`
  GitHub variable, reviewing and merging PRs, and approving deploys.
- **Club:** answers the questions in step 0 and in `docs/full-site-plan.md` (section 10),
  approves the new site before launch, and agrees when the old services are retired
  (step 7).

## 2. The steps

### Step 0: questions to answer first

1. **Registrar.** Where is the domain registered? Who has the login? It should be a club
   account with MFA on, with the login kept in the shared Proton Pass vault (emergency
   access). Anyone with that login can take over the website, the email and the booking.
2. **Renewal. The domain expires on 2027-01-11.** The club must confirm that auto-renew is on
   at the registrar and that the card on file is current. Do this first. If the domain
   lapses, the website, the email and the booking all stop working.
3. **Can the nameservers be changed there?** If the registrar won't allow it, stop here and
   decide with the club. Moving the registration elsewhere is a separate project.
4. **Current DNS host.** This is often the registrar. It could also be Weebly or another
   company.
5. **Email.** Which provider handles `@pastimeathleticclub.org` mail? Does anything else
   send mail as the club (a newsletter tool, Weebly forms)?
6. **Other names in use**, and what each one is for. Step 1 finds names, but not their
   purpose.
7. **Is DNSSEC on?** The `dig DS` line in step 1 shows it: any answer means it's on.
8. **When to switch.** Pick a quiet time, not just before an event, when someone can send
   and receive test emails.

### Step 1: list every record (no changes)

- Export the zone from the current DNS host as a **BIND zone file** if it offers that.
  Otherwise copy every record from its DNS page. That page is the real list. Lookups can only
  find names you think to ask about. Check that the list has:
  - the bare domain (`pastimeathleticclub.org`) and `www`: the Weebly site
  - a **catch-all record** (`*`), if there is one. It answers for every name that has no
    record of its own.
  - **MX**: where email is delivered
  - **TXT** on the bare domain: SPF (`v=spf1 ...`) and verification codes, if any
  - **DKIM**: TXT or CNAME records under `<selector>._domainkey`, if any. The selector name
    differs by provider; the email provider's admin page shows it.
  - **DMARC**: TXT at `_dmarc`, if any
  - SRV records or `autodiscover` names (email setup in mail apps), if any
  - **CAA** records, if any (see step 6)
  - every other name on the DNS host's page
- Keep the list and the outputs below **outside this repo** (the password manager, or a
  private note). DNS answers are public, but the full list of names isn't easy to find, and
  this repo is public.
- Save a "before" picture (change nothing; these only read):

  ```sh
  D=pastimeathleticclub.org
  dig NS $D
  dig DS $D          # any answer = DNSSEC is on; note the TTL (seconds)
  dig +short A $D
  dig +short AAAA $D
  dig +short CNAME www.$D
  dig +short A www.$D
  dig +short A made-up-name-check.$D   # an answer = there's a catch-all (*) record
  dig +short MX $D
  dig +short TXT $D
  dig +short TXT _dmarc.$D
  dig +short CAA $D
  # www: if the CNAME line above gave an answer, that record must go before launch (no custom domain on a CNAME)
  # DKIM: dig +short TXT <selector>._domainkey.$D   (and CNAME, if the provider uses that)
  ```

- Send one test email **to** a club address, and one **from** it to an address outside the
  club. In each message's full headers, note the `spf=` and `dkim=` results, whatever they
  are (`pass`, `none`, ...).
  After the switch, the same tests should show the same results.

### Step 2: build the copy in Cloudflare (owner, in the dashboard; nothing live changes)

- Add `pastimeathleticclub.org` to the club's Cloudflare account (full setup). Until the
  nameservers change, the rest of the internet doesn't know about it and keeps using the old
  DNS host.
- Enter the records from the step 1 list: import the BIND file with **"Proxy imported DNS
  records" turned off**, or type them in. Use the same name, type, value, TTL and MX
  priority.
- Every copied record is **DNS only**. Visitors then connect straight to Weebly as they do
  now, and Weebly keeps handling its own HTTPS. Email records can't be proxied anyway: only
  A, AAAA and CNAME records can.
- Compare Cloudflare's record list with the step 1 list, line by line. Add anything missing
  and delete anything extra. Cloudflare says its automatic scan "is not guaranteed to find
  all existing DNS records". And with a catch-all record, every name it tries gets an
  answer, so it may add records that don't really exist.
- Note the two nameservers Cloudflare assigns.

Optional extra check: Cloudflare's docs don't promise this, but the assigned nameservers
may already answer for the new zone. If `dig @<assigned-nameserver> MX pastimeathleticclub.org`
gives an answer, compare it, and the other step 1 lines, with the "before" picture.

### Step 3: turn off DNSSEC (owner, only if step 1 found it on)

- At the registrar, remove the DS record (turn DNSSEC off).
- Wait until the DS record's TTL from step 1 has passed. Changing nameservers sooner can
  make the domain unreachable: resolvers that check DNSSEC will return errors.
- Cloudflare also documents a way to move with DNSSEC on the whole time (multi-signer). It
  needs the old DNS host's support and has many more steps. **Recommendation:** the simple
  way. The domain is just unsigned for a short time.

### Step 4: switch the nameservers (owner, at the registrar)

- Replace the old nameservers with the two from step 2. Cloudflare says this can take up to
  24 hours.
- **Don't delete anything at the old DNS host.** Leave it exactly as it was for at least a
  week. Some resolvers keep asking the old host for a while, and it's also the rollback.
  (Our rule, not from Cloudflare's docs.)
- The zone shows as **Active** in the Cloudflare dashboard once the change is seen.

### Step 5: check that nothing broke

- Run the step 1 `dig` lines again, adding `@1.1.1.1` (and once more with `@8.8.8.8`). Every
  answer should match the "before" picture, except NS, which now shows Cloudflare.
- **Website:** open `http://` and `https://` on the bare domain and on `www`. The Weebly
  site loads, with no certificate warning.
- **Email:** repeat both test emails. The `spf=` and `dkim=` results match step 1.
- If DNSSEC was on: turn it on in Cloudflare and add the new DS record at the registrar.

**Rollback**, if the site or email breaks and it isn't a quick record fix: the owner puts
the old nameservers back at the registrar. That works because the old DNS host was left
untouched. The same delay of up to 24 hours applies.

### Step 6: launch on the whole domain (only once the club approves the new site)

Before starting:

- The club has approved the finished site (`docs/full-site-plan.md`, section 10).
- The list of old Weebly page addresses is in, and each one redirects to its new page.
- The banquet form's email has been tested from the workers.dev address (below).
- The site isn't a demo: the `DEMO_MODE` variable is unset, and no page shows the demo
  banner. The club's site runs in the club's own Cloudflare account with a new database.
  Nothing is carried over from the demo.

**The email sending subdomain** (owner, in the dashboard, before the cutover):

- Onboard a sending subdomain such as `forms.pastimeathleticclub.org` for Cloudflare Email
  Sending. Cloudflare adds that subdomain's own MX, SPF, DKIM and DMARC records. The bare
  domain's Google MX records stay as they are.
- **Never onboard the bare domain itself.** That would add MX records at the bare domain
  and break the club's Google email.
- Add the club inbox that receives inquiries as a verified destination address.

**The Terraform PR:**

- `cloudflare_workers_custom_domain` for `pastimeathleticclub.org` and for
  `www.pastimeathleticclub.org`, with the Worker as `service`. Cloudflare then creates the
  DNS records and the certificates itself.
- The Worker redirects `www` to the bare domain.
- The PR also adds the CI check from "How the drift check stays out of the club's records".
- **Records already on those names:** today they point to Weebly.
  - Cloudflare's custom domains page only says a custom domain can't go on a name with a
    CNAME record. It doesn't say what happens with an A record already there. The PR finds
    out on the workers.dev setup first.
  - The plan assumes the owner deletes the Weebly records for the bare domain and `www`
    just before the apply.
  - That means a few minutes without a site, so do it at a quiet time.
- **CAA records**, only if the zone has any:
  - Each custom domain's certificate is an "Advanced Certificate". Cloudflare adds its own
    CAA entries automatically only for Universal SSL, not for these.
  - If the zone has CAA records, they must allow a certificate authority Cloudflare uses for
    Advanced Certificates: `letsencrypt.org`, `pki.goog; cansignhttpexchanges=yes` or
    `ssl.com`.
  - Terraform then adds its own CAA records for those, next to the club's, and owns only
    those. If the zone has no CAA records, Terraform adds none.
- **API token.** The provider docs list only Workers Scripts permissions for the custom
  domain resource, so the deploy token should need no DNS rights (checked in the PR).
  Terraform-owned CAA records would need Zone DNS Edit, limited to this one zone. Cloudflare's
  docs show tokens limited to one zone, but not to particular records. A token like that could
  edit any record in the zone, so it's added only if CAA records are really needed.
- **In the same PR, and by the owner at the same time:** the owner changes the GitHub
  variable `SITE_HOSTNAME` to `pastimeathleticclub.org`. The Turnstile widget (the
  alarm-mode challenge and the inquiry form) works only on that one hostname, and the
  deploy's smoke test uses it. That PR may move this setting into the club's settings file.

**After deploying, check:**

- every public page, What's On, and a test inquiry, which arrives in the club inbox;
- member login, booking and cancelling;
- the admin and editor pages, the security headers, and the alarm page;
- a few old Weebly addresses, which redirect.

**Then:**

- Turn off the workers.dev address in Terraform, so there's only one way in. Anyone logged
  in on the workers.dev address logs in again, because cookies belong to one address.
- **Rollback,** while step 7 hasn't happened: the owner removes the custom domains and puts
  the Weebly records back from the step 1 list. Weebly is still paid for and running until
  then.

### Step 7: retire the old services (after a settling period agreed with the club)

Wait a few weeks after step 6, with the club's OK. Then:

- **Weebly:** cancel the club's plan. The domain stays registered at the registrar, which
  is separate. In the dashboard, delete the catch-all record that pointed to Weebly, and
  any other Weebly records.
- **Blogger:**
  - Posts worth keeping move into the History page (or a news page) first.
  - If the blog sits on a club subdomain, that subdomain redirects to the new site.
  - Otherwise, a last post points readers to the new site.
  - Whether the blog is then deleted or kept private is the club's call.
- **Google Calendar:**
  - Its upcoming events are already in What's On.
  - Anyone who subscribed is told about the new calendar, or feed if there is one.
  - Then the calendar is deleted, or kept with a note that it has moved.
  - Old pages that embedded it are gone with Weebly.
- The club's Google email stays as it is.

### Step 8 (optional, after launch): email authentication for the club's Google email

These records help receiving mail servers tell real club email from fakes. They're for the
club's own Google email on the bare domain. The site's inquiry email has its own records on
the sending subdomain (step 6). They're the club's records, so the owner adds them in the
Cloudflare dashboard, not Terraform.

Do this only after step 5 has passed, in the order below. After each record, send a test
email from a club address **to an address outside the club** and read its
`Authentication-Results` header. Google notes that you can't check DKIM by sending a message
to yourself.

1. **SPF**: a TXT record on the bare domain (name `@`). It lists who may send mail as the
   club. Nothing changes in Google Admin.
   - First list every sender from step 0, question 5: Google, plus any newsletter tool or
     form service that sends *as* a club address. Then write **one** SPF record for the
     domain that names them all, with an `include:` for each sender (Google allows up to 10).
   - If only Google sends, Google's value is `v=spf1 include:_spf.google.com ~all`.
   - Google recommends `~all` (mail from unlisted servers is marked as spam, not refused).
   - It can take up to 48 hours to start working.
2. **DKIM**: a TXT record that Google generates.
   - In the Google Admin console, go to Apps → Google Workspace → Gmail → **Authenticate
     email**. Pick the domain and choose **Generate new record**.
   - Choose 2048-bit and keep the default prefix, `google`.
   - Add the TXT record in Cloudflare with exactly the name (`google._domainkey`) and the
     value (`v=DKIM1; k=rsa; p=...`) that Google shows. If Cloudflare won't take the long
     value, Google's DKIM troubleshooting page covers TXT length limits, and 1024-bit is
     Google's fallback.
   - Check it with `dig +short TXT google._domainkey.pastimeathleticclub.org`. Then return to
     Google Admin and click **Start authentication**.
   - It can take up to 48 hours to start working. The test email's header then shows
     `dkim=pass`.
3. **DMARC**: a TXT record at `_dmarc`. Add it only once SPF and DKIM have been passing for
   **at least 48 hours** (Google's rule).
   - Start with `p=none`, as Google recommends: mail is delivered as before, and receivers
     send reports. For example: `v=DMARC1; p=none; pct=100; rua=mailto:<reports mailbox>`.
   - Google recommends always including `rua=`, sent to a dedicated mailbox or group, not a
     person's own inbox. A report service works too: Cloudflare's DMARC Management is
     available on all plans with Cloudflare DNS, and it shows which senders pass SPF and
     DKIM. If you use it, follow its own setup screen for the report address.

Watch the reports for a few weeks. Google's advice is to move "over time" to `quarantine`
(or `reject`). When to do that is a separate decision for the owner, once every real sender
passes.

## 3. Sources

| Fact | Source |
|---|---|
| A custom domain needs an active zone; Cloudflare creates the record and certificate; no custom domain on a hostname with an existing CNAME; it creates an Advanced Certificate | developers.cloudflare.com/workers/configuration/routing/custom-domains/ |
| CNAME (partial) setup is Business or Enterprise only | developers.cloudflare.com/dns/zone-setups/partial-setup/ |
| Subdomain setup is Enterprise only | developers.cloudflare.com/dns/zone-setups/subdomain-setup/ |
| Full setup steps; the quick scan may miss records; turn off DNSSEC first; nameserver changes take up to 24 hours | developers.cloudflare.com/dns/zone-setups/full-setup/setup/ |
| Wait out the DS TTL before changing nameservers; turning DNSSEC back on | developers.cloudflare.com/dns/dnssec/ |
| Moving with DNSSEC on (multi-signer) | developers.cloudflare.com/dns/dnssec/dnssec-active-migration/ |
| BIND zone file import; the "Proxy imported DNS records" option | developers.cloudflare.com/dns/manage-dns-records/how-to/import-and-export/ |
| Only A, AAAA and CNAME can be proxied; MX and TXT are always DNS only; email records stay DNS only | developers.cloudflare.com/dns/proxy-status/ |
| An exact record beats a wildcard for that name; DNS-only wildcards on all plans | developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/ |
| Cloudflare adds CAA records automatically for Universal SSL, not for Advanced Certificates | developers.cloudflare.com/ssl/edge-certificates/caa-records/ |
| CAA values per certificate authority; which ones issue Advanced Certificates | developers.cloudflare.com/ssl/reference/certificate-authorities/ |
| What SPF, DKIM and DMARC records are; DMARC Management (all plans, with Cloudflare DNS) | developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/, developers.cloudflare.com/dmarc-management/ |
| Google's SPF value; `~all`; up to 10 `include:` tags; up to 48 hours | knowledge.workspace.google.com/admin/security/set-up-spf (was support.google.com/a/answer/33786) |
| DKIM steps in Google Admin; 2048/1024-bit; the `google` prefix; Start authentication; no self-test | knowledge.workspace.google.com/admin/security/set-up-dkim (was support.google.com/a/answer/174124) |
| DMARC: start at `p=none`; `rua=` to a dedicated mailbox; wait 48 hours after SPF/DKIM | knowledge.workspace.google.com/admin/security/set-up-dmarc (was support.google.com/a/answer/2466580) |
| API tokens can be limited to one zone | developers.cloudflare.com/fundamentals/api/get-started/create-token/ |
| Email Sending: a subdomain is its own sending domain with its own MX, SPF, DKIM and DMARC; onboarding the root domain adds MX at the root; needs Cloudflare DNS | developers.cloudflare.com/email-service/configuration/subdomains/, developers.cloudflare.com/email-service/get-started/route-emails/ |
| `cloudflare_workers_custom_domain` (`hostname`, `service`, `zone_id`/`zone_name`; Workers Scripts permissions); `cloudflare_dns_record` | github.com/cloudflare/terraform-provider-cloudflare, `docs/resources/`, v5.29.0 |
