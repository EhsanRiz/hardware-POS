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
| 3 | Staff, PINs and permissions — including the sets nobody has signed in as | **in progress** |
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


## The deploy that said it had happened

Step 2's work shipped, and the smoke check written in step 1 went red on its
first real run. Everything about the *content* was right — the live page named
the build, both assets byte-identical, both service workers matching, the
Worker answering `/api/`. What was wrong was the headers.

Cloudflare's asset server answers any request matching a built file and never
invokes the Worker for it. So a page load gets `public/_headers`, and
`withSecurityHeaders()` in `worker/index.ts` runs only for `/api/`,
`/storage/` and deep links that match no file. **The Content-Security-Policy
written in the Worker had never been in force on a till.** Neither had HSTS.
Nothing noticed, because no suite had ever looked at a live response.

Three things came out of fixing it, in rising order of importance.

**The headers themselves.** `public/_headers` now carries the full set,
matching the Worker's so the two agree whichever path a request takes.
`X-Frame-Options` was `SAMEORIGIN` and is now `DENY` — a till that can be
framed can be clickjacked into taking a payment.

**`Permissions-Policy` said `camera=()`.** That forbids the shop's own page
from opening a lens, and the camera *is* the barcode scanner on a phone and
the viewfinder on the Shelf screen. Safari ignores the header on a top-level
document, which is why an iPhone kept scanning and nobody reported it. An
Android phone would have been refused. It is `camera=(self)` now.

**A customer's quotation could be silently rebuilt.** Turning the policy on
broke two tests, and they were right to break. `createSignedUrl` hands back an
absolute address on the Supabase host, and the browser fetched it directly —
the archived quotation, and the pages of a filed supplier document. When that
fetch fails, the code catches it and rebuilds the quotation *from today's
settings*: a document that looks right and is not the one the customer was
sent. This needed no attacker and no CSP — an ad blocker, an antivirus
web-shield or a mall's Wi-Fi filter would do it, which is exactly the failure
`supabase.ts` was written to avoid for every other request. Signed URLs were
the exception nobody noticed. They go through the till's own origin now
(`ownOrigin`), where the Worker already proxies `/storage/`.

And the durable half: the browser suite ran against `vite preview`, which sets
no headers at all. It runs against `scripts/serve-dist.mjs` now, which applies
`public/_headers` — so all 324 tests execute under the shop's own policy, and
a build that breaks under it fails on a branch instead of at a counter.

Confirmed on the live origin by CI run 216:

    ok   the app's security headers are on the live response
           all four present
    https://till.innovaearth.com is serving this build.

### Still not sending: the nightly digest

Yesterday 04:00 returned **503** — no secret configured. Today 04:00 returned
**403** — a secret configured, and a caller sending something different. So
Supabase has it and the Worker does not; `worker/index.ts` sends
`env.DIGEST_SECRET ?? ""`, which is what a 403 looks like. The push sweep
beside it returned 200 on all 78 calls.

Both sides have to be set from one generated value, in one go, or the two
drift again.

## Shipped is not running

A fix that is deployed is not a fix the counter has, and the gap between them
is however long it takes somebody to press a button.

The till is a PWA registered with `registerType: "prompt"`. It deliberately
does **not** update itself: a till that reloads in the middle of a sale loses
the cart in front of a customer, and only the cashier knows whether this
second is between sales. So it checks for a new version every five minutes —
and on focus, on visibility, and on coming back online — and when one is
waiting it puts **`↻ Update`** in the header and leaves it there.

Until somebody presses it, the counter is running the build it was running
before. This caught us: a PIN fix was merged, deployed, and confirmed on the
live origin by the smoke check, and the shop still had the old behaviour
twenty minutes later because the window had been open since morning.

**To make a till take a new build now:** press `↻ Update` in the top bar. If
it is not showing, bring the window to the front — that triggers a check — or
close and reopen the installed app.

**What this means on install day.** Three separate things have to be true, and
only the first two are visible from here:

| | How it is known |
|---|---|
| The build is deployed | CI's deploy job |
| The live origin serves it | the smoke check, `scripts/smoke.mjs` |
| **The till is running it** | somebody pressed `↻ Update` |

