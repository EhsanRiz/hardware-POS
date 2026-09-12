# InnovaPOS — architecture

A point of sale for a hardware shop: a tablet at the counter, a phone in the
aisle, and a back office in the browser. This document says how the pieces fit
and why they are cut where they are. `README.md` has the setup and the
operating notes.

## The shape of it

```
 Android tablet / phone / desktop browser
 ┌──────────────────────────────────────────┐
 │  PWA  (React 18 + TypeScript, Vite)      │
 │  offline queue · receipts · TillAI bubble│
 └───────────────┬──────────────┬───────────┘
                 │ /api/*       │ intent://  (RawBT)
                 ▼              ▼
 ┌───────────────────────┐   Bluetooth thermal printer
 │ Cloudflare Worker     │
 │ static assets + proxy │
 └───────────┬───────────┘
             ▼
 ┌───────────────────────────────────────────────────┐
 │ Supabase                                          │
 │  Postgres: tables + SECURITY DEFINER pos_* RPCs   │
 │  Storage: document pages, product photos, logos   │
 │  Edge functions (Deno): tillai, read-document,    │
 │    quote-pdf, auth, pos-request, pos-approve,     │
 │    error-digest, …                                │
 └───────────────────────────────────────────────────┘
             │ outbound
             ▼
   Gemini (document reading, TillAI) · Resend (email) · BulkSMS (codes)
```

One deployable front end, one database, a thin worker between them. There is
no application server of our own: every rule that matters is a Postgres
function, and every integration that needs a secret is an edge function.

## Front end

- **Stack.** React 18, TypeScript, Vite, Tailwind for the till, hand-written
  CSS (`src/styles/`) for the back office. `vite-plugin-pwa` gives the service
  worker and install prompt. Two runtime dependencies beyond React:
  `@supabase/supabase-js` and `@zxing/library` (camera barcode scanning).
- **Screens.** `src/pages/POS.tsx` is the till. `src/components/Admin.tsx` is
  the back office ("Manage"), a tabbed shell over `src/components/admin/*`:
  catalogue, bulk import, shelf capture, sales history, suppliers, buying
  (purchase orders), approvals, cash-up, reports, TillAI log, staff, shop
  settings. Accounts, quotes, deliveries and stock takes have their own
  folders. A phone gets a reduced home (`PhoneHome.tsx`): look-up, shelf
  capture, TillAI, and Manage behind a PIN, but never money.
- **API layer.** `src/lib/api.ts` (till) and `src/lib/adminApi.ts` (back
  office) are the only places that call `supabase.rpc`. Components never
  build queries. Each function maps one to one onto a `pos_*` RPC.
- **Documents.** Quotes, invoices, delivery notes, statements and purchase
  orders share one model (`src/lib/sheet.ts`): a `Sheet` is rendered to the
  screen (`DocumentSheet.tsx`), to PDF (`src/lib/pdf.ts`, no library), to
  plain text for email, and to the thermal receipt format (`src/lib/print.ts`).
- **Offline.** The till keeps the catalogue in a local cache and queues sales
  taken during an outage. Each sale carries a `client_ref` idempotency key, so
  a replay hours later posts exactly once. `src/lib/offline.ts` decides what
  "offline" means (a failed request is not proof; the server is probed).
- **Errors.** Every unexpected failure is classified (`src/lib/errorRules.ts`)
  and reported to the server; a nightly digest emails what went wrong on
  which till, in words a shop owner can act on.

## Identity: two credentials, on purpose

- A **register token** identifies a device. A manager pairs a tablet or phone
  once; the device holds a random token and sends it as `p_register_token` on
  every call. A lost device is one token revoked.
- A **PIN** identifies a person. It is entered for signing in and for anything
  sensitive (discounts, voids, pairing, the back office) and is checked
  server-side on every such call. It is held in memory for the session and is
  never written to the device or logged.

RPCs come in two flavours and the naming makes it visible: token-only
functions take `(p_register_token, …)`; person-checked ones take
`(p_register_token, p_pin, …)` and go through `user_with_perm(token, pin,
permission)`. This split is what makes the offline queue safe: a queued sale
needs no PIN to replay.

Multi-tenancy is by `org_id` on every row, resolved from the register token
inside each function. A device cannot name an org; it can only be one.

## Database

