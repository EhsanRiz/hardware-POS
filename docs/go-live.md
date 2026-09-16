# Going live: the rehearsal

A record of what was checked before InnovaPOS was installed in a shop, what
passed, and what was left undone. Written as it happened, so a green line here
means somebody saw it go green.

The browser suite drives the till against a *model* of the server and the
database suite drives the server itself. Neither has ever touched a real
barcode scanner, a real receipt printer, a real iPhone, or a shop's own
catalogue. This document is about the things those suites cannot reach.

The rehearsal shop is **IE Test Shop**, not the client's. Nothing here puts a
fake sale in anybody's real books.

## The steps

| # | What | State |
|---|------|-------|
| 1 | Production is what the migrations say it is | **passed** — 2026-09-16 |
| 2 | Shop settings: name, VAT, address, receipt footer | **passed, with four fixes** — 2026-09-16 |
| 3 | Staff, PINs and permissions — including the sets nobody has signed in as | not started |
| 4 | Devices: till paired, phone paired, both installed as apps | not started |
| 5 | Catalogue: real items, real barcodes, real prices | not started |
| 6 | Opening stock: start tracking, receive, count | not started |
| 7 | The money path: cash, card, account, drawer, printed slip | not started |
| 8 | The awkward ones: discount approval, park, cancel, return, offline | not started |
| 9 | Back office: deliveries, quotes, buying, suppliers, accounts, cash-up, reports | not started |
| 10 | The alarms: bell, push, nightly digest | not started |

## 1. Production is what the migrations say it is — passed

Checked 2026-09-16 against project `krkatpesfwqnjitcxkco`, repository at
`ee1fc0a`.

A schema that has drifted from its migrations makes every test after it a
test of something else. It has drifted here before — the live database once
carried a payment-method change the repository never recorded — so this is
measured rather than assumed.

- **All 100 migrations apply in order to an empty database**, and the database
  suite passes against the result.
- **Production matches a build from the migrations exactly.** Both sides were
  fingerprinted with `supabase/test/fingerprint.sql`, grouped by category:

  | | columns | constraints | enums | indexes | functions | bodies | grants | RLS | policies |
  |---|---|---|---|---|---|---|---|---|---|
  | count | 519 | 198 | 4 | 132 | 178 | 178 | 292 | 47 | 3 |
  | agree | yes | yes | yes | yes | yes | yes | yes | yes | yes |

  Function bodies are compared as hashes with comments and whitespace
  stripped, so formatting differences do not show up as drift. Every category
  hash is identical on both sides.

  The first attempt compared 182 functions against production's 178 and looked
  like drift. It was not: `schema.test.sql` creates four `assert*` helpers in
  `public`, and fingerprinting after running the suite picks them up. The
  comparison above is from a migrations-only build with no test helpers in it.

- **No function has more than one signature.** This is the failure mode
  `CLAUDE.md` calls out twice — a defaulted argument added with `create or
  replace` leaves the old signature standing, and every caller that names no
  optional argument becomes ambiguous and fails outright. Zero rows.
- **CI is green on the commit CI last shipped** (run 214, `ee1fc0a`): types,
  unit, browser and database suites, and a deploy step that exited 0. What
  the till at the counter actually downloads was **not** checked — see below.
- **All 11 edge functions are ACTIVE**, `push` and `error-digest` on their
  latest versions.
- **The push pipeline is running.** 292 calls returned 200 on 15 September —
  the five-minute sweep, all day, without a failure.

### Found: the nightly digest has never sent

One call returned **503** at 04:00:36, which is the digest cron firing and the
function refusing because `DIGEST_SECRET` is not set. It fails closed by
design and says so in the log, which is why this was findable, but it means
the shop's nightly error summary has never once gone out.

Not a blocker for selling. It is the thing that would have told us about a
problem at the counter the next morning, so it should be set before anybody
relies on being told.


### Not checked: that the shop is served what CI built

`CLAUDE.md` says not to describe CI passing as a deploy, and the first version
of this document did exactly that. A `wrangler deploy` that exits 0 is a tool
reporting success, not a till loading a page.

Nothing in any suite here has ever fetched `till.innovaearth.com` and compared
what came back against the build. The browser suite drives a production build
served from localhost against a hand-written fake of the server; it proves the
bundle is correct and proves nothing about whether that bundle is the one on
the counter.

Cloudflare then said so out loud. Setting a Worker secret was refused with
*"the latest version of your Worker isn't currently deployed"* — meaning a
version exists that is not the one being served. The Worker's script as
Cloudflare reports it does match `worker/index.ts`, so the code is current;
but "a version exists that isn't deployed" is precisely the state this
document had assumed away.

