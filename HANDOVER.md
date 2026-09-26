# Handover — where this is, and what bit me

Written at the end of a long session at the counter, for whoever picks this up
next. `CLAUDE.md` is the working agreement and is **not** repeated here; read it
first. `README.md` says what the thing is. This says what is true today, what is
unfinished, and what I learned the hard way so you do not learn it again.

## Where it runs

- **Shop**: 5 Star Hardware Store, Ladybrand. The live org in the database is
  named **IE Test Shop** while it is being trialled.
- **Counter machine**: a PinnPOS Windows all-in-one, 1024×768 at 100%, run
  **windowed** — so the page is about **1024×620**, not 768. Design to that.
  It has **no camera**. It has a laser scanner that types into the scan box.
- **Supabase**: project `krkatpesfwqnjitcxkco`. **Two orgs** — filter every
  query by `org_id`, or the two shops' data reads as one (it did, once, and
  "duplicate" suppliers turned out to be one in each shop):
  - **IE Test Shop** `fc022aa6-13de-4797-817b-ce994b2292f0` — the trial org.
  - **5 Star Hardware** `a9ffe512-7fa8-4a42-8b2c-d01439468878` — the live shop.
- **Delivery sorting** (`organizations.sort_deliveries`, 0117): a scanned
  delivery's lines are matched, costed and named for the till, and the same
  delivery is not filed or booked in twice. **On for every shop, and the
  default for every new one** (0125). The column stays as the one place a shop
  could be switched back with a one-line `update`.
- **Merged items** (0121): `products.merged_into` marks an item folded into
  another from the catalogue's "Merge a duplicate into this". It is kept, off
  sale and out of the catalogue list, so its own stock history still reads;
  every other table points at the kept item. There is no unmerge.
- **Hosting**: Cloudflare Worker `hardware-pos` at app.innovaearth.com.

## How work reaches the shop

Push to `main` → CI runs migrations, unit rules, the trial-link build and the
full browser suite → **on green it deploys itself**. There is no manual deploy
step and no PR in the loop today (the branch protection is bypassed on push).

The till then notices within five minutes, or immediately when its window is
focused, and shows an amber **↻ Update** button. Pressing it activates the
waiting service worker and reloads onto it. **Verified working on the machine.**

## Suites

| | |
|---|---|
| `npm test` | unit rules, seconds |
| `npm run test:db` | migrations + RPC rules against a scratch Postgres |
| `CI=1 npx playwright test` | 259 tests, ~8 min — `CI=1` matters, it rebuilds |
| `npm run build:demo` | the hosted trial link. CI builds it; nothing else does |

## Verified on the real machine

Update button, straight-to-printer, the one-row action bar with a long
destination, returns (the drawer rule), the catalogue, the item rows, the
column alignment.

## NOT verified, and only paper can settle it

**The left edge of a printed receipt.** `@page { margin: 2mm }` exists because
a thermal head cannot lay ink at the very edge of the roll and `margin: 0` shaved
the left column off. Playwright's print emulation has **no page box**, so a
margin change leaves every test green. Check a real slip.

**Invoice numbers are the till's to give (0096).** A till reserves a block
of twenty-five and numbers its own sales, online or off; the server checks
and keeps them. Consequences worth knowing before somebody asks: two tills'
numbers interleave, so the shop's run is not in time order across tills; a
sale the server parks for approval at sync leaves its printed number as a
gap; unpairing a till abandons whatever it held (the queued sales it still
carries are re-numbered by the server at replay, so their slips will not
match — rare, and said in `sync.ts`). `doc_reservations` is the record of
who held what.

## Open, in the order I would do them

1. **Email.** Designed, not built. One Supabase Edge Function + Resend/Postmark.
   Reply-To the shop is one header. The real work is: a dedicated sending
   subdomain (`mail.innovaearth.com`) with SPF/DKIM/DMARC — a one-off ~30 min of
   DNS on Cloudflare, which already runs that domain; the function must check the
   caller's JWT or it is an open relay; offline queueing; and a record of what
   was sent. **Multi-shop matters**: never one shared From. Default is the shared
   domain with a per-shop envelope address and display name and the shop's
   Reply-To; a shop with its own domain can verify it later. Store the sender
   identity on `organizations` from day one so that upgrade is additive. The
   danger is shared sender reputation, not branding. **The shop never types a
   From address** — that is a spoofing vector against your own domain.
2. **Bigger receipt print**, if 40 columns is still not enough: the dial is
   Manage → Shop → Printing (48/40/32). 32 is about a third bigger than 48.
