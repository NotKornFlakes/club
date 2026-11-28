# Launch: moving pastimeathleticclub.org's DNS to Cloudflare

Status: **plan only. Nothing here has been done.** No DNS, nameserver or registrar changes
happen until the owner says go.

Goal: the booking site goes live at `book.pastimeathleticclub.org`. The Weebly website and
the club's email keep working the whole time.

## 1. Why the DNS has to move

DNS is the internet's address book for the domain. It says where the website lives
(Weebly), where email goes, and so on. Some company runs that address book for the club
today (step 0 confirms which one).

To put the booking site on `book.pastimeathleticclub.org`, Cloudflare must run the whole
address book:

- A Workers custom domain needs "an active Cloudflare zone", meaning the domain is set up
  in Cloudflare.
- Cloudflare can run just one name (`book`) while another company runs the rest, but only on
  paid plans: CNAME ("partial") setup needs Business or Enterprise, and subdomain setup
  needs Enterprise.
- So we use **full setup**: the domain's nameservers point to Cloudflare, and Cloudflare
  answers for every name in the domain. The zone itself can be on the Free plan.

Moving the address book does **not** move the website or the email. Weebly keeps hosting
the site, and the email provider keeps handling mail. We copy every existing entry exactly,
so the copies point to the same places they do now. The only new entry is `book`.

### Who owns what after the move

| Owner | What | Edited where |
|---|---|---|
| **The club** | The zone, and every record that exists today (website, email, any catch-all, anything else). Zone settings and DNSSEC. Any record added later. | Cloudflare dashboard |
| **This project** | The `book` custom domain. CAA records too, but only if they're ever needed (step 6). | Terraform PRs in this repo |

