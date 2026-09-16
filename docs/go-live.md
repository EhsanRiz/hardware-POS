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
| 2 | Shop settings: name, VAT, address, receipt footer | not started |
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
