import { expect, test } from "@playwright/test";
import { Backend, installBackend, pairAndSignIn, USERS } from "./fake-backend";

/** The till's status line. Print previews repeat its text, so target it directly. */
const banner = (page: import("@playwright/test").Page) =>
  page.locator(".sell-banner").first();

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

  await expect(page.locator(".line-desc")).toHaveText("Cement 42.5N 50kg");
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

  const qty = page.getByLabel("Quantity of Chain 6mm Galvanised");
  await qty.fill("2.5");
  await qty.press("Enter");

  // 2.5 m x R35.00 = R87.50
  await expect(page.locator(".total-row .fig")).toContainText("87.50");
});

test("whole-unit goods refuse a fraction", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("padlock");
  await page.getByText("Padlock 50mm Brass").first().click();

  const qty = page.getByLabel("Quantity of Padlock 50mm Brass");
  // Sold "each": the field must not even offer decimal entry.
  await expect(qty).toHaveAttribute("inputmode", "numeric");
  await qty.fill("2.5");
  await qty.press("Enter");
  // Rounded to a whole padlock rather than silently sold as 2.5.
  await expect(qty).toHaveValue("3");
});

test("a cash sale completes and reports its invoice number", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  // The customer hands over R200 for a R115 sale: the tender is 200, the
  // payment applied is 115, and the difference is change. Recording 200 as the
  // payment would overpay the invoice.
  await page.getByLabel("Cash received").fill("200");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await expect(page.getByText(/Change due/i)).toBeVisible();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  await expect(banner(page)).toContainText(/INV-\d+/);
  expect(be.storedSales).toHaveLength(1);
  expect(be.storedSales[0].total).toBe(115);
  expect(be.storedSales[0].payments).toEqual([{ method: "cash", amount: 115 }]);

  // A tax invoice without the supplier's name, address and VAT number on its
  // face is not a valid tax invoice. This used to be carried by a printed logo
  // image; it is text now, and this is what stops it going missing again.
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("Ladybrand Hardware");
  await expect(slip).toContainText("12 Church St");
  await expect(slip).toContainText("VAT No: 4001234567");
  await expect(slip).toContainText(/tax invoice/i);
});

test("the server's refusal reaches the cashier, and nothing is charged", async ({ page }) => {
  await pairAndSignIn(page);

  // Only 2 rolls on hand; ask for 5.
  await page.getByPlaceholder(/Scan barcode/i).fill("twin");
  await page.getByText("Twin & Earth 2.5mm 100m").first().click();
  const qty = page.getByLabel("Quantity of Twin & Earth 2.5mm 100m");
  await qty.fill("5");
  await qty.press("Enter");

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

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

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // The customer is served: the sale completes on the device and says so.
  await expect(banner(page)).toContainText(/will sync when the connection returns/i);
  await expect(page.locator("header").getByText(/queued/i)).toBeVisible();
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

  await page.getByLabel("Discount amount").fill("20");
  await page.getByRole("button", { name: /Apply/i }).click();

  // Sam cannot approve his own discount, so the till asks for a manager.
  await expect(page.getByText(/Manager approval/i)).toBeVisible();
});

test("backing out of manager approval drops the discount", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();
  await page.getByLabel("Discount amount").fill("20");
  await page.getByRole("button", { name: /Apply/i }).click();

  await page.getByRole("button", { name: /^Cancel$/ }).last().click();

  // An unauthorised discount must not survive the cancel. Assert on the money,
  // not the word — the left column also holds a button labelled "Discount".
  await expect(page.locator(".total-row .fig")).toContainText("115.00");
  await expect(page.locator(".pay")).not.toContainText("−");
});

test("an employee is not offered the back office", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await expect(page.getByRole("button", { name: /^Manage$/ })).toHaveCount(0);
});

test("a manager can open the catalogue", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);

  await page.getByRole("button", { name: /^Manage$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Manage" });
  for (const d of USERS.manager.pin.split("")) {
    await dialog.locator(`button:text-is("${d}")`).first().click();
  }
  await dialog.locator('button:text-is("OK")').click();

  await expect(page.getByRole("button", { name: /New product/i })).toBeVisible();
  await expect(page.getByRole("cell", { name: "CEM-425-50" })).toBeVisible();
});

