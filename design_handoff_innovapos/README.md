# Handoff: InnovaPOS — brand identity and point-of-sale till

## Overview

InnovaEarth is building a general-purpose point-of-sale product for the South African
market, launching first into hardware and building-material retail. This package covers
the brand identity work and the counter (till) screen design.

The commercial context that shaped these designs:

- **Buyer**: buying-group members — Buco, Mica, Build it. Two audiences in one sale:
  head office buys the system, the store staff use it.
- **Vertical**: hardware and building material — nails, bricks, rebar, cement, cut-to-length
  stock, per-kilogram loose bin stock.
- **Market realities**: 30-day contractor accounts, quotes converting to invoices,
  multi-branch stock lookup, SARS-compliant VAT invoices at 15%, cash-heavy drawers,
  deliveries and collections, trade vs retail pricing, stock takes, and unreliable
  grid power (offline-first operation is not optional).

## About the design files

**The HTML in this bundle is a design reference, not production code.**

`InnovaEarth Brand Directions.dc.html` is a single design document containing nine
turns of exploration, newest first. It is written for a specific streaming design
runtime (a `.dc.html` Design Component with inline styles only) and is **not intended
to be lifted into an application**.

Your task is to **recreate these designs in the target codebase's own environment** —
React, Vue, Svelte, .NET, Flutter, native, whatever the POS is actually being built in —
using that codebase's established component patterns, state management and styling
approach. If no codebase exists yet, choose the framework appropriate to a
desktop-and-tablet till application that must run offline, and implement there.

Read the HTML for exact values. Do not port its structure.

## Fidelity

**High fidelity.** Colors, typography, spacing, and copy are final and should be
matched exactly. The till screen (turn 07) is a static mock — no JavaScript behavior is
implemented in it — but every visual value in it is a decision, not a placeholder.

The one thing that is *not* final: the SVG marks are **hand-drawn sketches**, accurate
in geometry and proportion but not production vector art. They need redrawing in a
vector tool before shipping. See "Assets" below.

---

## Brand architecture

Four tiers. Exactly one drawn mark in the whole system.

| Tier | Name | Role | Where it appears |
| --- | --- | --- | --- |
| 01 House | InnovaEarth | Signs contracts, invoices, careers, paperwork. Category-free, because the POS is the first of several products. No pictorial mark — a ruled wordmark only. | Tax invoices, statements, legal documents, corporate site |
| 02 Product | InnovaPOS | The till. The only tier that owns a drawn mark. | App chrome, app icon, splash, receipt footer |
| 03 Edition | InnovaPOS Hardware / Pharmacy / Hospitality | A vertical badges itself with a hairline rule, one word, and one stroke glyph. Never a new logo. | Marketing, sales collateral, onboarding |
| 04 Siblings | Bin (stock), Book (accounts), Route (deliveries) | Future products under the same house. | Not yet designed beyond marks |

### Architecture rules

1. One drawn mark in the system. The five-bar and scan-frame marks belong to the product; the house is type and a rule.
2. Editions are earned by a word, not a redraw: suffix in the heading face, one stroke glyph, gold.
3. **Never stack three tiers in one lockup.** House and edition do not appear together.
4. Gold is always stroke. The only filled ground in the entire identity is the near-black app-icon tile.

### Naming caveat (flag to the client, not a build task)

"POS" is generic and will not register as a trade mark. Putting the house name inside
the product name also collapses tiers 01 and 02, which is why the "by InnovaEarth"
endorsement line was dropped from the InnovaPOS lockup and replaced with the descriptor
"Point of Sale". The protectable assets are **InnovaEarth** and **the mark itself**.
A CIPC name-register check and a class 9 / class 42 trade-mark search are outstanding.

---

## Design tokens

Taken from the bound "Classical" design system. Every value below is used literally in
the designs; do not substitute.

### Color

