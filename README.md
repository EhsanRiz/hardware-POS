# Hardware POS

A point-of-sale for a hardware / building-supply shop, built to run on an
Android tablet behind the counter. It's a **PWA** (installable web app) that
talks to a **Supabase** (Postgres) backend and hands receipt printing off to
the **RawBT** Android app over Bluetooth.

> **Status: the till works end to end. The back office does not exist yet.**
>
> A cashier can pair the tablet, sign in, scan or search, sell fractional
> quantities, take cash/card/account/split payment and print a tax invoice —
> online or through an outage. What is missing is everything a manager does:
> product and price admin, staff, goods receiving, reports and cash-up. Those
> screens were inherited from the cafe, targeted the old data model, and were
> removed rather than patched. See *Still to build*.

## What is carried over

The client-side plumbing from the cafe build, kept because it is proven in
production and expensive to rewrite. All of it still needs rewiring to the new
backend:

- **Offline-first write queue** — the till keeps selling with no connectivity;
  writes queue on the device and sync when the link returns. The new schema's
  `client_ref` idempotency key is wired for exactly this.
- **ESC/POS receipt printing** via RawBT over Bluetooth, with a desktop preview
  fallback so layout can be checked without hardware.
- **PIN auth pattern** — bcrypt hashes, verified server-side, never in the client.
- **RBAC** — roles plus per-user grants, enforced in the database rather than
  hidden in the UI.

## Schema

Six migrations, applied and verified against a live project. The design points
that matter, each one a thing the cafe build got wrong for this trade:

| Decision | Why |
|---|---|
| `qty numeric(14,3)` | 2.5 m of chain, 0.75 kg of loose nails |
| `units_of_measure.allows_fraction` | 2.5 m is a sale; 2.5 padlocks is a typo, and the till rejects it |
| `sku` + unique `barcode` | Thousands of lines, found by scanning, not by photo |
| `price_retail` + `price_trade` | Contractors price off a different list automatically |
| `tax_rate` + `tax_amount` stored per line | Reprinting a 2-year-old invoice restates what was *charged* |
| `doc_number` from a sequence | SARS wants sequential tax invoice numbers |
| `stock_movements` audit table | Answers "why does it think we have nine?" |
| `cost_at_sale` on each line | Margin reporting survives a cost change |
| `client_ref` idempotency key | A replayed offline sale cannot double-charge |
| Normalised `search_text` + trigram index | "concrete nail 2.5x5" reaches "Nail Concrete 2.5 x 50mm" |

`npm run test:e2e` drives the built app in a browser with the Supabase calls
intercepted (`e2e/`), so it needs no credentials or connectivity and can gate a
pull request. It covers the journeys that would cost a shop money if they broke:
scanning, decimal quantities, whole-unit refusal, a cash sale, a server refusal
reaching the cashier, and a sale taken offline syncing exactly once.

`npm run test:db` applies every migration to a throwaway Postgres and calls the
RPCs as the client calls them (`supabase/test/`). The browser suite drives a
hand-written fake of the server, which is a second implementation of the same
rules — and a second implementation agrees with the first right up until it
doesn't, so this runs the real SQL.

### Keeping the migrations honest

The repository and the live database are two accounts of one schema, and they
have drifted before: the database gained migrations the repo never recorded, so
a build from these files was *close* to production without equalling it — near
enough to look right, different enough to be wrong where nobody was looking. It
cost a false alarm about every EFT sale failing, and left the search RPC
described here differing from the one actually serving customers.

`supabase/test/fingerprint.sql` is how that is checked. Run it against a fresh
build and against the live database, and diff:

```sh
npm run test:db                     # build from the migrations
psql -d pos_test -tA -f supabase/test/fingerprint.sql > /tmp/repo.txt
psql "$PROD_URL" -tA -f supabase/test/fingerprint.sql > /tmp/live.txt
diff /tmp/repo.txt /tmp/live.txt    # silence means they agree
```

It compares columns, enums, constraints, indexes, function signatures, function
bodies, RLS and grants. Bodies are hashed with comments and whitespace stripped,
because a diff that shouts about indentation is a diff nobody reads. Worth
running after anything is applied to production by hand.

