# Hardware POS — assessment & plan

Assessment of the coffee-shop POS this repo was forked from
(`EhsanRiz/coffee-shop-pos`, branch `claude/laughing-euler-d7r2gc`, commit
`b4763f4` — 84 commits, 26 migrations), and the plan for turning it into a POS
for a hardware / building-supply shop in Ladybrand, Free State.

**Verdict: fork it, don't rewrite it, and don't try to serve both shops from one
codebase.** Roughly 70% of what was built is vertical-neutral infrastructure
that would take months to rebuild. The remaining 30% is coffee-shop-shaped in
ways that go deeper than the labels — down to the column types.

Phase 0 (seeding this repo) is done. Phase 1 onward is outstanding.

---

## 1. What transfers as-is

This is the part worth protecting. It is good work and it is not specific to
coffee.

| Capability | Where | Note |
|---|---|---|
| PIN auth, bcrypt hashes, server-side verify | `0001`, `pos_login` | PIN hashes never cross the anon key |
| RBAC — 3 roles + per-user permission grants | `0008`, `src/lib/permissions.ts` | Enforced in the RPCs, not just hidden in UI |
| Offline-first PWA + write queue + idempotent pay | `queue.ts`, `sync.ts`, `0014` | The single most valuable piece for a border town |
| Cash / card / split payments | `0026`, `PaymentModal.tsx` | |
| House accounts w/ credit limits + ledger | `0015`–`0017`, `0023`–`0024` | Contractors on account — hardware needs this on day one |
| Cash-up: float, pay-in/out, over/short variance | `0012`, `0013` | |
| Reports + drill-down + void/refund w/ stock restore | `0006`, `0009` | |
| ESC/POS receipt printing via RawBT | `receipt.ts`, `print.ts` | Width-parameterised, already generalised |
| Product variants (size/option, own price + stock) | `0019`, `0020` | Maps cleanly onto M6 vs M8, 5L vs 20L |

The offline queue and the house-accounts ledger are the two pieces I'd least
want to write from scratch. Both land in hardware retail essentially unchanged.

---

## 2. What actively breaks

These are not cosmetic. Ordered by how much they hurt.

### 2.1 Quantities are integers — blocker

```sql
-- 0001_pos_core_schema.sql:48
qty int not null check (qty > 0),
```

and in every sale RPC:

```sql
v_qty := (v_item->>'qty')::int;
```

A hardware shop sells 2.5 m of chain, 0.75 kg of loose nails, 3.5 m of gutter,
1.2 m of timber. **The system cannot represent any of that.** It is a
`numeric(12,3)` change across `sale_items`, `order_items` and six RPCs
(`0001`, `0004`, `0008`, `0011`, plus the open-order and inventory paths), and
it must happen before anything else is built on top.

### 2.2 No SKU, no barcode

`products` is `name, category, price, cost, image_url, stock_qty, sort_order`.
There is no barcode, no supplier code, no internal SKU.

A cafe has ~40 items and a photo grid is the right UI. A hardware shop has
3,000–10,000 SKUs and the right UI is a barcode scanner and a search box. The
good news: a USB/Bluetooth scanner presents as a keyboard, so this is a cheap
addition — a `barcode` column, an index, and a scan-to-cart handler. The
`ProductGrid` photo-tile UX should become search-first, with tiles kept only
for a small "quick picks" set (cement, common screws).

### 2.3 VAT is computed at print time, not stored

```ts
// receipt.ts:131
out.push(lineItem(`VAT (${VAT_PCT}) incl`, amount(vatOf(sale.subtotal - sale.discount_amount))));
```

`VAT_RATE` comes from `import.meta.env`. Two problems:

- **Historical invoices are not reproducible.** If the rate changes, every past
  invoice reprints at the *new* rate. For a VAT-registered business that is a
  SARS problem, not a display bug.
- Every product is assumed standard-rated. Mostly true for hardware, but the
  rate and VAT amount should still be **persisted per sale line at the time of
  sale**, and the product should carry a tax class.

### 2.4 Invoice numbers are truncated UUIDs

```ts
out.push(`Invoice No: ${sale.id.slice(0, 8)}`);
```

A SARS tax invoice needs a sequential number. Eight hex characters are neither
sequential nor collision-proof. Needs a real Postgres sequence with a prefix,
allocated server-side at completion (and reserved carefully for offline sales —
the offline queue makes this genuinely tricky, so decide the scheme early).

### 2.5 Nothing on the buying side — biggest missing module

Stock goes **down** on sale and **up** only via manual `pos_manager_set_stock`.
There are no suppliers, no purchase orders, no goods-received vouchers, no cost
updates on receipt, no stock valuation, no reorder report.

