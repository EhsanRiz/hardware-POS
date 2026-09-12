import { expect, test } from "@playwright/test";
import { installBackend, pairAndSignIn, USERS } from "./fake-backend";

/**
 * The till fits the hardware it is deployed on.
 *
 * This exists because it did not. The Sell screen was built to the handoff's
 * fixed 1360px frame and carried a hard `min-width`, which is correct for a
 * desktop till and wrong for what is actually being shipped — an iPad or a
 * large Android tablet. In landscape those are 1024 to 1194 CSS pixels, and in
 * portrait 768 to 834, so the counter got a screen that scrolled sideways
 * while a customer stood waiting.
 *
 * The rest of the suite runs at Desktop Chrome's 1280x720, which is wide
 * enough to hide the problem. These sizes are the real devices.
 */

const DEVICES = [
  { name: "tablet landscape, 1024", width: 1024, height: 768 },
  { name: "iPad Pro landscape, 1194", width: 1194, height: 834 },
  { name: "tablet portrait, 820", width: 820, height: 1180 },
  { name: "tablet portrait, 768", width: 768, height: 1024 },
];

for (const device of DEVICES) {
  test.describe(device.name, () => {
    test.use({ viewport: { width: device.width, height: device.height } });

    test("sells without scrolling sideways, and the money button is reachable", async ({
      page,
    }) => {
      await installBackend(page);
      await pairAndSignIn(page);

      await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
      await page.keyboard.press("Enter");
      await expect(page.locator(".line-desc")).toHaveText("Cement 42.5N 50kg");

      // Nothing may spill past the viewport. A horizontal scrollbar on a till
      // means the cashier has to pan the screen to finish a sale.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect(overflow, "horizontal overflow in CSS pixels").toBeLessThanOrEqual(0);

      // Taking the money must always be one tap away: docked in the payment
      // column on a wide screen, or behind the bar that raises the sheet.
      const tender = page.getByRole("button", { name: /Tender & print/i });
      const bar = page.getByRole("button", { name: /Take payment/i });

      if (await bar.isVisible()) {
        await bar.click();
      }
      await expect(tender).toBeVisible();

      // A sale settles by taking a tender, so the cash button has to be
      // reachable too — it is the one a counter presses most.
      await page.getByRole("button", { name: /^Cash$/ }).click();
      await expect(tender).toBeEnabled();
    });
  });
}

/**
 * The back office on a manager's phone.
 *
 * Manage was built for a tablet and then opened on a phone the day approval
 * codes shipped — because issuing one is something a manager does standing in a
 * bank queue, not at a counter. Seven tabs did not fit: "Bulk import" wrapped
 * onto two lines, and Staff and Shop were off the right-hand edge with nothing
 * on screen to suggest they existed.
 *
 * The first fix made the strip scroll, which kept every tab reachable but not
 * findable — Shop was three screen-widths of sideways scrolling away, and
 * nothing said so. On a phone the tabs now sit behind a burger: one tap shows
 * every section this person may open, on rows a thumb can hit, over the page
 * rather than in place of it. The tablet strip is untouched — at those widths
 * all seven fit and one-tap switching is the better tool — and the rest of the
 * suite exercises it constantly at the default desktop size.
 */