Verified end to end on the live project: a mixed basket (2.5 m chain + 0.75 kg
nails + 3 bags cement) prices to R464.00 with R60.52 VAT; fractional "each" is
rejected; overselling is rejected; an employee discount parks for approval
without burning an invoice number; a replayed `client_ref` returns the original
sale; trade customers get trade prices; the credit limit holds; and voiding
returns stock with a logged reason.

## Finding a product

A hardware shop's own name for something is rarely the customer's words: the
shelf says *Nail Concrete 2.5 x 50mm*, the customer asks for a *concrete nail
2.5x5*. Search handles that in three deterministic steps before any model is
involved:

- **Word order** — each word is matched independently, so "concrete nail" finds
  "Nail Concrete". All words must match, so it doesn't return every nail.
- **Size notation** — `2,5 x 50`, `2.5x50`, `2.5X50mm` and `2.5*50` all
  normalise to one form, on both the query and the product text.
- **Typos** — a second pass on edit distance runs only when the first finds
  nothing, so "conrete nial" still lands on concrete nails without loosening
  ordinary searches.

Scanning goes through the same box: a barcode scanner is a keyboard that
presses Enter, and an exact code rings straight through.

The server does this better (whole catalogue, real trigram indexes) and is used
when online. `src/lib/search.ts` mirrors the same rules on the device so search
keeps working during an outage — the two are covered by the same cases in
`npm test`, because if they drift the same query behaves differently offline.

**Not yet built:** semantic search — "something to fix wood to a brick wall".
That needs embeddings and is genuinely the part where a model earns its place.

## Still to build

Removed from the cafe build because they targeted the old data model, and to be
rebuilt against this schema:

- **Goods receiving** — suppliers exist in the schema; purchase orders and GRVs do not
- **Reorder report** — the reorder level is on every product and the till warns
  at it; a list of what to order is not yet a screen
- **Semantic search** — embeddings over the catalogue, for intent rather than
  words. The deterministic layer above is the fallback it degrades to.
- **Login rate limiting** — see *Known security tradeoffs*

Since built, and no longer on that list: staff admin (Manage → Staff),
quotes as stored documents (Manage → Quotes), the cash-up (Manage → Cash-up:
float, pay-ins and pay-outs, the count against expected, the card machine and
EFTs against the till, banking and tomorrow's float), and reports (Manage →
Reports: the whole shop's day close across every till, sales by department
with margin from `cost_at_sale`, output VAT by month, and a CSV export of
every line sold).

Catalogue admin is now in place: **Manage** on the till (PIN-gated) edits
products, prices, units, barcodes and departments, adjusts stock through a
recorded movement, and takes a pasted CSV price list.

## Architecture

```
Android tablet ──► PWA (React/Vite) ──► Supabase Postgres
                        │
                        └──► RawBT app ──► Bluetooth thermal printer
```

Sensitive operations go through Postgres `SECURITY DEFINER` functions, so PIN
hashes and totals never travel over the public anon key.

### Two credentials, on purpose

- A **register token** authenticates the till. A manager pairs the tablet once
  and it holds a random token (`src/lib/device.ts`). This is what makes the
  offline queue safe: a sale taken during an outage is replayed hours later
  with nobody present, so it cannot depend on anyone's PIN — and the device
  never stores a PIN it could replay one with.
- A **PIN** authenticates a person, and is required for approving a discount,
  voiding a sale, and pairing or revoking a till.

The cafe build had no equivalent: it accepted a client-supplied `cashier_id`
with no credential, so the anon key alone was enough to post a sale as anyone.
Losing a tablet here means revoking one token, not rotating every staff PIN.

## Setup

### 1. Backend (Supabase)

Apply the migrations in [`supabase/migrations/`](supabase/migrations) in
filename order to a Supabase project of your own. `0005_seed.sql` loads demo
staff and a sample range — replace it with the shop's real price list before
go-live.

### 2. App

```bash
npm install
cp .env.example .env   # fill in the project URL + publishable key
npm run dev            # http://localhost:5173
npm run build          # production build into dist/
```

Node is pinned to 20 via `.nvmrc`.

### 3. Demo logins

Seeded by `0005_seed.sql`: Manager `1234`, Employee `5678`.
**Rotate both before this goes anywhere near a shop floor.**

## Landing page

