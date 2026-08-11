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