There is no telemetry for the third. When a fix matters — a wrong price, a
refused payment — say so to whoever is at the counter rather than assuming the
shop has it. And when testing a fix, update the device first: otherwise the
bug you are looking at is one that no longer exists.

## Who does what

Three roles exist in the database (`user_role`: admin, manager, employee) and
are shown as Owner, Manager and Counter. Permissions are per person and
**add** to what the role already grants; the role's own are shown ticked and
cannot be unticked.

That is enough for a shop of three and not enough for a shop of eight, so
these are the sets to hire into. Everything below Manager is the `employee`
role with the listed permissions added.

| Preset | Role | Added to the role | Who they are |
|---|---|---|---|
| **Owner** | admin | everything, always | whoever's money it is |
| **Manager** | manager | the role's own set | runs the floor: approves discounts, cashes up, orders |
| **Supervisor** | employee | `approve_discount`, `void_refund`, `manage_customers` | senior hand at the counter — can clear a colleague's discount without fetching the manager |
| **Cashier** | employee | — | the till: `take_payments`, `apply_discount` come with the role |
| **Storeman** | **helper** | `manage_inventory`, `shelf_capture` | receives deliveries, counts stock, photographs shelf items |
| **Driver** | **helper** | — | Deliveries and Look it up need no permission at all |

These are in the app, not only in this document: **Manage → Staff** asks "What
do they do?" above the role, and pressing a job sets the role and ticks its
boxes. Everything below stays editable — a starting point, not a cage. It is
on the manager's phone as well as the till, because a manager hiring somebody
is in the aisle, not at the counter.

Two things worth knowing before these are handed out.

**`view_cost_prices` is deliberately separate from `manage_catalogue`.** A
supervisor can fix a price or a barcode without being shown the shop's
margins. Keep it that way: it is the difference between trusting somebody with
the shelf and trusting them with the business.

**Nobody could be given *less* than a cashier — fixed in 0104/0105.** The
`employee` role carries `take_payments` and `apply_discount`, and the boxes
only add, so a Storeman and a Driver could both ring up a sale. A phone cannot
sell — the database refuses a sale on a personal register — so it needed
physical access to a till, which is not nothing, but it is not what a shop
means when it says "he only does deliveries".

**Helper** starts with nothing at all, so every permission such a person has
is one somebody deliberately ticked. Two migrations rather than one:
`user_role` is a Postgres enum and a new value cannot be USED in the
transaction that adds it — put both in one file and the apply fails with
"unsafe use of new value of enum type".

Worth knowing what was found on the way. `role_default_permissions` read
`when 'admin' … when 'manager' … else array['take_payments','apply_discount']`
— so *anything* that was not admin or manager got the till. A fourth role
added to the enum would have fallen into that `else` and been handed the two
permissions it exists precisely to withhold, silently, with no error anywhere.
Every role is named now and an unknown one gets nothing, which is the safe
direction for a list that will grow again.

## 3. Staff, PINs and permissions — in progress

Every screen so far has been driven as Owner, and `can()` short-circuits for
an admin: **no permission boundary has actually been exercised.** This step is
about the boundaries, not the screens.

On the till, as Owner, Manage → Staff. Add four people (a real mobile number
each — the invitation is an SMS, and a number that does not receive it is a
person who cannot sign in):

| Name | Press this job | What it sets |
|---|---|---|
| a Supervisor | **Supervisor** | Counter, plus approve discounts, void & refund, manage customers |
| a Cashier | **Cashier** | Counter |
| a Storeman | **Storeman** | Helper, plus stock and shelf |
| a Driver | **Driver** | Helper, nothing else |

One press each — the picker sets the role and the boxes. Check the sentence
under the buttons matches the person you mean before you save.

Then, and this is the actual test — **sign in as each of them** on a real
device and check the shop they are shown:

1. **Cashier on the till.** Sells. Manage is not offered at all. A discount
   past their limit parks the sale for approval rather than going through.
2. **Supervisor on the till.** Clears that parked sale. Can refund. Still sees
   no Reports, no Cash-up, no Staff.