`landing/` holds the public marketing site for **pos.innovaearth.com** — plain
static HTML/CSS/JS, no build step, deployed separately from the till. Its search
demo runs the same rules as `src/lib/search.ts`, so a visitor can verify the
claim by typing into it. See [`landing/README.md`](landing/README.md).

## TillAI

The bubble in the corner of the till. A counter hand asks in plain words —
"how much cement do we have", "when did Mr Molefe last buy" — and gets an
answer from the shop's own records, with a line saying what was looked at.

It is an intelligent way in to what the till already shows, not the till:

- **It only reads**, through the same token-only RPCs the till calls, so a
  shop's isolation applies to it exactly as it does to the counter. It cannot
  ring up, void, discount or change stock.
- **It sees an allowlist, not a row.** Each tool names the columns the model
  may see; cost prices, bank details and balances never leave the server.
  What it may touch is decided in `supabase/functions/tillai/tools.ts`, which
  is pure and tested by `test/tillai.test.mjs`.
- **It sees what the person can see.** Somebody whose rights open Manage's
  reports or costs has their questions carry the PIN they signed in with, to
  the same PIN-checked RPCs Manage calls: a manager can ask "how much did we
  sell in the past 3 days", and a counter hand's PIN would get "Not
  permitted", exactly as in Manage. The PIN is the session's, held in memory
  only: a reload forgets it, the sheet asks once and keeps it for the rest of
  the sign-in, and it is never stored or logged. A counter hand's questions
  carry no PIN at all.
- **It is on a phone too**, the same bubble in the same corner; the sheet it
  opens is the whole screen, with the same rule and the phone owner's own PIN.
- **Manage → TillAI** shows what the shop asked, newest first, with the
  answer and what was looked at — behind the reports right. A question it
  could not answer is a thing the till does not do yet.
- **It never does sums with money.** It quotes the figures the tools return;
  a report's totals are the report's.
- **It needs the line**, and says so. The till sells without it.

The Gemini key and model are the document reader's (`GEMINI_API_KEY`,
`GEMINI_MODEL`). Questions are logged per shop in `tillai_questions`, which is
also the counter behind a daily cap. Deploy with
`npx supabase functions deploy tillai`.

## What went wrong on a till

A render crash, an uncaught error or an unhandled rejection on a till is
reported to the server (`pos_report_error`, table `client_errors`): kind,
message, stack and the screen it happened on, through the till's token and
nobody's PIN. The line going down is not a bug and is not reported; the same
error within five minutes is one report; with no line the report waits in an
outbox and goes when the line is back. The RPC caps sizes and drops a till's
reports after sixty in an hour. Nothing reads the table through the API.

Every morning at 06:00 (SAST) the till's Worker calls the `error-digest`
function on its cron (`wrangler.toml`, `[triggers]`), which emails InnovaEarth
one line per shop — errors grouped and counted, and how many questions TillAI
was asked — through Resend, from `RESEND_FROM` (an address on innovaearth.com,
which is verified there; the sandbox sender only reaches the account's own
inbox) to `POS_REQUEST_TO`. A quiet night sends nothing,
and the function refuses to send twice within twenty hours whoever calls it.
Deploy with `npx supabase functions deploy error-digest`.

## Buying: orders as documents

Every order on Buying → Orders has Print, PDF and Email in front of it. The
document is the shop's own paper addressed to the supplier (`orderSheet`,
lines ex VAT, VAT at the shop's rate); Email opens to the supplier's address
on file, and emailing a draft marks it as with the supplier. A called-off
order stays on the list, crossed out (`tr.is-called-off`); one that never
went to the supplier can be deleted (`pos_po_delete`), one that did stays on
the record.

The till's calculator floats over the cart and can be dragged by its title
bar to wherever it is least in the way; it stays there until the page
reloads. On Reports → Suppliers each row is the supplier: clicking it opens
the supplier's page under Suppliers (`pos_purchases_by_supplier` carries
`supplier_id` since 0084).

A supplier document filed without being read — the reading failed, or it was
filed by hand — has "Read this document" on it: the filed pages go to the
reader and the reading lands on the same document
(`pos_purchasing_read_filed_document`). The kind the person chose stands.

## Approving a request

