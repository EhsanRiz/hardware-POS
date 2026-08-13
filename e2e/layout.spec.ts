import { expect, test } from "@playwright/test";
import { installBackend, pairAndSignIn } from "./fake-backend";

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
 */
test.describe("manager's phone, 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("every Manage tab is reachable, and nothing wraps", async ({ page }) => {
    const be = await installBackend(page);
    void be;
    await pairAndSignIn(page, "1234");

    await page.getByRole("button", { name: /^Manage$/ }).click();
    const dialog = page.getByRole("dialog", { name: "Manage" });
    for (const d of "1234".split("")) {
      await dialog.locator(`button:text-is("${d}")`).first().click();
    }
    await dialog.locator('button:text-is("OK")').click();

    // The header must fit the phone. Not the whole document: the Sell screen is
    // still mounted underneath and is built for a tablet, which is a separate
    // question — nobody rings up a sale on a phone. What matters here is that
    // the back office fits the device a manager actually carries.
    const header = page.locator("header").filter({ hasText: "Manage" }).first();
    const box = await header.boundingBox();
    expect(box!.width, "header width").toBeLessThanOrEqual(390);

    // The strip itself scrolls rather than squeezing — that is the mechanism.
    const strip = page.locator("nav").filter({ hasText: "Catalogue" }).first();
    const scrolls = await strip.evaluate((n) => n.scrollWidth > n.clientWidth);
    expect(scrolls, "the tab strip scrolls instead of cramming").toBe(true);

    // Every tab is one line. A wrapped label is the tell that the row is being
    // squeezed rather than scrolled.
    for (const label of ["Catalogue", "Bulk import", "Sales", "Approvals", "Shop"]) {
      const tab = page.getByRole("button", { name: label, exact: true });
      const box = await tab.boundingBox();
      expect(box, `${label} is present`).not.toBeNull();
      expect(box!.height, `${label} on one line`).toBeLessThan(44);
    }

    // And the far tab can actually be reached and used.
    await page.getByRole("button", { name: "Shop", exact: true }).click();
    await expect(page.getByLabel("Shop name")).toBeVisible();

    // Leaving is always available, however narrow it gets.
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
test.describe("phone, 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("rings up, discounts, deletes and tenders without anything off-screen", async ({
    page,
  }) => {
    await installBackend(page);
    await pairAndSignIn(page, "1234");

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
