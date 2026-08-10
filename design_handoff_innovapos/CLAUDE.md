# CLAUDE.md — InnovaPOS

Working notes for Claude Code on this repository. Read `README.md` in this folder first;
it is the design specification. This file is about how to work.

## What this project is

A point-of-sale application for South African retail, launching into hardware and
building-material stores. Sold to buying-group members (Buco, Mica, Build it). Part of a
planned suite under the InnovaEarth house brand — InnovaPOS is the till; Bin (stock),
Book (accounts) and Route (deliveries) come later.

## Hard constraints

These are not preferences. Violating any of them breaks the product.

1. **Offline-first.** The till completes sales with no network and no server. Sales queue
   locally and sync when the connection returns. Load shedding means hours offline, then
   hundreds of queued transactions at once. Never put a network call in the path of
   completing a sale.
2. **Keyboard-complete.** Every action reachable by key. A hardware counter is faster on
   keys than on glass. The scan field holds focus by default and after every sale.
3. **VAT at 15%, SARS-compliant invoices.** Get the invoice fields right; this is a legal
   document.
4. **Thin-space number formatting.** `R 3 019.82` — thin space after the R and as the
   thousands separator, two decimals always. Write one formatter and use it everywhere.
5. **Tabular figures on every number that stands as a figure or a column.** Prose keeps
   proportional figures.
6. **44px minimum hit target.** Cashiers work fast, sometimes with gloves on.
7. **Units of measure are not always integers.** Stock sells per-each, per-metre and
   per-kilogram. Quantity is a decimal with a unit, not a count. Do not type it as an int.

## Design system: Classical

Editorial and book-like. Read `README.md` for the full token table. The four rules that
are easiest to get wrong:

- **Color is stroke, not fill.** Buttons are outlined, cards are bordered, hairlines carry
  the structure. The only filled ground in the whole identity is the near-black
  (`#16150f`) app-icon tile.
- **No sans-serif.** Cormorant Garamond for headings and interface labels, Lora for body
  and data. Emphasis comes from weight and italics.
- **The bigger the text, the lighter the weight.** Display sizes take 300–400. Bold is
  retired from this system entirely.
- **Airy spacing.** The scale is 1.15× density by design. Do not tighten leading or crowd
  margins to fit more in — cut content instead.

Contrast floors, which an audit caught during design:
`#605d5d` is the minimum for secondary text on paper; `#bab6b6` for muted text on
near-black; `#7d5411` (not `#b68235`) for accent text at paragraph size; never below 10px.

## Implementation approach

The HTML in this folder is a **design reference**, not code to port. It is written for a
streaming design runtime with inline styles only and will not fit an application.

Recreate the designs in this repository's own environment and patterns. Read the HTML for
exact values — colors, sizes, spacing, copy — and implement idiomatically. If no framework
is chosen yet, pick one suited to a desktop-and-tablet application that must run offline
and keep a local database.

Suggested build order:

1. Design tokens as whatever this codebase uses for theming. Get the type scale, the
   contrast floors and the number formatter right before building any UI.
2. The line-item grid. It is the heart of the screen and the thing most likely to break —
   the Item column must not be allowed to collapse (the design mock hit exactly this bug;
   the frame is fixed at 1360px minimum for that reason).
3. Scan → line → totals, with the just-scanned tint.
4. Cut-to-length and weighed line types, including the metadata they must record.
5. Tender: cash with keypad and change, then card, then account.
6. Offline queue and sync, with the header chip as its only surface.

## Scope discipline

The till does four things: scan, bill, take payment, print. Stock movement is shown as a
consequence, inline on each line, never as a task.

Quotes, statements, age analysis, branch transfers and stock takes **do not belong on the
sell screen**. They are separate products (Book and Bin) or separate tabs. A counter
screen that holds every operational reality at once is precisely why the incumbent
hardware POS software is disliked, and that is the opening this product is walking into.

When in doubt about adding something to the sell screen: don't, and ask.