The request form emails InnovaEarth with an **Approve** button. One click
(`supabase/functions/pos-approve`, calling `innova_approve_request`) makes the
shop, invites the contact as its manager on the number they gave (read as
E.164 by their country), marks the request approved, and emails them how to
enrol and pair a till. A second click says the shop is already set up and
makes nothing. A number that cannot be read, or that already belongs to
somebody, is refused with words; the email's SQL line is the fallback.
Deploy with `npx supabase functions deploy pos-approve --no-verify-jwt`.

## Wiping a shop, or deleting it

A shop that was used for testing must start its books at invoice number 1
on the day the real owner takes it on. Two operator functions, run from the
Supabase SQL editor like `innova_create_org` and revoked from every API role:

```sql
-- Wipe the books, unpair every device, remove every person, restart the
-- document numbers, keep the catalogue (stock set to nothing), and invite
-- the real manager by phone. The name must match the id or nothing happens.
select innova_reset_org('<org id>', '5 Star Hardware', 'Owner Name', '+27…');

-- The same, then the catalogue and the shop itself.
select innova_delete_org('<org id>', '5 Star Hardware');
```

Storage files (product photos, scanned supplier documents) are not touched;
delete those from the dashboard if they matter.

## Deploying (Cloudflare Workers)

The till deploys as its own Worker, `hardware-pos`, served at
**till.innovaearth.com** (its old address, app.innovaearth.com, still answers
and sends a typed visit on to the new one; a till paired on the old address
keeps working until it is re-paired):

```bash
npm run build
npx wrangler deploy
```

Then attach the hostname: **Workers & Pages → hardware-pos → Settings →
Domains & Routes → Add custom domain → till.innovaearth.com**. The
`innovaearth.com` zone is already in the account, so DNS and the certificate are
handled for you.

`public/_headers` carries the cache rules. The important one is `sw.js`, which
must never be cached: the service worker is what decides when a tablet takes an
update, so a cached copy can leave a till running an old build indefinitely —
including one with a bug you have already fixed.

SPA fallback comes from `not_found_handling` in `wrangler.toml`, so the
Pages-era `public/_redirects` is gone.

Unlike the cafe build, **this repo does not commit `.env.production`** — set
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and the printer settings as Worker
environment variables (or a `.env` at build time) instead.

The public marketing page is a *separate* Worker at **pos.innovaearth.com** —
see [`landing/`](landing/). A page that sells the product and a till that shops
depend on should not share a deploy.

## Branding

- **Screen logo** — drop the shop logo at `public/logo.png`; it appears on the
  login screen and the till header, falling back to the shop name if absent.
- **Receipt logo** — `src/lib/logoRaster.ts` is intentionally empty. Add a
  base64 ESC/POS raster there to print a logo on every slip.
- **PWA icons** — `public/icon-*.png` are still the cafe's placeholders and
  should be replaced.

## Printing (RawBT)

The tablet needs the free **RawBT Print Service** app installed once and paired
with the Bluetooth printer. The PWA invokes it via its intent URL scheme. On a
desktop browser the app falls back to a printable preview window, so receipt
layout can be checked without hardware.

Receipt layout lives in `src/lib/receipt.ts` — plain monospace text, width
parameterised by `VITE_RECEIPT_WIDTH` (32 for 58mm paper, 48 for 80mm).

## Known security tradeoffs

Inherited from the cafe build, and **more serious here** — a hardware shop has
a bigger float, higher-value stock and customers on credit:

- The anon key ships in the PWA and can call `pos_login`, so **PINs are
  brute-forceable over the public API**. There is no rate limiting or lockout.
  Add this before go-live — it is the one inherited weakness still open.
- Fixed in `0006`: internal helpers (notably `user_by_pin`, which returns
  `pin_hash`) were reachable over PostgREST with just the anon key. Only the
  `pos_*` entry points are callable from the device now, and `products.cost` is
  withheld at the grant level.

## Provenance

The client plumbing — offline write queue, ESC/POS printing, PIN auth pattern,
RBAC — is carried over from `EhsanRiz/coffee-shop-pos` (`b4763f4`), which is
proven in production and expensive to rewrite.

The database is **not** carried over. The cafe's 26 migrations were discarded
and the schema rebuilt from scratch for this trade, because its problems were
structural: integer quantities, no SKU or unit of measure, VAT computed at
print time, and invoice numbers that were truncated UUIDs.

Cafe features still present in the UI (tips, table/tab open orders, "menu"
vocabulary) come out during the client rework.
