# Hardware POS

A point-of-sale for a hardware / building-supply shop, built to run on an
Android tablet behind the counter. It's a **PWA** (installable web app) that
talks to a **Supabase** (Postgres) backend and hands receipt printing off to
the **RawBT** Android app over Bluetooth.

> **Status: seeded, not yet a hardware POS.**
> This repo starts as a fork of a working coffee-shop POS, kept for its
> infrastructure (auth, RBAC, offline queue, house accounts, cash-up,
> printing). The retail model is still the cafe's — see
> [`docs/PLAN.md`](docs/PLAN.md) for what has to change and in what order.
> **Do not put this in front of a customer yet.** The blockers in Phase 1 are
> real, and every one of them gets harder to fix once there is live sales data.

## What already works

Inherited from the cafe build and vertical-neutral:

- **PIN login** with bcrypt hashes, verified server-side (never in the client)
- **Roles & permissions** — Admin / Manager / Employee plus per-user permission
  grants, enforced in Postgres `SECURITY DEFINER` functions, not just hidden in
  the UI
- **Offline-first** — the till keeps selling with no connectivity; writes queue
  on the device and sync when the link returns, with idempotent payment so a
  retried sale can't double-charge
- **Payments** — cash (with tendered → change), card, and split cash/card
- **Customer accounts** — house accounts with credit limits and a full
  charge/payment ledger (this is what contractors will run on)
- **Cash-up** — opening float, petty-cash pay-ins/outs, counted drawer with
  over/short variance, plus expected-vs-settled card totals
- **Reports** — today / 7-day / month, top sellers, by-cashier, drill into any
  sale to reprint, void or refund (which restores stock)
- **Stock** — optional per-item quantity that decrements on sale, with low and
  out-of-stock badges
- **Receipt printing** — ESC/POS via RawBT over Bluetooth, with a desktop
  preview fallback

## What is missing for a hardware shop

Summarised here, detailed in [`docs/PLAN.md`](docs/PLAN.md):

| Gap | Why it matters |
|---|---|
| Quantities are integers | Can't sell 2.5 m of chain or 0.75 kg of nails |
| No SKU or barcode | Thousands of SKUs need scanning, not a photo grid |
| No unit of measure | "each" vs "per m" vs "per kg" vs "per bag" |
| VAT computed at print time | Historical invoices reprint at today's rate |
| Invoice number is a truncated UUID | SARS wants a sequential number |
| No suppliers / goods receiving | Stock only ever goes down; no GRV, no cost updates |
| No quotes | Builders expect a price on paper |

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

**Create a new Supabase project** — do not reuse the cafe's. Then apply the
migrations in [`supabase/migrations/`](supabase/migrations) in filename order.

### 2. App

```bash
npm install
cp .env.example .env   # fill in the project URL + publishable key
npm run dev            # http://localhost:5173
npm run build          # production build into dist/
```

Node is pinned to 20 via `.nvmrc`.

### 3. Demo logins

Seeded by `0002_pos_seed_data.sql`: Manager `1234`, Employee `5678`.
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
  Add this before go-live.
- Item-image uploads use the anon key against an anon-writable bucket.

## Provenance

Forked from `EhsanRiz/coffee-shop-pos` (branch `claude/laughing-euler-d7r2gc`)
at commit `b4763f4`. Cafe-specific assets, branding and the live Supabase
config were removed during the fork; cafe *features* (tips, table/tab open
orders, "menu" vocabulary) are still present and are removed in Phase 1.
