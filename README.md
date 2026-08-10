# Hardware POS

A point-of-sale for a hardware / building-supply shop, built to run on an
Android tablet behind the counter. It's a **PWA** (installable web app) that
talks to a **Supabase** (Postgres) backend and hands receipt printing off to
the **RawBT** Android app over Bluetooth.

> **Status: hardware schema built and verified; the app UI has not caught up yet.**
>
> The database is a clean hardware-first design — not the cafe's schema with
> patches. It is deployed and tested (see *Schema* below). The React client is
> still the cafe's and calls RPCs that no longer exist, so **the app will not
> run against this backend yet.** Reworking the client is the next phase.
> See [`docs/PLAN.md`](docs/PLAN.md).

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

Verified end to end on the live project: a mixed basket (2.5 m chain + 0.75 kg
nails + 3 bags cement) prices to R464.00 with R60.52 VAT; fractional "each" is
rejected; overselling is rejected; an employee discount parks for approval
without burning an invoice number; a replayed `client_ref` returns the original
sale; trade customers get trade prices; the credit limit holds; and voiding
returns stock with a logged reason.

## Still to build

- **Client rework** — the UI still speaks the cafe's RPC vocabulary
- **Goods receiving** — suppliers exist; purchase orders and GRVs do not
- **Quotes** — builders expect a price on paper
- **Cash-up** — tables reserved (`session_id`), logic not yet ported
- **Reports** — sales, margin, reorder
- **Login rate limiting** — see *Known security tradeoffs*

## Architecture

```
Android tablet ──► PWA (React/Vite) ──► Supabase Postgres
                        │
                        └──► RawBT app ──► Bluetooth thermal printer
```

Sensitive operations go through Postgres `SECURITY DEFINER` functions, so PIN
hashes and totals never travel over the public anon key. Only `products` is
directly readable with the anon key; `app_users`, `sales` and `sale_items` have
RLS enabled with no policies and are reachable only through those functions.

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

## Deploying (Cloudflare Pages)

Connect the repo to Cloudflare Pages with build command `npm run build` and
output directory `dist`. `public/_redirects` provides the SPA fallback.

Unlike the cafe build, **this repo does not commit `.env.production`** — set
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and the shop details as
environment variables in the Cloudflare dashboard instead. (If you prefer the
cafe's simpler committed-config approach, re-add `!.env.production` to
`.gitignore`.)

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
