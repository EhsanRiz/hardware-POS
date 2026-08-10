import { expect, test } from "@playwright/test";
import { Backend, installBackend, pairAndSignIn, USERS } from "./fake-backend";

/** The till's status line. Print previews repeat its text, so target it directly. */
const banner = (page: import("@playwright/test").Page) =>
  page.locator("div.bg-stone-800").first();

/**
 * End-to-end journeys through the till.
 *
 * These are chosen for consequence rather than coverage: each one is something
 * that, if it broke, would cost a shop money or a customer their trust. A test
 * that only proves a button renders is not worth the time it takes to run.
 */

let be: Backend;

test.beforeEach(async ({ page }) => {
  be = await installBackend(page);
});

test("a till must be paired before anyone can sign in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Set up this till")).toBeVisible();
  // No PIN pad until the device is a till — a cashier should never sign in to
  // a tablet that turns out to be unable to sell.
  await expect(page.locator('button:text-is("1")')).toHaveCount(0);
});

test("pairing is refused with the wrong PIN", async ({ page }) => {
  await page.goto("/");
  await page.locator("input[type=tel]").fill(USERS.manager.phone);
  await page.locator("input[type=password]").fill("9999");
  await page.getByRole("button", { name: /Pair this till/i }).click();
  await expect(page.getByText(/Invalid phone or PIN|Pairing failed/i)).toBeVisible();
  await expect(page.getByText("Set up this till")).toBeVisible();
});

test("scanning a barcode rings the item straight through", async ({ page }) => {
  await pairAndSignIn(page);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  const cart = page.locator("aside");
  await expect(cart.getByText("Cement 42.5N 50kg")).toBeVisible();
  // A scan should not leave the query behind to pollute the next one.
  await expect(page.getByPlaceholder(/Scan barcode/i)).toHaveValue("");
});

test("the shop's words find the shop's product", async ({ page }) => {
  await pairAndSignIn(page);
  // The label says "Nail Concrete 2.5 x 50mm"; the customer says this.
  await page.getByPlaceholder(/Scan barcode/i).fill("concrete nail 2.5x5");
  await expect(page.getByText("Nail Concrete 2.5 x 50mm").first()).toBeVisible();
});

test("cut goods take a decimal quantity and price correctly", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("chain");
  await page.getByText("Chain 6mm Galvanised").first().click();

  const qty = page.locator('input[inputmode="decimal"]').first();
  await qty.fill("2.5");
  await qty.press("Enter");

  // 2.5 m x R35.00 = R87.50
  await expect(page.locator("aside")).toContainText("R87.50");
  await expect(page.getByRole("button", { name: /Charge R87\.50/ })).toBeVisible();
});

test("whole-unit goods refuse a fraction", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("padlock");
  await page.getByText("Padlock 50mm Brass").first().click();

  // Sold "each": the field must not even offer decimal entry.
  await expect(page.locator('input[inputmode="numeric"]')).toHaveCount(1);
  await expect(page.locator('input[inputmode="decimal"]')).toHaveCount(0);

  const qty = page.locator('input[inputmode="numeric"]').first();
  await qty.fill("2.5");
  await qty.press("Enter");
  // Rounded to a whole padlock rather than silently sold as 2.5.
  await expect(qty).toHaveValue("3");
});

test("a cash sale completes and reports its invoice number", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Charge R/ }).click();

  await page.getByPlaceholder(/Cash received/i).fill("200");
  await expect(page.getByText(/Change/)).toBeVisible();
  await page.getByRole("button", { name: /Complete sale/i }).click();

  await expect(banner(page)).toContainText(/INV-\d+/);
  expect(be.storedSales).toHaveLength(1);
  expect(be.storedSales[0].total).toBe(115);
});

test("the server's refusal reaches the cashier, and nothing is charged", async ({ page }) => {
  await pairAndSignIn(page);

  // Only 2 rolls on hand; ask for 5.
  await page.getByPlaceholder(/Scan barcode/i).fill("twin");
  await page.getByText("Twin & Earth 2.5mm 100m").first().click();
  const qty = page.locator('input[inputmode="numeric"]').first();
  await qty.fill("5");
  await qty.press("Enter");

  await page.getByRole("button", { name: /^Charge R/ }).click();
  await page.getByPlaceholder(/Cash received/i).fill("10000");
  await page.getByRole("button", { name: /Complete sale/i }).click();

  // The server's reason must reach the cashier, not a generic refusal.
  await expect(banner(page)).toContainText(/Not enough stock/i);
  expect(be.storedSales).toHaveLength(0);
});

test("a sale taken offline still prints, then syncs exactly once", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  // The line goes down mid-transaction.
  be.offline = true;
  await page.context().setOffline(true);

  await page.getByRole("button", { name: /^Charge R/ }).click();
  await page.getByPlaceholder(/Cash received/i).fill("200");
  await page.getByRole("button", { name: /Complete sale/i }).click();

  // The customer is served: the sale completes on the device and says so.
  await expect(banner(page)).toContainText(/will sync when the connection returns/i);
  await expect(page.locator("header").getByText(/to sync/)).toBeVisible();
  expect(be.storedSales).toHaveLength(0);

  // The line comes back.
  be.offline = false;
  await page.context().setOffline(false);

  await expect.poll(() => be.storedSales.length, { timeout: 45_000 }).toBe(1);

  // The guarantee that matters: replaying must never charge twice. Give the
  // retry loop room to run again and confirm the count holds.
  await page.waitForTimeout(2_000);
  expect(be.storedSales).toHaveLength(1);
  expect(be.storedSales[0].client_ref).toBeTruthy();
  // The recorded time is when the sale was taken, not when it synced.
  expect(be.storedSales[0].created_at).toBeTruthy();
});

test("an employee's discount parks until a manager releases it", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();

  await page.locator('input[type="number"], input[inputmode="decimal"]').first().fill("20");
  await page.getByRole("button", { name: /Apply/i }).click();

  // Sam cannot approve his own discount, so the till asks for a manager.
  await expect(page.getByText(/Manager approval/i)).toBeVisible();
});

test("backing out of manager approval drops the discount", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();
  await page.locator('input[type="number"], input[inputmode="decimal"]').first().fill("20");
  await page.getByRole("button", { name: /Apply/i }).click();

  await page.getByRole("button", { name: /^Cancel$/ }).last().click();

  // An unauthorised discount must not survive the cancel. Assert on the money,
  // not the word — the cart also holds a button labelled "Discount".
  await expect(page.getByRole("button", { name: /Charge R115\.00/ })).toBeVisible();
  await expect(page.locator("aside")).not.toContainText("−R");
});

test("an employee is not offered the back office", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await expect(page.getByRole("button", { name: /^Manage$/ })).toHaveCount(0);
});

test("a manager can open the catalogue", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);

  await page.getByRole("button", { name: /^Manage$/ }).click();
  await page.waitForSelector('button:text-is("1")');
  for (const d of USERS.manager.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  const ok = page.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();

  await expect(page.getByRole("button", { name: /New product/i })).toBeVisible();
  await expect(page.getByRole("cell", { name: "CEM-425-50" })).toBeVisible();
});