| Token | Hex | Use |
| --- | --- | --- |
| `--color-bg` | `#f3f2f2` | Page and panel ground ("paper") |
| `--color-surface` | `#eae9e9` | Recessed surfaces, image mats |
| `--color-text` | `#201f1d` | Body and figures ("ink") |
| `--color-accent` | `#b68235` | The gold. Strokes, rules, borders — never a fill |
| `--color-divider` | `rgba(32,31,29,0.16)` | Every hairline |
| `--color-neutral-200` | `#eae7e7` | |
| `--color-neutral-300` | `#d7d3d3` | Disabled rules |
| `--color-neutral-400` | `#bab6b6` | Muted text **on near-black only** |
| `--color-neutral-700` | `#605d5d` | Muted text on paper. Minimum for readable secondary text |
| `--color-neutral-800` | `#444141` | Body copy in long paragraphs |
| `--color-accent-100` | `#fff3e4` | Tinted row highlight (just-scanned line) |
| `--color-accent-400` | `#e1ad66` | The gold **on dark grounds** — lifted for contrast |
| `--color-accent-700` | `#7d5411` | Accent text at paragraph size; the deeper accent stroke |
| Colophon black | `#16150f` | App-icon tiles, inverted panels, splash. One shade below neutral-900 |
| Row hairline | `rgba(32,31,29,0.09)` | Line-item separators (lighter than a section divider) |
| Dark-ground hairline | `rgba(255,255,255,0.14)` | Rules on `#16150f` |

**Contrast rules, learned the hard way during this project:**

- On paper (`#f3f2f2`), never use `#9b9797` or `#bab6b6` for text a user must read.
  `#605d5d` is the floor for secondary text; `#444141` for body.
- On near-black (`#16150f`), muted text is `#bab6b6`. `#605d5d` fails there.
- The accent `#b68235` on paper clears ~3:1 — enough for icons, large text and interface
  chrome, **not** for body copy. Use `#7d5411` for accent text at paragraph size.
- Never set interface text below 10px.

### Typography

| Token | Value |
| --- | --- |
| `--font-heading` | `"Cormorant Garamond", serif` |
| `--font-body` | `"Lora", serif` |
| `--font-heading-weight` | `600` (interface ceiling — bold is retired from the system) |

Google Fonts: `Cormorant+Garamond:ital,wght@0,300..700;1,300..700` and `Lora:ital,wght@0,400..700`.

Rules:

- **The bigger the text, the lighter the weight.** Display sizes (40px+) take weight
  300–400, never 600. Interface headings cap at 600.
- `letter-spacing: -0.015em` on headings; `-0.02em` on display sizes 50px+.
- `line-height: 1.04–1.12` on headings, `1.7–1.75` on body.
- **Numbers set tabular** (`font-variant-numeric: tabular-nums`) wherever they stand as
  figures or columns: prices, quantities, totals, kickers, table data, till numbers.
  Running prose keeps proportional figures — Lora's tabular feature widens word-spaces
  and loosens paragraphs.
- Kickers and small caps: heading face, 10–12px, `letter-spacing: 0.14–0.2em`, uppercase,
  `#605d5d` or `#7d5411`.
- Body copy in editorial contexts is `text-align: justify` with `text-wrap: pretty`.
- No sans-serif anywhere. Italics and weight carry emphasis.

### Spacing, radius, elevation

| Token | Value |
| --- | --- |
| `--space-1 … --space-8` | `4.6 / 9.2 / 13.8 / 18.4 / 27.6 / 36.8px` (1.15× density) |
| `--radius-sm / md / lg` | `2 / 4 / 7px` |
| `--shadow-sm` | `0 1px 2px rgba(45,43,43,0.14)` |
| `--shadow-md` | `0 3px 10px rgba(45,43,43,0.16)` |
| `--shadow-lg` | `0 12px 32px rgba(45,43,43,0.22)` |

App-icon corner radius is **22% of the icon's size** (128px tile → 28px radius).

### Interaction states

Themed, never browser defaults:

- **Hover** on outlined controls: `background: rgba(182,130,53,0.12)` (accent at 12%).
- **Pressed**: accent at 22%.
- **Selected** (e.g. the active tender button): accent at 10% fill **plus** a
  `1px solid #b68235` border and `#7d5411` label color.
