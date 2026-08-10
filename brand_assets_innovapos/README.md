# InnovaPOS — logos and colour scheme

Brand assets only. The full design specification (till screen, behaviour, state) is in
the separate `design_handoff_innovapos` package.

## Colour scheme

`colors/colors.css` — CSS custom properties, ready to drop in.
`colors/colors.json` — the same values as data, for a token pipeline.

| Role | Hex |
| --- | --- |
| Green — primary ground | `#0e3a2d` |
| Green deep — recessed | `#092a20` |
| Cream — reading surface | `#f5f2ea` |
| Cream sunk — wells, mats | `#eae5d8` |
| Amber — accent, stroke only | `#c8912f` |
| Amber light — accent on green | `#e0b45c` |
| Amber deep — accent text on cream | `#8a5f14` |
| Ink — text on cream | `#1b2a24` |
| Muted on cream | `#55625b` |
| Muted on green | `#a9bbb1` |
| Owing red | `#b03a2b` |

**Three rules that matter more than the values:**

1. **Amber is stroke, never fill.** Buttons are outlined, cards are bordered, hairlines
   carry the structure. Green is a ground; amber is not.
2. **Contrast floors.** On cream, nothing lighter than `#55625b` for text a user must read.
   On green, nothing darker than `#a9bbb1`. Bare amber `#c8912f` clears only ~3:1 — fine for
   strokes, icons and large type, not for body copy; use `#8a5f14` on cream and `#e0b45c`
   on green for accent text at paragraph size.
3. **Never below 10px** for interface text.

Type: Cormorant Garamond (headings, interface labels) over Lora (body, data).
The bigger the text, the lighter the weight — display sizes take 300–400, interface
headings cap at 600, bold is not used. Tabular figures on every number that stands as a
figure or a column.

## Logos

### `icon/` — app icon, 512px tiles
Three masters. **Use the master for the size; never scale one down to another's size.**

| File | Use at | Stroke | Interior bars |
| --- | --- | --- | --- |
| `innovapos-icon-master-a-512.svg` | 64px and up | 5.5 units | 3 |
| `innovapos-icon-master-b-512.svg` | 48–32px | 8.5 units | 2, widened |
| `innovapos-icon-master-c-512.svg` | 16px | 13 units | none, square caps |
| `innovapos-icon-monogram-512.svg` | alternate, with IE in the centre | | |
| `innovapos-icon-whitelabel-slot-512.svg` | reseller template — monogram in the reserved centre square | | |
| `innovapos-icon-maskable-512.svg` | Android adaptive icon (mark inset to 60%) | | |

Tile corner radius is 22% of the rendered size. Master C drops the round caps on purpose:
at 16px a rounded terminal costs a whole pixel of arm length.

### `mark/` — the mark alone, no tile, 96-unit box
For headers, nav bars, receipts, favicons. On-cream and on-green colourways, plus
single-colour versions for stamps, embroidery and one-colour print.

### `lockup/` — wordmarks
`innovapos-lockup-*` is the product. `innovaearth-house-*` is the company, used on
paperwork and contracts. **Never stack house and edition in one lockup.**

### `edition/` — vertical badges
A vertical is a hairline rule, one word and one glyph — never a new logo. Set the word in
Cormorant Garamond, `letter-spacing: 0.06em`, in amber deep on cream or amber light on green.

### `suite/` — sibling product marks
Bin (stock), Book (accounts), Route (deliveries). Same drawing grammar as the till mark:
96-unit box, one stroke weight, round caps, no fills.

### `hardware-marks/` — the hardware-vertical marks
Hex Head and Keystone, from the earlier retail-brand exploration. Kept in case a
store-facing identity is still wanted.

## Before production

These SVGs are **accurate geometry, not finished vector art**:

- **Outline the text** in the lockup files. They reference Cormorant Garamond by name, so
  they will render in a fallback face anywhere the font is not installed.
- **Outline the strokes** for ICO and ICNS bundles.
- Add a monochrome template for the macOS menu bar.
- Have the marks redrawn properly in a vector tool — kerning the wordmark, optical
  corrections, consistent path direction.

## Palette provenance

The hexes were sampled from a screenshot of letlotlo.co.za. They are close but not
authoritative. If a Letlotlo token sheet or brand file exists, take the exact values from
it and replace `colors/` — everything else in this package stays valid.