- **Postgres on Supabase**, 84 numbered migrations in `supabase/migrations/`,
  applied in order. Nothing is changed by hand in a way the migrations do not
  reproduce; a fingerprint script compares a fresh build against production.
- **Access model.** The anon key ships in the app, so the tables are not
  readable through it. Everything goes through `SECURITY DEFINER` functions
  prefixed `pos_`, granted to `anon`/`authenticated`; helpers and operator
  functions (`innova_*`: create, reset, delete a shop, approve a request) are
  revoked from every API role and run from the SQL editor only. Cost prices,
  bank details and PIN hashes never leave the server except to a permitted
  person.
- **Design points that matter for a hardware shop.** Decimal quantities
  (`numeric(14,3)`) with per-unit `allows_fraction`; retail and trade price
  lists; VAT rate and amount stored per line so an old invoice reprints what
  was charged; sequential `doc_number`s from a sequence; a `stock_movements`
  audit table behind every quantity; `cost_at_sale` on each line so margin
  survives a cost change; trigram search over a normalised `search_text`.
- **Domains.** Products and units; sales, lines, payments, returns and
  cancellations; customers with credit accounts, statements and payments;
  quotes and deliveries; suppliers, filed documents (scanned pages read into
  lines), purchase orders and receiving; cash sessions and cash-up; staff,
  permissions and enrolment; shop settings and branding; error reports and
  TillAI conversation log.

## Edge functions (Deno)

Each holds a secret the browser must not, or does work the database cannot.

| Function | Job |
|---|---|
| `tillai` | The assistant. Takes a question, calls read-only tools that wrap the same token-only RPCs the till uses, answers with a line saying what was looked at. Tools declare an allowlist of columns; the person's own permissions bound what it may see. |
| `read-document` / `supplier-document` | Reads a photographed or uploaded supplier document (quote, invoice, delivery note) into lines with a vision model. |
| `quote-pdf`, `product-image`, `shop-logo` | Files and images through Storage. |
| `auth` | Phone-number sign-in for staff: one-time codes by SMS, numbers normalised to E.164 for South Africa and Lesotho. |
| `pos-request`, `pos-approve` | The public "get InnovaPOS for my shop" form and the one-click approval that creates the shop and invites its manager. |
| `error-digest` | Nightly summary of till errors, by email, on a Worker cron. |

Outbound services: Gemini for reading and TillAI, Resend for email, BulkSMS
for codes. Every key lives in Supabase secrets; none in the client.

## Worker and deployment

`worker/index.ts` is a Cloudflare Worker that serves the built PWA and
proxies `/api/*` to Supabase, so the app has a single origin and the Supabase
host is not a browser-visible dependency. Cloudflare's git integration builds
and deploys `main` on merge. A cron trigger on the same Worker calls the
nightly digest. A separate Worker serves the marketing landing page.

`public/_headers` sets caching; the service worker file is never cached, since
that is what decides when a tablet picks up a new build.

## Printing

Receipts go to a Bluetooth thermal printer through the RawBT Android app,
invoked by intent URL; a desktop browser gets a printable preview instead. The
layout is plain monospace text, width parameterised for 58 mm or 80 mm paper.
A4 documents (quotes, invoices, purchase orders) print through the browser or
save as PDF.

## Testing

Three suites, each covering what the others cannot:

- **Unit** (`test/*.test.mjs`, plain Node): pure rules with money in them —
  rounding, discount limits, receipt layout, PDF layout, phone numbers, the
  worker's routing, TillAI's tool allowlist, error classification.
- **Database** (`supabase/test/schema.test.sql`): applies every migration to a
  throwaway Postgres and calls the RPCs as the client does, including the
  refusals (wrong PIN, wrong org, wrong permission, stranger's token).
- **End to end** (`e2e/till.spec.ts`, Playwright, ~200 tests): drives the
  built app in a browser against a hand-written fake of the server
  (`e2e/fake-backend.ts`), so it needs no credentials and gates every pull
  request. It exercises the same path a cashier does: the click, the render,
  the request, the printed slip.

The working agreement (`CLAUDE.md`) is that every behaviour change ships with
an end-to-end test, every RPC change with a database test, and that each new
test is seen to fail against deliberately broken code before it counts.

## What it is not

- No application server, no ORM, no state library. The database is the
  server; React state is local to a screen.
- No row-level security policies as the primary boundary: tables are not
  exposed, functions are. RLS would be a second line, not the first.
- One shop per organisation for now; branches are a later step.