- **Focus**: `outline: 2px solid #b68235; outline-offset: 2px`. Never the default blue ring.
- **Disabled**: `opacity: 0.45`.
- **Active nav item**: `border-bottom: 2px solid #b68235`, label in `#201f1d`; inactive labels `#605d5d`.

---

## Screens / views

### 1. Till — "Sell" (turn 07 in the HTML, `#7a`)

**Purpose.** A cashier rings up a sale at the counter and takes payment. Four jobs and
nothing else: scan, bill, take payment, print. Stock movement is a *consequence*, shown
inline, never a task.

**Deliberately absent** — these belong to Bin and Book, one tab away: quotes,
statements, age analysis, branch transfers, stock takes. A counter screen that tries to
hold every operational reality at once is why existing hardware POS software is disliked.

**Frame.** Fixed **1360px wide**, `min-width: 1360px` (it must not compress —
the line-item grid collapses below that). Ground `#f3f2f2`, `1px solid rgba(32,31,29,0.16)`
border, `4px` radius, `--shadow-md`, `overflow: hidden`. Designed for a desktop till
and a landscape tablet.

#### 1.1 Header bar

`padding: 16px 26px`, `border-bottom: 1px solid rgba(32,31,29,0.16)`, flex row, `gap: 22px`,
vertically centered.

- **Brand lockup** (left): 26px scan-frame mark in `#b68235` · "Innova" in Cormorant 24px
  `#201f1d` with "POS" in `#7d5411` · a `1px × 20px` `#b68235` vertical rule ·
  "Hardware" in Cormorant 15px `#7d5411`, `letter-spacing: 0.05em`.
- **Nav**: Sell / Quotes / Accounts / Stock. Cormorant 14px, `padding: 10px 16px`.
  Active = `#201f1d` + `border-bottom: 2px solid #b68235`. Inactive = `#605d5d`,
  hover `#7d5411`.
- **Right cluster**, `margin-left: auto`, `gap: 16px`, tabular figures:
  - Sync chip: outlined `1px #b68235`, `4px` radius, `padding: 7px 11px`, Cormorant 12px
    uppercase `letter-spacing: 0.1em` `#7d5411`, with a 12px check icon. States needed:
    **Synced** / **Offline · N sales queued** / **Syncing**.
  - "Till 03 · Branch 04" — Cormorant 13px uppercase `letter-spacing: 0.12em` `#605d5d`.
  - Hairline divider, then cashier name in Cormorant 14px.

#### 1.2 Scan bar

`padding: 22px 26px`, bottom hairline. Flex row, `gap: 16px`.

- **Scan field** (flex 1): `min-height: 62px`, `background: #f8f4f4`,
  `1px solid #b68235`, `4px` radius, `padding: 0 18px`, `gap: 15px`.
  26px barcode-bracket icon in `#b68235`. Placeholder "Scan barcode, or type a code"
  in Cormorant **21px `#605d5d`**. Right-aligned: hairline rule, then
  "F2 search" in Cormorant 13px uppercase `letter-spacing: 0.14em` `#7d5411`.
  **This field holds focus by default and after every completed sale** — it is the only
  control touched on a normal transaction.
- **Customer selector**: `min-width: 200px`, `min-height: 62px`, outlined
  `1px rgba(32,31,29,0.16)`. Person icon `#605d5d`, then two stacked lines —
  "Walk-in customer" (Lora 13px `#605d5d`) and the price band, "Retail price"
  (Cormorant 12px uppercase `#7d5411`). Selecting an account customer switches this to
  the account name and the band to "Trade price", and re-prices every line.

#### 1.3 Line-item table

A **CSS grid**, identical tracks on the header row and every data row:

```
grid-template-columns: 44px 1fr 130px 120px 130px 44px;
gap: 0 16px;
padding: 15px 26px;          /* 12px vertical on the header row */
```