test.describe("manager's phone, 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("every Manage section is reachable from the burger, and nothing wraps", async ({ page }) => {
    const be = await installBackend(page);
    void be;
    await pairAndSignIn(page, "123456");

    await page.getByRole("button", { name: /^Manage$/ }).click();
    const dialog = page.getByRole("dialog", { name: "Manage" });
    for (const d of "123456".split("")) {
      await dialog.locator(`button:text-is("${d}")`).first().click();
    }

    // The header must fit the phone. Not the whole document: the Sell screen is
    // still mounted underneath and is built for a tablet, which is a separate
    // question — nobody rings up a sale on a phone. What matters here is that
    // the back office fits the device a manager actually carries.
    // The Manage header specifically — the Sell header behind it also says
    // "Manage", on the button that opens this.
    const header = page
      .locator("header")
      .filter({ has: page.getByRole("heading", { name: "Manage" }) })
      .first();
    const box = await header.boundingBox();
    expect(box!.width, "header width").toBeLessThanOrEqual(390);

    // The strip is gone on a phone — the burger replaces it, and the header
    // says where you are since the tabs no longer can.
    await expect(page.getByRole("button", { name: "Bulk import", exact: true })).toBeHidden();
    await expect(header).toContainText("Catalogue");

    const burger = page.getByRole("button", { name: "Sections" });
    await expect(burger).toBeVisible();
    await burger.click();

    // One tap, every section — visible, unwrapped, and inside the screen.
    for (const label of ["Catalogue", "Bulk import", "Shelf", "Sales", "Approvals", "Cash-up", "Staff", "Shop"]) {
      const row = page.getByRole("button", { name: label, exact: true });
      await expect(row, `${label} is offered`).toBeVisible();
      const rb = await row.boundingBox();
      expect(rb!.height, `${label} on one line`).toBeLessThan(56);
      expect(rb!.x + rb!.width, `${label} inside the screen`).toBeLessThanOrEqual(390);
    }

    // Picking one goes there and puts the menu away.
    await page.getByRole("button", { name: "Shop", exact: true }).click();
    await expect(page.getByLabel("Shop name")).toBeVisible();
    await expect(page.getByRole("button", { name: "Bulk import", exact: true })).toBeHidden();
    await expect(header).toContainText("Shop");

    // Reopened, the menu marks where you are.
    await burger.click();
    await expect(page.getByRole("button", { name: "Shop", exact: true }))
      .toHaveAttribute("aria-current", "page");

    // Leaving is always available — never folded into the menu.
    await expect(page.getByRole("button", { name: /Back to till/i })).toBeVisible();
  });
});

/**
 * A whole sale on a phone.
 *
 * The tablet tiers narrow the line columns and drop the unit price, which
 * works down to about 700px and then fails quietly: `1fr` will not shrink past
 * the product name's min-content, so the row grows wider than the screen and
 * the two controls on its right — the discount key and the delete — are pushed
 * off the edge. The row is clipped, so the page does not scroll and nothing
 * says they are there. You could not remove a line or take money off one.
 */
test.describe("tablet portrait, 768 — catalogue", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("the catalogue fits its box: no sideways scroll, and the aside columns step aside", async ({ page }) => {
    await installBackend(page);
    await pairAndSignIn(page, "123456");
    await page.getByRole("button", { name: /^Manage$/ }).click();
    const dialog = page.getByRole("dialog", { name: "Manage" });
    for (const d of "123456".split("")) {
      await dialog.locator(`button:text-is("${d}")`).first().click();
    }
    await expect(page.getByRole("cell", { name: "CEM-425-50" })).toBeVisible();

    // Department and unit are on the editor a tap away; below a laptop's
    // width they give their room to the name.
    await expect(page.getByRole("columnheader", { name: "Dept" })).toBeHidden();
    await expect(page.getByRole("columnheader", { name: "Unit" })).toBeHidden();
    await expect(page.getByRole("columnheader", { name: "Stock" })).toBeVisible();

    // The table lives inside its own scrolling box; at this width it must
    // not need to scroll sideways at all.
    const spill = await page.evaluate(() => {
      const table = document.querySelector("table")!;
      const box = table.parentElement!;
      return table.scrollWidth - box.clientWidth;
    });
    expect(spill, "table wider than its box, in CSS pixels").toBeLessThanOrEqual(0);

    // A price is one line. The name column used to take every spare pixel
    // and "R 229.00" broke into "R" over "229.00".
    const priceLines = await page.getByRole("cell", { name: "R 115.00" }).first().evaluate((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell.firstChild!);
      return range.getClientRects().length;
    });
    expect(priceLines, "lines the price wraps onto").toBe(1);

    // Zebra rows: neighbours differ, so the eye can follow a line across.
    const [first, second] = await page.evaluate(() => {
      const rows = document.querySelectorAll("tbody tr");
      return [getComputedStyle(rows[0]).backgroundColor, getComputedStyle(rows[1]).backgroundColor];
    });
    expect(first).not.toBe(second);
  });
});