A cafe can live on manual stock. A hardware shop taking weekly pallets from
several suppliers cannot — this is where the owner's money actually sits, and
it's the module most likely to decide whether they keep using the system.

### 2.6 No quotes

Builders walk in with a list and want a price on paper. Quote → convert to
invoice is table stakes in this trade and is absent entirely.

### 2.7 Wrong country

`.env.production` is a Maseru cafe:

```
VITE_SHOP_NAME=MRM Cafe
VITE_SHOP_ADDRESS=22 Moshoeshoe Rd.|Maseru, Lesotho
VITE_VAT_NUMBER=50002328
VITE_CURRENCY=M
```

Ladybrand is in South Africa — ZAR, SARS, a different VAT number. Worth asking
the client directly whether they accept Maloti at par, as many businesses that
close to the border do; if so that's a real dual-currency requirement on the
cash drawer and cash-up, not just a symbol change.

### 2.8 Cafe features to strip

Tips (`TIP_PERCENTS`, tip lines on the pro-forma bill), open orders as
tables/tabs, and the "menu" vocabulary throughout (`ManageMenu`, `ImportMenu`,
"Search menu…"). Also `public/menu/*` — food and drinks PDFs, QR codes — and
the MRM logo assets in `design/`.

Open orders shouldn't just be deleted, though: the same mechanism, relabelled,
is how you park a builder's order at the counter while they fetch more stock.

### 2.9 Security posture needs raising

Your README's hardening backlog is honest, and its reasoning was sound for a
cafe with one trusted tablet:

- PINs are brute-forceable over the public anon key (no rate limiting).
- The `product-images` bucket accepts anon writes.

A hardware shop changes the risk: bigger float, higher-value stock, multiple
staff, contractor accounts with credit. Add login rate-limiting and a lockout
before go-live, not after.

**Also:** `.env.production` commits the live cafe Supabase project. The new repo
must get a fresh Supabase project and must not inherit that file.

---

## 3. Why fork rather than share a codebase

The tempting option is one codebase with a `VERTICAL=cafe|hardware` flag. I'd
advise against it *for now*. The divergence is structural, not cosmetic —
decimal quantities, goods receiving, quotes, and suppliers on one side; tips,
tables, and menus on the other. You would be maintaining two products behind
feature flags with a sample size of two customers, and every flag would be a
guess about what generalises.

Fork into `hardware-pos`, accept the duplication, and let the two diverge
honestly. If a third and fourth customer arrive, you'll then have real evidence
of what's genuinely common, and extracting a shared core (auth, offline queue,
printing, cash-up) becomes a refactor grounded in facts rather than a
prediction.

---

## 4. Suggested phasing

**Phase 0 — seed the repo.** Copy the tree, strip cafe assets and `.env.production`,
rename the package, new Supabase project, rewrite the README. Half a day.

**Phase 1 — schema foundation.** Decimal quantities; `unit_of_measure` on
products; `barcode` + `sku`; VAT rate and amount persisted per sale line;
sequential invoice numbers. Do all of this before building features on top,
because every one of them is painful to retrofit once there's live sales data.

**Phase 2 — the till.** Barcode-first search, decimal quantity entry on the
keypad, unit-aware display and receipts ("2.5 m @ R45.00/m"), price-check mode.

**Phase 3 — the trade counter.** Quotes with convert-to-invoice; trade vs
walk-in price tiers; contractor accounts (reuse the existing `accounts` ledger —
it's already right).

**Phase 4 — the buying side.** Suppliers, purchase orders, goods-received
vouchers with cost updates, stock valuation, reorder report.

**Phase 5 — hardening.** Login rate-limiting, multi-till sync (currently
explicitly out of scope), stocktake / cycle counts.

Phases 1 and 4 are the two that decide whether this is a real hardware POS or a
cafe till with different labels.

---

## 5. Loose end on the existing repo

PR #1 has never been merged, so `main` on `coffee-shop-pos` is an empty README
and the cafe's entire production system lives on a single unmerged branch.
That's fragile regardless of the hardware project — worth merging.

---

## 6. Open questions for the client

1. How many tills, and does the office need a separate machine? (Multi-till is
   currently out of scope by design.)
2. Do they accept Maloti as well as Rand?
3. Do they need delivery notes? Building supplies often leave the yard
   separately from the sale.
4. Is there an existing accounting package (Sage, Xero, Pastel) this has to
   reconcile with?
5. Roughly how many SKUs, and is there an existing price list to import?
6. Is this a one-off build for this shop, or the first customer of a product
   you intend to resell? It changes how much per-shop configuration is worth
   building now.