Columns: **#** · **Item** · **Qty** (right) · **Unit** (right) · **Amount** (right) · **delete**.

Header row: bottom hairline `rgba(32,31,29,0.16)`, Cormorant 12px uppercase
`letter-spacing: 0.14em` `#605d5d`, tabular.

Data rows: bottom hairline `rgba(32,31,29,0.09)`, hover `background: #f8f4f4`,
tabular figures throughout.

Each row's **Item** cell stacks two lines:

- Line 1: description, Lora 15px `#201f1d`.
- Line 2 (metadata), 12px `#605d5d`, one of three forms:
  - **Plain**: `"601240 · stock 148 → 128"` — SKU and the stock movement this line causes.
  - **Cut**: a `Cut` tag — Cormorant, uppercase, `letter-spacing: 0.1em`, `#7d5411`,
    `1px solid #b68235`, `2px` radius, `padding: 1px 6px` — followed by
    `"7.2 m from 6 m stock · offcut 0.4 m"`.
  - **Weighed**: a `Weighed` tag, same styling, followed by `"scale 02 · tare 0.35 kg"`.

Row numbers: Cormorant 14px `#605d5d`. Amounts: Lora 16px `#201f1d`. Unit price: 15px `#605d5d`.
Delete control: `#605d5d` 19px `×`, hover `#7d5411`, centered in its 44px track.

**Just-scanned row**: `background: #fff3e4` and its metadata line reads
`"just scanned · stock 41 → 40"` in `#7d5411`. This tint decays back to transparent after
roughly 1.2s. It is the only animation the till needs.

The four rows in the mock, as reference data:

| # | Item | Metadata | Qty | Unit | Amount |
| --- | --- | --- | --- | --- | --- |
| 1 | Cement, 42.5N — 50 kg bag | 601240 · stock 148 → 128 | 20 | 120.90 | 2 418.00 |
| 2 | Rebar Y12 — cut to 2.4 m | Cut · 7.2 m from 6 m stock · offcut 0.4 m | 3 | 94.70 | 284.10 |
| 3 | Galvanised wire, 2.0 mm — loose | Weighed · scale 02 · tare 0.35 kg | 6.40 kg | 31.05 | 198.72 |
| 4 | Sikaflex 11FC — 300 ml | just scanned · stock 41 → 40 | 1 | 119.00 | 119.00 |

#### 1.4 Left-column footer

`margin-top: auto`, `padding: 20px 26px`, top hairline. Outlined buttons,
`min-height: 46px`, `padding: 0 18px`, `4px` radius, Cormorant 14px,
hover `rgba(182,130,53,0.12)`:

**Non-stock line** (with a plus icon) · **Discount** · **Park sale** · then, pushed right
with `margin-left: auto`, **Void sale** in `#605d5d`.

#### 1.5 Payment column

`flex: 0 0 420px`, separated from the left column by `border-right` on the left column.

**Totals block** — `padding: 24px 26px`, bottom hairline, `gap: 11px`, all tabular:

- "4 lines · 30.40 units" / `2 625.94` — 14px `#605d5d`
- "VAT at 15%" / `393.88` — 14px `#605d5d`
- **Two 1px `#b68235` rules stacked with an 11px gap** — the accountant's double rule.
- "TOTAL" (Cormorant 14px uppercase `letter-spacing: 0.16em` `#605d5d`) against
  **`R 3 019.82` in Cormorant weight 300, 54px, `letter-spacing: -0.02em`** — the largest
  figure on the screen, because it is the one the customer reads.

Note the thin-space (`&thinsp;`) between "R" and the figure and as the thousands
separator. This is the South African convention and it is used consistently.

**Tender** — `padding: 22px 26px`, `gap: 14px`:

- Section kicker "TENDER", Cormorant 12px uppercase `letter-spacing: 0.16em` `#605d5d`.
- Three buttons in a `repeat(3, 1fr)` grid, `gap: 10px`, `min-height: 76px`, icon over
  label (Cormorant 14px): **Cash** · **Card** · **Account**.
  Selected state as described in "Interaction states". Account is disabled unless the
  selected customer has an account.