test.describe("phone, 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("rings up, discounts, deletes and tenders without anything off-screen", async ({
    page,
  }) => {
    await installBackend(page);
    await pairAndSignIn(page, "123456");

    await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
    await page.keyboard.press("Enter");
    await expect(page.locator(".line-desc")).toHaveText("Cement 42.5N 50kg");

    // Nothing may sit outside the viewport. Measured per element rather than by
    // document scrollWidth, because a clipped row hides the problem from that.
    // Swept over the header and the line rows rather than the whole document.
    // A blanket sweep also flags things that are SUPPOSED to sit outside their
    // box — the receipt preview is a fixed 48-column slip that scrolls inside
    // its own frame, because reflowing it would stop it being a preview of what
    // the printer puts on paper. These two regions are where the bug was.
    const spill = async () =>
      page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const scope = [
          ...document.querySelectorAll<HTMLElement>(".sell-head, .sell-head *"),
          ...document.querySelectorAll<HTMLElement>(".line-row, .line-row *"),
        ];
        return scope
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > w + 1 || r.left < -1);
          })
          .map((el) => `${el.tagName}.${String(el.className).split(" ")[0]}`);
      });
    expect(await spill(), "elements past the edge with a line in the cart").toEqual([]);

    // Both line controls are on screen and usable — this is what was broken.
    await expect(
      page.getByRole("button", { name: /Discount Cement/i })
    ).toBeInViewport();
    await expect(
      page.getByRole("button", { name: /Remove Cement/i })
    ).toBeInViewport();

    // The quantity is still editable, which is the thing a counter does most.
    await page.getByLabel("Quantity of Cement 42.5N 50kg").fill("3");
    await page.getByLabel("Quantity of Cement 42.5N 50kg").blur();
    // Scoped to a row: .lines-head carries an "Amount" label of its own,
    // hidden at this width but still matching a bare selector.
    await expect(page.locator(".line-row .line-amt").first()).toContainText("345");

    // Payment is a sheet on a phone, raised from the bar along the bottom.
    await page.getByRole("button", { name: /Take payment/i }).click();
    await page.getByRole("button", { name: /^Cash$/ }).click();
    await page.getByRole("button", { name: /Tender & print/i }).click();
    await expect(page.locator("#print-area")).toContainText("Cement");

    expect(await spill(), "elements past the edge after tendering").toEqual([]);
    // And the page itself never scrolls sideways, preview and all.
    const docSpill = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(docSpill, "horizontal overflow in CSS pixels").toBeLessThanOrEqual(0);
  });
});

/**
 * The till in the shop, as it is actually run.
 *
 * A PinnPOS all-in-one, 1024 x 768 at 100%. Two sizes matter and they are very
 * different: FULLSCREEN (or installed as an app) gives the page all 768, while
 * a Chrome window with a tab strip, an address bar and the Windows taskbar
 * leaves about 590.
 *
 * Fullscreen is the one that must be perfect, and it is the one that was not:
 * the compact tier used to stop at 700px, so the shop's own till at 768 got
 * the roomy layout and had 147px of the payment panel — most of the keypad —
 * cut off. It had always been cut there.
 *
 * These are also the first cases with a real name in them. "Ehsan Rizvi ·
 * Owner" is what the shop's header carries; the fixture's "Manager" is six
 * characters, and that alone is why the header overflow never showed up.
 */