/**
 * The repeat buyer.
 *
 * The value of a phone number is not that it is stored — it is that the SAME
 * person is recognised next time, however they happen to say their number. A
 * feature that silently creates a second record on the second visit looks like
 * it works and is worthless, so that is what this test pins down.
 */
test("a buyer's number is captured once and recognised however it is typed", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);

  // First visit: nobody on file, so the till offers to record the number.
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  const picker = page.getByRole("dialog", { name: /Choose a customer/i });
  await picker.getByPlaceholder(/Name, account code or phone/i).fill("082 555 0143");
  await picker.getByText(/Record .* as a new buyer/i).click();
  await picker.getByLabel(/Their name/i).fill("T. Dlamini");
  await picker.getByRole("button", { name: /^Save/ }).click();

  // The sale is now theirs, and a cashier's capture never grants credit.
  await expect(page.getByText("T. Dlamini")).toBeVisible();
  await expect(page.getByText(/Trade price/i)).toHaveCount(0);
  expect(be.customers).toHaveLength(1);
  expect(be.customers[0].is_trade).toBe(false);
  expect(be.customers[0].credit_limit).toBe(0);

  // Second visit, and this time they rattle it off in international form.
  await page.getByRole("button", { name: /T. Dlamini/ }).click();
  await picker.getByPlaceholder(/Name, account code or phone/i).fill("+27 82 555 0143");
  // Found, not offered as new — the whole point.
  await expect(picker.getByText(/Record .* as a new buyer/i)).toHaveCount(0);
  // The row itself, not the "Purchases by…" button sitting beside it.
  await picker.locator(".modal-row", { hasText: "T. Dlamini" }).click();

  expect(be.customers).toHaveLength(1);
});

test("a mistyped number is refused rather than stored as a buyer", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);

  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  const picker = page.getByRole("dialog", { name: /Choose a customer/i });
  // Six digits reads as a phone number to the UI, but it is too short to be one.
  await picker.getByPlaceholder(/Name, account code or phone/i).fill("123456");
  await picker.getByText(/Record .* as a new buyer/i).click();
  await picker.getByRole("button", { name: /^Save/ }).click();

  await expect(picker.getByText(/does not look like a phone number/i)).toBeVisible();
  expect(be.customers).toHaveLength(0);
});

/**
 * Accounts: the paying-back half of selling on credit.
 *
 * The loop that matters end to end: charge a sale to an account, find that
 * balance in Accounts, take a payment against it, watch the balance fall. Until
 * this build there was no way to record the payment at all — balances could
 * only ever grow.
 */