- **Cash-in field**: `1px solid #b68235`, `background: #f8f4f4`, `padding: 14px 18px`.
  Kicker "CASH IN" `#605d5d` left, amount right in Cormorant 30px.
- **Keypad**: `repeat(4, 1fr)` grid, `gap: 8px`, cells `min-height: 52px`,
  `1px rgba(32,31,29,0.16)`, `4px` radius, Cormorant 19px.
  Layout: `7 8 9 [R200] / 4 5 6 [R100] / 1 2 3 [R50] / 0 00 . [backspace]`.
  The quick-cash column is Cormorant 14px `#605d5d`.
- **Change due**: kicker left, `R 80.18` in Cormorant 27px `#7d5411` right.
- **Tender & print**: `min-height: 64px`, `1px solid #b68235`,
  `background: rgba(182,130,53,0.1)`, hover `0.2`, Cormorant 20px `#7d5411`
  `letter-spacing: 0.05em`, printer icon. Hover is the only fill that deepens.
- Caption below, centered, 12px `#605d5d`:
  "Enter to complete · drawer opens · stock posts to Bin".

**All hit targets clear 44px.** The entire sale must be completable from the keyboard:
scan → amount → Enter.

### 2. App icon — "Scan Frame" (turn 09, `#9a`)

Four corner brackets closing on a barcode. Chosen over five alternatives because it is
already the universal sign for "ring this up", it holds at 16px, and **the empty centre
is a white-label slot** — a reseller drops their monogram in without touching the frame.

**Geometry**, on a 96-unit box:

| Property | Value |
| --- | --- |
| Box | 96 × 96 units |
| Safe area | 72 × 72 (12-unit margin) |
| Bracket arm | 18 units |
| Interior bars | 28 units tall |
| Tile corner radius | 22% of rendered size |

**Three masters, each drawn at its own stroke weight — never scale one to another's size:**

| Master | Sizes | Stroke | Interior bars | Caps |
| --- | --- | --- | --- | --- |
| A | 1024, 512, 256, 128, 64 | 5.5 units | 3 | round |
| B | 48, 32 | 8.5 units | 2, widened | round |
| C | 16 | 13 units | none | **square, pixel-snapped** |

Master C drops the round caps deliberately: at 16px a rounded terminal costs a whole
pixel of arm length and reads as a blur.

Master A path data (brackets, then bars):

```
M30 12H12v18M66 12h18v18M84 66v18H66M30 84H12V66     stroke #e1ad66, width 5.5
M34 34v28M46 34v28M62 34v28                          stroke #b68235, width 5.5
```

**Variants**: primary (gold on `#16150f`) · on paper (`#b68235`/`#7d5411` on `#f3f2f2`) ·
one-colour (`#201f1d`) · monogram (Cormorant "IE" in the centre) ·
white-label slot (32-unit centre square reserved).

**Icon rules**: brackets never change proportion; interior content is the only variable.
The near-black tile is the only fill in the identity — no gradients, no glow. A reseller
monogram sits inside the 32-unit slot, takes the gold, and never touches the brackets.

### 3. Other views in the document (reference only, not specified for build)

- **Turn 08** — the five rejected icon candidates, with the reason each was set aside.
- **Turn 06** — the four-product suite (InnovaPOS, Bin, Book, Route) and endorsement lockups.
- **Turn 04 / 05** — brand-architecture options and the one chosen.
- **Turn 02 / 03** — early mark exploration for the hardware vertical and the POS product.

---

## Interactions & behavior

None of this is implemented in the mock. It is the intended behavior.

### Ringing up a sale

1. Scan field holds focus. A barcode scan (or typed code + Enter) appends a line.
2. The new line tints `#fff3e4` and shows `"just scanned · stock N → N−q"`; the tint
   decays after ~1.2s.
3. Scanning the same code again increments the existing line's quantity rather than
   adding a second row.