test.describe("the shop's own till", () => {
  /** Rects read WITHOUT scrolling. boundingBox() scrolls the element into view
      before measuring, so it reports a control that is only reachable by
      scrolling as being on the screen — which is the exact fault being
      tested. */
  const rect = (page: import("@playwright/test").Page, sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, right: b.right, bottom: b.bottom };
    }, sel);

  async function signedIn(page: import("@playwright/test").Page) {
    const be = await installBackend(page);
    be.staff[0].name = "Ehsan Rizvi";
    USERS.manager.row.name = "Ehsan Rizvi";
    await pairAndSignIn(page, USERS.manager.pin);
    await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
    await page.keyboard.press("Enter");
  }

  test.afterEach(() => {
    USERS.manager.row.name = "Manager";
  });

  test.describe("fullscreen, 768", () => {
    test.use({ viewport: { width: 1024, height: 768 } });

    test("the payment column fits with nothing hidden", async ({ page }) => {
      await signedIn(page);
      // Everything: the tenders, the amount, all sixteen keys, the invoice
      // disclosure. On a touch-only counter the keys are the ONLY way to enter
      // what somebody handed over — the amount box is inputMode="none" — so a
      // key below the fold is a key that is not there.
      const hidden = await page.evaluate(() => {
        const t = document.querySelector(".tender")!;
        return t.scrollHeight - t.clientHeight;
      });
      expect(hidden, "payment panel content hidden below the fold").toBeLessThanOrEqual(1);
    });

    test("the sale's actions are one row, not two", async ({ page }) => {
      await signedIn(page);
      // WITH A SALE PARKED, which is the state the photograph from the shop was
      // taken in and the only state that shows the bug: "Resume parked · 2" is
      // a sixth button and ~156px, and it is what tips the row over. Without it
      // five buttons fit at any width this till is ever run at, and a test that
      // skips this step passes with the fix removed — it did.
      await page.getByRole("button", { name: /Park sale/i }).click();
      await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
      await page.keyboard.press("Enter");
      const resume = page.getByRole("button", { name: /Resume parked/i });
      await expect(resume).toBeVisible();

      // Measured by TOP EDGE rather than by row height: a wrapped button is the
      // only way two of these end up at different heights, and the wrap is what
      // put "Void sale" on a band of its own across the till.
      const tops = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".sell-actions .btn-line")].map(
          (b) => Math.round(b.getBoundingClientRect().top)
        )
      );
      expect(tops.length, "buttons in the action row").toBeGreaterThanOrEqual(6);
      expect(new Set(tops).size, "distinct rows the actions occupy").toBe(1);
    });

    test("the masthead carries the shop's name, not the software's", async ({ page }) => {
      await signedIn(page);
      // Whoever is standing here knows what the software is. What is worth the
      // corner of the eye is which shop — a counter can run more than one.
      const head = page.locator(".sell-head .sell-shop");
      await expect(head).toBeVisible();
      await expect(head).toHaveText("Ladybrand Hardware");
      // And it does not cost the section tabs their row.
      const rows = await page.evaluate(() =>
        new Set(
          [...document.querySelectorAll<HTMLElement>(".sell-nav button")].map((b) =>
            Math.round(b.getBoundingClientRect().top)
          )
        ).size
      );
      expect(rows, "rows the section tabs occupy").toBe(1);
    });
  });

  test.describe("windowed, 590", () => {
    test.use({ viewport: { width: 1024, height: 590 } });

    test("every control the counter needs is on the screen", async ({ page }) => {
      await signedIn(page);

      // The header ran 74px past the right edge and took Sign out with it.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect(overflow, "horizontal overflow in CSS pixels").toBeLessThanOrEqual(0);

      const within = async (sel: string, what: string) => {
        const b = await rect(page, sel);
        expect(b, `${what} is not in the DOM`).not.toBeNull();
        expect(b!.right, `${what} right edge`).toBeLessThanOrEqual(1024);
        expect(b!.bottom, `${what} bottom edge`).toBeLessThanOrEqual(590);
        expect(b!.y, `${what} top edge`).toBeGreaterThanOrEqual(0);
      };

      // Every way of being paid, the box the money goes in, and the button
      // that commits it. These were sliced in half at this height; the keypad
      // below them may scroll here, but none of these may.
      for (const m of ["cash", "card", "eft", "account"]) {
        await within(`.tender-btn[data-method="${m}"]`, `${m} tender`);
      }
      await within(".cash-in", "amount box");
      await within(".btn-tender", "Tender & print");

      // And the way out of the shift.
      const signOut = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")]
          .find((x) => x.textContent?.trim() === "Sign out")!
          .getBoundingClientRect();
        return { right: b.right, bottom: b.bottom };
      });
      expect(signOut.right, "Sign out right edge").toBeLessThanOrEqual(1024);

      // The scan box must be able to say what it is for: it was showing
      // "Scan barcc" in 89px of input.
      const ph = await page.getByPlaceholder(/Scan barcode/i).evaluate((el) => {
        const i = el as HTMLInputElement;
        // Rough but sufficient: a proportional 16px face averages ~7px a
        // character, so this catches a truncated instruction without
        // pretending to measure glyphs.
        return { w: i.getBoundingClientRect().width, chars: i.placeholder.length };
      });
      expect(ph.w, "scan input width").toBeGreaterThan(ph.chars * 6);
    });

    test("the sale's actions are one row here too", async ({ page }) => {
      await signedIn(page);
      await page.getByRole("button", { name: /Park sale/i }).click();
      await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: /Resume parked/i })).toBeVisible();
      const tops = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".sell-actions .btn-line")].map(
          (b) => Math.round(b.getBoundingClientRect().top)
        )
      );
      expect(tops.length, "buttons in the action row").toBeGreaterThanOrEqual(6);
      expect(new Set(tops).size, "distinct rows the actions occupy").toBe(1);
    });
  });

  /**
   * The counter machine as it is actually run: NOT fullscreen.
   *
   * 768 of screen, less the Windows taskbar, the app's title bar and Chrome's
   * own chrome, leaves the page around 620 — and the photograph from the shop
   * showed a scrollbar down the pay column at exactly that. A scrollbar beside
   * a keypad is how a cashier ends up dragging the till instead of pressing
   * it, so this is the height the no-scrollbar promise is made at.
   *
   * 590 above keeps its older bargain — there the keypad MAY scroll, because
   * below about 600 there is genuinely nothing left to take that is not a key.
   */
  test.describe("windowed on the counter machine, 620", () => {
    test.use({ viewport: { width: 1024, height: 620 } });

    test("nothing in the pay column is behind a scrollbar", async ({ page }) => {
      await signedIn(page);
      const hidden = await page.evaluate(() => {
        const t = document.querySelector(".tender")!;
        return t.scrollHeight - t.clientHeight;
      });
      expect(hidden, "payment panel content hidden below the fold").toBeLessThanOrEqual(1);
    });

    test("and the keys are still worth pressing", async ({ page }) => {
      await signedIn(page);
      // The pixels came from somewhere, and this says where they may not come
      // from. A key plus its share of the gaps is what a finger actually
      // travels between presses, and that stays at 34.
      const reach = await page.evaluate(() => {
        const keys = [...document.querySelectorAll<HTMLElement>(".keypad button")];
        const pad = document.querySelector(".keypad") as HTMLElement;
        const gap = parseFloat(getComputedStyle(pad).rowGap || "0");
        return Math.min(...keys.map((k) => k.getBoundingClientRect().height)) + gap;
      });
      expect(reach, "keypad target including its gap").toBeGreaterThanOrEqual(34);
    });
  });
});