This was a gap in the checking, not a known fault. **It is now closed** —
`scripts/smoke.mjs` runs as the last step of the deploy job and fetches the
live origin. Six guards, each a deploy a person would have called successful:

| Guard | The deploy it catches |
|---|---|
| the live page is this build | uploaded a version, serving the old one |
| each `/assets/…` file is byte-for-byte the built one | hashed name right, bytes not — a cache or a half-finished upload |
| `sw.js` is the built file | the service worker keeps a till on last week's app after it says it updated |
| `push-sw.js` is the built file | notifications quietly stop arriving |
| the Worker is answering, not just the assets | files served, `/api/` no longer proxied, every call from the till goes nowhere |
| the security headers are on the live response | the response never went through `withSecurityHeaders` |

An origin that cannot be reached is a red guard rather than a stack trace, and
is retried — a name that has not propagated is not the same as a deploy that
did not land.

It runs *after* the deploy, so it cannot prevent a bad one. What it does is
make the pipeline that claimed to ship say whether it did, rather than leaving
that to the shop.

The checker has no second opinion behind it, so it is exercised before it is
trusted: `npm run test:smoke` stands up a server that answers the way the
Worker does, serving the real `dist/`, and bends it each of those ways in
turn. Every guard was broken by hand and the matching test seen to go red —
and only the matching one; a single fault reports a single fault.


## 2. Shop settings — passed, with four fixes

Done on the till (the Shop tab is hidden on a phone by design, `Admin.tsx:148`).
The VAT number and the four banking fields were blank; both were filled and
both now print. Verified on a real slip and a real quotation: the name, the
`VAT No:` line, the `PAYMENT DETAILS` block and `VAT included` are all on the
paper, and everything typed survived a reload.

**The VAT number was the find.** The rate is not a shop setting — it comes
from a global `tax_rates` table where `standard` is 15%, and every product
defaults to that code. So the till charged VAT and printed the amount, while
the `VAT No:` line is conditional (`receipt.ts:274`) and was simply absent. A
document showing a VAT amount without the supplier's VAT registration number
is not a valid tax invoice. The client is VAT-registered, so filling the field
was the whole fix — but any shop that is *not* registered would need every
product's `tax_code` changed, because there is no per-shop switch. Worth
knowing before the next shop, not during it.

Four things came back from working the screen for real:

- **Save now floats.** It sat at the foot of a page that runs to banking,
  printing, slip width and two blocks of small print, so it was several
  screens below whatever had just been corrected. It is pinned to the bottom
  of the pane now.
- **The send button says "Share" where that is what happens.** On a phone the
  press opens the operating system's share sheet — WhatsApp first, mail some
  way down — and the button said "Email", naming the one route least likely to
  be taken, on the device it is pressed on most. It now asks the device
  (`sendLabel`) and says "Email" only where a mail draft is really what opens.
- **Quotes is on the phone.** "Can you send me that quote again" is asked of
  whoever answers the phone, and the only copy lived on a till behind the
  counter. It arrives without "Open on the till": a phone has no Sell screen to
  open one onto, and a button that refuses is worse than no button.
- **More than one bank account** is still outstanding — see below.

### Done: a shop banks in more than one place

The four banking fields are columns on the organisation, so a shop can record
exactly one account. Real shops keep two or more, and in South Africa listing
the customer's own bank matters: an EFT within a bank clears the same day,
between banks it does not.

Built in 0103. Accounts are rows of their own, each with a switch for whether
it appears on documents. Everything switched on prints, in the order the shop
entered it; an account switched off stays in the settings screen and is never
sent to a till at all, so it cannot be printed by accident. The four columns
were migrated into a first row and then dropped — two places to write the same
fact is how one of them goes stale, and the one that prints would not have been
the one anybody edited.

Done before the shop went live rather than after: moving this data while
somebody is selling on it is the harder version of the same change.

**A bug found by re-reading the diff, not by a test.** Saving sends the list
whole — that is what makes removing a row work — and the screen starts with an
empty list. So anything that leaves it empty when it should not be is an
instruction to delete every account the shop has. Two ways in: a read that
fails, and a read that lands *after* somebody has started typing in a
different field, because the page had one "has this been touched" flag for
everything on it. The accounts now track their own, nothing is offered to edit
until the read has come back, and a save with no read behind it writes
nothing. There is a test for the failing read.