3. **Phone stage 2** — the destination screens made phone-shaped. Deliveries
   and Stock are the first two, opened whole from tiles on the phone's home
   (the shop asked for them so a manager or owner can work them remotely);
   they fit 390 wide as they are, so nothing was reshaped. Deliveries works
   with no signal (README, "With the line down"); Stock does not, and cannot
   without a design for re-asking the PIN at sync, since a receipt is
   PIN-gated and the phone stores no PIN. The rest not started.
4. **`Cancel this sale`** sits one tap from `Close` in the slip popup, which
   appears after every sale. A manager PIN and a typed reason mean a mis-tap
   cannot void anything, but the placement is worth revisiting.

## Traps. Every one of these cost me a run or a wrong fix

**A break that does not compile proves nothing.** CLAUDE.md says it; I still did
it twice (an unused variable, a type narrowed to `never`). The suite then fails
to build and you learn nothing. Break it so it compiles and does the wrong thing.

**A guard can pass with the fix removed.** Five times that session, and
once more since: a "the page never scrolls sideways" assertion held with the
phone body's scroller removed, because the tables fit anyway — so it proves
the page, not the rule. Said so in the commit rather than counted as coverage.

**A guard can pass with the fix removed.** Five times this session. Each time the
test was measuring the wrong thing or the wrong size:
- five buttons instead of six (nothing parked), so the row fit either way;
- 1024 only, where the header's own wrap saved the tab strip;
- 620 only, where *height*-keyed rules already compact what a *width* rule was
  meant to fix;
- a locator pinned to the label, so the break failed the setup, not the assertion;
- a colour compared in two notations — `rgb(200, 145, 47)` against `#c8912f` is
  never equal whatever the colour is. **Resolve custom properties through a probe
  element.** This one bit twice.

**Tests that read the screen without waiting.** Three of mine measured the DOM
immediately after a click — the print preview before the sale returned, the
Manage header before the PIN returned, a print counter before anything printed.
All passed alone and failed under the full suite. They were racing from birth.

**`git checkout -- <file>` discards uncommitted work.** It bit four times, and
twice more in the security sweep: once an UNTRACKED migration could not be
restored at all, so the breaks stacked; once three edited files went back to
HEAD and the fix had to be re-applied. `git add` everything before a break
sweep — checkout then restores to the index, which is the fix.

**`vite.config.js` is a stale build artifact** beside `vite.config.ts`, and Vite
prefers the `.js`. `npx vite build` alone uses the stale one; `npm run build`
regenerates it first. I debugged a phantom for ten minutes over this.

**CSS, four in one session:**
- `1fr` is `minmax(auto, 1fr)`. Every row is its own grid, so a bare `1fr` lets
  each row size its columns from its own content. Use `minmax(0, 1fr)`.
- `margin-left: auto` inverts on wrap — an item alone on a line is thrown right.
- Adjacent margins **collapse**; reserving space with `margin-bottom` buys
  nothing. Height does not collapse.
- Keying a **width** problem on `max-height` means a tall screen gets the roomy
  values and overflows worse. Check the axis.

**A comment parked mid-selector.** `.line-qty, .line-unit, /* … */ .line-disc {}`
quietly gave every quantity on the till the colour reserved for money owed.

**The GitHub MCP is minutes stale**; polling it is wasted. **Cloudflare's MCP is
read-only for Workers** — no deploys through it.

**`pkill -f playwright` kills your own shell** (exit 144). Kill by PID.

## Things that are deliberate, so you do not "fix" them

- The slip is **48 columns of ~1.5mm type by physics**. The only real lever is
  fewer columns. Page margins and divisors are worth a few percent.
- `mailto:` **cannot carry an attachment**. No browser allows it. That is why
  emailing a quote on a desktop saves the PDF and opens the mail app.
- Chrome's own print dialog **cannot be removed by a web page**. `--kiosk-printing`
  on the shortcut is the only answer.
- Cash cannot leave a drawer with no open till session. The rule is right; only
  its signposting was wrong.
- **Approvals is phone-only.** The code exists for when the manager is *not* at
  the till.
- Camera screens are gated on **whether a camera exists**, not on device kind —
  an iPad till has one and keeps them.
- `Void sale` has no border. It is the one destructive control in that row.
- A delivery line matched by **name alone** is only ever *offered* ("Is it …?"),
  never booked in on trust. On 5 Star's own invoices a name match offered
  HIGH GLOSS PWD BROWN 1LT for ECONO GLOSS PWD Brown 1L — a different range.