- Terraform never creates, imports or changes the zone or the club's records. It only
  refers to the zone (by its ID or name, which aren't secret).
- **Who edits the club's DNS.** That's the owner, or a club member the owner invites with
  the domain-scoped **Domain DNS** role ("edit DNS settings") on this one domain. Never give
  them an account-wide role, because the same Cloudflare account holds the booking site
  and its member data. Cloudflare's roles page doesn't say exactly what a domain-scoped
  member can see of the account's Workers and databases. So before relying on it, check
  what an invited member actually sees.
- **The one rule for the club's DNS editors:** leave `book` alone. If the club ever adds CAA
  records, tell the owner first (step 6 explains why).

### How the drift check stays out of the club's records

The weekly drift check runs `terraform plan`, which only compares the things Terraform
manages. Records made in the dashboard aren't part of Terraform at all. So the check never
sees them, never reports them as drift, and a deploy never undoes them.

To keep it that way, the custom-domain PR adds a CI check that fails if `infra/` ever:

- declares a `cloudflare_zone` resource, or any zone-wide resource (zone settings, DNSSEC,
  rules), since those belong to the club;
- declares a `cloudflare_dns_record` that isn't a CAA record, since the `book` record comes
  with the custom domain and needs no record of its own;
- uses any Cloudflare resource type outside a short allowed list.

Nobody runs `terraform import` on the club's records.

What the drift check still watches: the `book` custom domain, any CAA records Terraform
owns, and everything it watches today. One gap: the DNS record for `book` is made by
Cloudflare, not by a Terraform resource, so the drift check may not notice if someone
deletes it in the dashboard. The site going down would show it. That's why the club's
editors are told to leave `book` alone.

### What stays the same, and what changes

| Stays the same | Changes |
|---|---|
| Weebly hosts the public site | The domain's nameservers point to Cloudflare |
| The email provider and mailboxes | The club edits DNS in the Cloudflare dashboard instead of at the old DNS host |
| Where the domain is registered and renewed | New name: `book.pastimeathleticclub.org`, owned by this project |

### Who does what

- **Claude:** writes the Terraform PR for `book` and the CI check. Never logs in to the
  registrar or the Cloudflare dashboard. Never changes nameservers, DNSSEC, DNS records, or
  GitHub settings, variables or secrets.
- **Owner:** the registrar (DNSSEC, nameservers), setting up the zone and copying the records
  in the Cloudflare dashboard, inviting any club DNS editor, API token permissions, the
  `SITE_HOSTNAME` GitHub variable, reviewing and merging PRs, and approving deploys.
- **Club:** answers the questions in step 0, and edits its own DNS after the move. Whoever
  edits the Weebly site adds the menu link (step 7).

## 2. The steps

### Step 0: questions to answer first

1. **Registrar.** Where is the domain registered? Who has the login? It should be a club
   account with MFA on, with the login kept in the shared Proton Pass vault (emergency
   access). Anyone with that login can take over the website, the email and the booking
   site.
2. **Can the nameservers be changed there?** If the registrar won't allow it, stop here and
   decide with the club. Moving the registration elsewhere is a separate project.
3. **Current DNS host.** This is often the registrar. It could also be Weebly or another
   company.
4. **Email.** Which provider handles `@pastimeathleticclub.org` mail? Does anything else
   send mail as the club (a newsletter tool, Weebly forms)?
5. **Other names in use**, and what each one is for. Step 1 finds names, but not their
   purpose.
6. **Is DNSSEC on?** The `dig DS` line in step 1 shows it: any answer means it's on.
7. **When to switch.** Pick a quiet time, not just before an event, when someone can send
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
  dig +short CNAME book.$D   # must be empty: no custom domain on a CNAME
  # DKIM: dig +short TXT <selector>._domainkey.$D   (and CNAME, if the provider uses that)
  ```

- Send one test email **to** a club address and one **from** it. In each message's full
  headers, note the `spf=` and `dkim=` results, whatever they are (`pass`, `none`, ...).
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

### Step 6: add `book.pastimeathleticclub.org` (the "custom domain" build PR)

- Terraform PR: `cloudflare_workers_custom_domain` with `hostname =
  "book.pastimeathleticclub.org"`, the Worker as `service`, and the zone's ID or name.
  Cloudflare then creates the DNS record and the certificate itself. Plus the CI check from
  "How the drift check stays out of the club's records".
- **If `book` is covered by a catch-all today:** the record Cloudflare creates for `book`
  takes over that name. Cloudflare: "A wildcard record applies only when no exact record
  exists at the queried name." All other names keep using the catch-all. The custom domains
  page doesn't say anything about adding a custom domain where only a catch-all answers. If
  it refuses, the owner adds a placeholder record for `book` first.
- **`book` must have no CNAME record.** Cloudflare can't add a custom domain there. Step 1's
  last `dig` line checks this.
- **CAA records**, only if the zone has any:
  - The custom domain's certificate is an "Advanced Certificate". Cloudflare adds its own CAA
    entries automatically only for Universal SSL, not for these.
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
- **In the same PR, and by the owner at the same time:**
  - The owner changes the GitHub variable `SITE_HOSTNAME` to `book.pastimeathleticclub.org`.
    The Turnstile widget (the alarm-mode challenge) works only on that one hostname, and the
    deploy's smoke test uses it. (The per-club config PR may already have moved this
    setting into the club's config file.)
  - The booking site's pages link back to `pastimeathleticclub.org`.
- **After deploying:** log in, book, cancel, check the security headers, and check the alarm
  page on the new address.
- **Then** turn off the workers.dev address in Terraform, so there's only one way in. Anyone
  logged in on the workers.dev address logs in again: cookies belong to one address.

### Step 7: the Weebly menu link

Once step 6 passes, whoever edits the Weebly site adds a menu item **Member Booking** that
links to `https://book.pastimeathleticclub.org`.

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
| The "Domain DNS" role; domain-scoped roles | developers.cloudflare.com/fundamentals/manage-members/roles/ |
| API tokens can be limited to one zone | developers.cloudflare.com/fundamentals/api/get-started/create-token/ |
| `cloudflare_workers_custom_domain` (`hostname`, `service`, `zone_id`/`zone_name`; Workers Scripts permissions); `cloudflare_dns_record` | github.com/cloudflare/terraform-provider-cloudflare, `docs/resources/`, v5.29.0 |