/**
 * The manager's laptop.
 *
 * 1366 is where most laptops land, and it is the first width at which the
 * header shows the till's name — so it is the only size that can see that
 * element grow. Carrying the shop name as well as the register's, in capitals
 * at 0.11em tracking, made it 315px and pushed Sign out clean off the screen.
 * The till at 1024 cannot catch that: there the element is display:none.
 */
test.describe("the manager's laptop", () => {
  test.use({ viewport: { width: 1366, height: 640 } });

  test("the header fits, with a real name in it", async ({ page }) => {
    const be = await installBackend(page);
    be.staff[0].name = "Ehsan Rizvi";
    USERS.manager.row.name = "Ehsan Rizvi";
    try {
      await pairAndSignIn(page, USERS.manager.pin);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect(overflow, "horizontal overflow in CSS pixels").toBeLessThanOrEqual(0);

      for (const name of ["Sign out", "Manage"]) {
        const b = await page.getByRole("button", { name, exact: true }).boundingBox();
        expect(b, `${name} has no box`).not.toBeNull();
        expect(b!.x + b!.width, `${name} right edge`).toBeLessThanOrEqual(1366);
      }

      // The tabs must not end up under the calculator: a flex item shrinking
      // below its content does not clip it, so "no overflow" alone can still
      // mean two controls sitting on top of each other.
      const gap = await page.evaluate(() => {
        const nav = document.querySelector(".sell-nav")!;
        const last = nav.lastElementChild!.getBoundingClientRect();
        const calc = document.querySelector(".head-calc-btn")!.getBoundingClientRect();
        return calc.x - last.right;
      });
      expect(gap, "gap between the last tab and the calculator").toBeGreaterThan(0);
    } finally {
      USERS.manager.row.name = "Manager";
    }
  });
});