3. **Storeman on a phone.** Gets Stock and Shelf on the menu, and neither
   Reports nor Approvals. Can receive a delivery and count stock; is never
   shown a cost price. **And cannot sell** — take a Storeman to a till and
   there should be no way to ring anything up. That is the Helper role, and it
   is the one boundary that did not exist before today.
4. **Driver on a phone.** Gets Deliveries and Look it up, and nothing else.
5. **Manager on a phone.** Approvals arrive; the bell carries them; the parked
   sale from (1) can be approved from the phone without going to the counter.
6. **Somebody else's PIN.** On the Storeman's session, open Manage and enter
   the *manager's* PIN. It must be refused — "That is not your PIN." A manager
   who wants the back office at her till signs in as himself.

What to watch for: a menu row that opens and then refuses is a bug, not a
safeguard — `lib/menu.ts` is supposed to hide what a person cannot do, and the
RPC behind it re-checks anyway. Either half failing is worth knowing.

### What the first run of this step found

Worth reading before running it again, because all four were found in ten
minutes of looking at one real screen, and none of them could have appeared
while everything was driven as Owner — `can()` short-circuits for an admin.

A Helper holding exactly `manage_inventory` and `shelf_capture` was stored
correctly and the server refused everything it should. **The permission model
was never wrong. Four separate screens were**, and two of them disagreed with
each other.

- **She landed on the Sell screen.** `take_payments` is not hers and the
  tender button refuses, so she could scan a whole basket together and find
  that out at the end. A non-seller starts on Deliveries now, with the Sell tab
  shut the way Quotes and Accounts already were.
- **She was offered a Manage button into an empty room.** It asked for
  `manage_catalogue OR manage_inventory OR shelf_capture`, but
  `manage_inventory` opens nothing in Manage — the Stock room is a screen on
  the till — and the Shelf tab needs a lens the counter machine has not got.
  Two lists that could disagree, and did. There is one now
  (`lib/menu.ts`, `backOfficeTabs`): the tabs are drawn from it and the button
  is whether it is empty.
- **An empty tab list fell through to the catalogue.** `?? "catalogue"` handed
  her a catalogue with a **New product** button, every count reading nought
  because the server refused each call with her PIN. Gone; an empty back
  office says so in words.
- **The back office took anybody's PIN.** The modal said "Enter your PIN" and
  did not check whose it was: it proved the PIN with a call the *signed-in*
  person was entitled to make, then carried that PIN into every call inside.
  A storeman who knew the manager's PIN got the manager's back office on her
  own session — her screen, his authority — and with the catalogue fallback
  above, a New product button that would have worked. It is checked against
  the signed-in person now, online and off.

The lesson for the rest of this rehearsal: **the database holding the line is
not the same as the screen being right.** Every one of these showed a door
that the server would have slammed. Sign in as each person and look at what
they are offered, not only at what happens when they try it.

## What "slow" turned out to be

Reported from the counter before step 3 was finished: the till takes its time
loading parked sales and quotations. The shop was on a poor line at the time,
which is most of the answer — but not the interesting part of it.

**The queries are not slow.** `pos_parked_sales` against production, with the
shop's real rows, plans on `parked_sales_org_idx` and executes in **0.333 ms**.
Nothing in the database is worth tuning. The performance advisor's 49
unindexed foreign keys are all INFO and all on tables of a few dozen rows;
they will matter at a hundred thousand sales and do not matter now.

**The database is in `eu-west-1`.** Ireland to Ladybrand is about 170 ms of
round trip before the server does any work at all. That is a fixed toll on
every request, paid again for every request a screen makes in sequence.

**And two screens paid it twice, with nothing on the screen meanwhile.** Every
other list the counter opens — the catalogue, the customers, the deliveries,
this till's own parked sales — draws from `localStorage` first and refreshes
behind it. Quotes did not, and neither did the shop's shared parked list. So
opening Quotes was a blank table until a round trip returned, and tapping a row
was a second round trip with the panel deliberately blanked
(`setViewLines(null)`). The two screens named from the counter were precisely
the two with no cache. That is not a coincidence and it was not the line.

### What was already right

Worth writing down, because the selling path was never the problem and a
rewrite would have been the wrong answer:

| | |
|---|---|
| Read from disk, refresh behind | catalogue, categories, customers, this till's parked sales, deliveries, stock's catalogue, session, device, notices |
| Queued and synced | sales (offline invoice numbering from reserved blocks, approval codes, sync-exactly-once), deliveries created, deliveries marked off |
| Precached by the service worker | the whole app shell; product photographs CacheFirst for 90 days |
| Covered | 17 browser tests drive the offline paths |

**A cashier at the counter was always fine with the line down. The back
office never was.** Quotes, the shared parked list, Stock, reports, cash-up
and accounts are all online-only; Stock cannot be otherwise without a design
for re-asking the PIN at sync (`HANDOVER.md`).

### Fixed: the two screens that were named

Quotes and the shared parked list now read from disk first, like everything
else. Three things were deliberate about how:

- **The cache is read-only.** A quote is a promise at a price, and a row off
  the disk can be wrong in the one direction that matters — a quote somebody
  else converted or cancelled still reads "open". Recalling, cancelling,
  emailing and building a PDF already went to the server and still do; taking
  up a shared parked sale still calls `unparkSale`, which is what decides
  whether it is still there to take. With the line down the list says in words
  that it is the last one seen, not the shop's current truth.
- **The lines are bounded.** `lib/quoteCache.ts` keeps forty quotes' lines and
  drops the least recently read. localStorage is shared with the catalogue,
  the customers, the queues and the roster, and a cache that grows by one
  entry per quote anybody ever opens is a quota error waiting for a busy day.
  The bound is pure and unit-tested, because a browser test cannot show it.
- **The rules left the screen.** They sit in `lib/quoteCache.ts` for the same
  reason `judge()` sits in `offline.ts`.

Guards broken, each turning its own test red and only its own:

| Break | What went red |
|---|---|
| the quotes list never reads its cache | "the quotes a till saw are still on the screen with the line down" |
| the remembered lines forced to null | "a quote already read opens on its lines" — the panel stuck on `Loading…`, which is the exact fault |
| the shared parked list never reads its cache | "the shop's parked sales are on the till the moment it draws" — the Parked button not even drawn |
| the forty-quote bound removed | three unit assertions on the bound |
| re-read no longer moved to the end | the eviction-order assertions |

The browser tests **reload the page** before they look. Without that the
component's state is still in memory and every one of them would pass with no
cache at all — the trap `CLAUDE.md` names. They reload with the *server*
unreachable and the browser still connected, because the suite blocks the
service worker, so a browser-level offline reload cannot load the app at all.

### Confirmed at the counter

Deployed in CI run 222, the smoke check green on the live origin, and then the
part no check here can see: **somebody pressed `↻ Update` on the real till and
reported that quotes load instantly.** That is the third of the three things —
deployed, served, RUNNING — and it is the only one that has ever needed a
person.

What that confirms is the LIST cache. Three things it does not, each of which
wants thirty seconds at the counter rather than a suite:

- **The lines cache.** Open a quote, close it, open the same one again: the
  lines should be there at once rather than `Loading…`.
- **The shared parked list.** The Parked button should carry its count the
  moment the Sell screen draws, without waiting for a poll.
- **The read-only rule with the line down**, which is the one that matters for
  a shop on a weak line. Pull the network: the quote list stays, says in words
  that it is the last one this till saw, and Recall and Cancel refuse. A quote
  somebody else has since converted still reads "open" in a list off the disk,
  and that refusal is what stops it being promised on twice.

### Not done, and the reason

**The region was not moved.** `eu-west-1` → somewhere nearer would cut ~170 ms
to ~25 ms on every request that does leave the building, including the sync
draining the queue. It is worth doing. It is also not a setting: Supabase binds
a project to its region at the infrastructure level, so it means a new project
— new ref, new URL, new anon key — then a restore into it, re-pointing the
Worker, re-setting every secret, redeploying eleven edge functions, moving the
storage objects, and every till taking a new build. That is not a
night-before-install change. Note also that Supabase's edge-function regions
include no African region at all, so push, the digest and quote-PDF would still
run from Europe even after the database moved.