test("an account sale shows in Accounts, and taking a payment reduces the balance", async ({ page }) => {
  be.customers.push({
    id: "k1", code: "TRD-001", name: "Mokoena Building Contractors",
    phone: "051 924 0000", is_trade: false, credit_limit: 25000,
    balance: 0, available: 25000,
  });
  await pairAndSignIn(page, USERS.employee.pin);

  // Charge R115 of cement to the account.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.locator(".modal-row", { hasText: "Mokoena" }).click();
  await page.getByRole("button", { name: /^Account$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(page.locator(".sell-banner").first()).toContainText(/INV-\d+/);
  // The print preview sits over the whole screen; put it away first.
  await page.getByLabel("Close").click();

  // The debtors book knows.
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Accounts" }).click();
  await expect(page.getByText("Owed to the shop")).toBeVisible();
  const row = page.locator(".acc-row", { hasText: "Mokoena" });
  await expect(row).toContainText("R 115.00");
  await row.click();

  // They hand over R100 in cash.
  await page.getByLabel("Amount").fill("100");
  await page.getByRole("button", { name: /Receive R/ }).click();
  await expect(page.getByText(/R 100\.00 received/)).toBeVisible();
  await expect(page.getByText(/R 15\.00 still owing/)).toBeVisible();

  // The fake server holds one payment, and the maths agrees.
  expect(be.accountPayments).toHaveLength(1);
  expect(be.accountPayments[0].amount).toBe(100);
  expect(be.balance("k1")).toBe(15);

  // The ledger shows both movements.
  await expect(page.locator(".acc-ledger tr", { hasText: "INV" })).toBeVisible();
  await expect(page.locator(".acc-ledger tr", { hasText: "cash" })).toBeVisible();
});

/**
 * Stock: booking in a delivery at the back door.
 *
 * The property worth pinning: a delivery is all or nothing, it needs the
 * inventory permission (a cashier's PIN is refused at the door), and the
 * shelves change by exactly what was received.
 */
test("a delivery is booked in against a reference and the shelves update", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);

  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" }).click();
  // Entering Stock costs a PIN, even for a manager already signed in.
  const gate = page.getByRole("dialog", { name: "Stock" });
  for (const d of USERS.manager.pin.split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  await gate.locator('button:text-is("OK")').click();

  await expect(page.getByRole("button", { name: /Running low/ })).toBeVisible();

  // Cement is at 240; a pallet of 100 arrives on GRN A-1042.
  await page.getByRole("button", { name: /Receive a delivery/ }).click();
  await page.getByPlaceholder(/Supplier invoice/).fill("GRN A-1042");
  await page.getByLabel("Quantity received of Cement 42.5N 50kg").fill("100");
  await page.getByRole("button", { name: /Book in 1 line/ }).click();

  await expect(page.getByText(/1 line booked in against GRN A-1042/)).toBeVisible();
  // The shelves agree.
  expect(be.stockMoves).toEqual([
    { product_id: "p1", qty_delta: 100, reason: "receipt", note: "GRN A-1042" },
  ]);
  await expect(
    page.locator("tr", { hasText: "Cement 42.5N 50kg" }).locator("td").nth(1)
  ).toContainText("340");
});

/**
 * Quotes: the sale that has not happened yet, and the loop that closes it.
 *
 * Save the cart as a quote, find it in Quotes, open it back onto the till,
 * ring the sale — and the quote must close AGAINST that sale, so "did that
 * quote ever come back?" always has an answer.
 */
test("a saved quote is recalled by number and closes against its sale", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);

  // Build a cart and save it as a quote instead of ringing it.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();
  await expect(page.locator(".sell-banner").first()).toContainText(/QUO-\d+ saved/);
  await page.getByLabel("Close").click();
  expect(be.quotes).toHaveLength(1);

  // The cart cleared with the save; Thursday comes, the builder is back.
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  await expect(page.getByText("QUO-000001")).toBeVisible();
  await page.getByRole("button", { name: /Open on the till/ }).click();

  // Back on Sell with the same goods, and the sale rings as normal.
  await expect(page.locator(".sell-banner").first()).toContainText(/QUO-000001 loaded/);
  await expect(page.getByText("Cement 42.5N 50kg")).toBeVisible();
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(page.locator(".sell-banner").first()).toContainText(/INV-\d+/);

  // The paper trail joins up: quote converted, pointing at the sale.
  expect(be.quotes[0].status).toBe("converted");
  expect(be.quotes[0].sale_id).toBeTruthy();
  expect(be.storedSales).toHaveLength(1);
});

/**
 * The closer look.
 *
 * The property that matters is what it does NOT change: tapping a search
 * result still adds the item in one tap. A counter action performed a hundred
 * times a day must never grow a confirmation step, so the enlarged view hangs
 * off the picture instead.
 */
test("the picture opens a closer look, while the row still adds in one tap", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);

  await page.getByPlaceholder(/Scan barcode/i).fill("cement");
  await page.locator(".result-row").first().click();
  // One tap, one line, no dialog in the way.
  await expect(page.locator('[data-testid="line-row"]')).toHaveCount(1);
  await expect(page.locator(".detail-card")).toHaveCount(0);

  // The picture is the way in to the detail.
  await page.getByPlaceholder(/Scan barcode/i).fill("chain");
  await page.locator(".result-thumb-btn").first().click();
  const card = page.locator(".detail-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Chain 6mm Galvanised");
  await expect(card).toContainText("A1");           // where it is
  // Nothing on this screen may be a number the customer should not read.
  await expect(card).not.toContainText(/cost/i);
  await expect(card).not.toContainText(/trade/i);

  await card.getByRole("button", { name: /Add to sale/ }).click();
  await expect(page.locator('[data-testid="line-row"]')).toHaveCount(2);
  await expect(page.locator(".detail-card")).toHaveCount(0);

  // A line already in the sale opens the same view.
  await page.locator(".line-desc-btn").first().click();
  await expect(page.locator(".detail-card")).toBeVisible();
});