4. Totals, VAT and line count recompute on every mutation.
5. Focus returns to the scan field after every action.

### Cut-to-length lines

Selecting a cut-to-length SKU prompts for a length and a count. The system computes how
many stock lengths are consumed and the offcut remainder, and writes both onto the line's
metadata. Offcut handling (return to stock as a short length, or write off) is a
store-level setting.

### Weighed lines

A weighed SKU reads from a connected scale, subtracts the tare, and records the scale ID.
If no scale responds, the cashier may enter the mass manually — the metadata must then
record it as manual, because these are the lines that get disputed.

### Payment

- **Cash**: keypad or quick-cash keys populate cash-in; change due computes live.
  On completion the drawer opens.
- **Card**: hands off to the terminal, shows a pending state, waits for approval or decline.
- **Account**: available only for account customers, checks the credit limit, posts to Book.
- **Tender & print** completes the sale: prints the VAT invoice, posts stock movements to
  Bin, clears the screen, returns focus to the scan field.

### Offline-first

This is a hard requirement, not a nice-to-have. The till completes sales with no network
and no server. Sales queue locally with a monotonic sequence number and sync when the
connection returns. The sync chip in the header is the only indicator, and it must never
block a sale. Load-shedding means a till may run for hours offline and then sync hundreds
of transactions at once.

### Keyboard

Full keyboard operation is required — a hardware counter is faster on keys than on glass.
`F2` opens item search. Enter completes the current step. Every action reachable by key.

---

## State management

Per-sale state:

- `lines[]` — SKU, description, metadata kind (`plain` | `cut` | `weighed`), quantity,
  unit of measure, unit price, price band applied, computed amount, stock-before,
  stock-after, and for cut/weighed lines the cut or tare detail.
- `customer` — null (walk-in) or an account customer with a price band, credit limit and
  current balance.
- `priceBand` — retail or trade, derived from `customer`, re-prices all lines on change.
- `tender` — method, cash-in amount, change due, terminal status.
- `justScannedLineId` — drives the row tint, cleared on a timer.

Session and device state:

- `till`, `branch`, `cashier`, `drawerFloat`.
- `connection` — synced / offline / syncing, and `queuedSaleCount`.
- `parkedSales[]` — sales set aside to serve another customer.

Data the till needs available **locally**, because it must work offline: the product
catalogue with both price bands, per-branch stock levels, account customers with credit
limits, and the VAT rate.

## Assets

- **Fonts**: Cormorant Garamond and Lora, both Google Fonts. Self-host for a till that
  runs offline.
- **Icons**: the design system specifies **Lucide** (https://lucide.dev). The icons in the
  HTML are hand-drawn approximations in that spirit — replace them with real Lucide
  glyphs where an equivalent exists.
- **Brand marks**: all SVGs in the HTML are sketches. Redraw in a vector tool before
  shipping. A production icon hand-off additionally needs outlined strokes for the ICO
  and ICNS bundles, a maskable variant with extra padding for Android, and a monochrome
  template for the macOS menu bar.
- **No photography** exists yet. Anything image-led needs real store and product
  photography commissioned.

## Files

- `InnovaEarth Brand Directions.dc.html` — the full design document, nine turns,
  newest first. Turn 07 is the till; turn 09 is the icon system.
- `_ds/classical-1d28159b-78b1-467f-83d6-a67c01b9bd05/styles.css` — the design-system
  token sheet the designs were built against. The authoritative source for every
  `--color-*`, `--font-*`, `--space-*`, `--radius-*` and `--shadow-*` value.

## Open questions for the client

1. The store's real trading name and descriptor — the hardware lockups in turn 02 still
   carry placeholder text.
2. Whether the mark must sit beside a buying-group logo (Buco, Mica, Build it) on a
   shopfront, which would constrain its aspect ratio.
3. CIPC name-register check and a class 9 / class 42 trade-mark search on "InnovaPOS".
4. Sibling product names: keep Bin / Book / Route, or align them to InnovaStock /
   InnovaBook / InnovaRoute.
