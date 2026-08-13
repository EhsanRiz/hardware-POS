import { expect, test } from "@playwright/test";
import { Backend, installBackend, pairAndSignIn, USERS } from "./fake-backend";

/** The till's status line. Print previews repeat its text, so target it directly. */
const banner = (page: import("@playwright/test").Page) =>
  page.locator(".sell-banner").first();

/**
 * Add an item the way a described (as opposed to scanned) item is added:
 * search, open the closer look, settle the quantity, add.
 */
async function addBySearch(
  page: import("@playwright/test").Page,
  term: string,
  name: string,
  qty?: string
) {
  await page.getByPlaceholder(/Scan barcode/i).fill(term);
  await page.locator(".result-row", { hasText: name }).first().click();
  const card = page.locator(".detail-card");
  await expect(card).toBeVisible();
  if (qty !== undefined) await card.getByLabel(`How many ${name}`).fill(qty);
  await card.getByRole("button", { name: /Add to sale/ }).click();
  await expect(card).toHaveCount(0);
}

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

  // 2.5 m is settled in the closer look, before the line exists.
  await addBySearch(page, "chain", "Chain 6mm Galvanised", "2.5");

  // 2.5 m x R35.00 = R87.50
  await expect(page.locator(".total-row .fig")).toContainText("87.50");
});

test("whole-unit goods refuse a fraction", async ({ page }) => {
  await pairAndSignIn(page);

  await addBySearch(page, "padlock", "Padlock 50mm Brass");

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

test("counting the notes after tapping Cash still gives change", async ({ page }) => {
  await pairAndSignIn(page);

  // The other order round, and the more natural one: pick the tender, then
  // count what is in your hand. Cash with nothing typed settles the sale, so
  // every tender button goes dead — and the figure typed next used to sit in a
  // box that no longer did anything. The slip said no change was owed and the
  // customer's R55 was never mentioned.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: /^Cash$/ }).click();
  const change = page.locator(".taken-row.is-outstanding");
  await expect(change).toContainText(/Change due/i);
  await expect(change).toContainText("0.00");

  await page.getByLabel("Cash received").fill("200");
  // Live, without pressing anything further: there is nothing left to press.
  await expect(change).toContainText("85.00");

  await page.getByRole("button", { name: /Tender & print/i }).click();

  // The payment is still the sale, not the note. What the note changes is the
  // tendered figure the server takes the change from.
  expect(be.storedSales[0].payments).toEqual([{ method: "cash", amount: 115 }]);
  expect(be.storedSales[0].amount_tendered).toBe(200);
  expect(be.storedSales[0].change_due).toBe(85);
  await expect(page.locator("#print-area")).toContainText("Change");
});

test("a stray figure in the amount box invents no change on a card sale", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Card$/ }).click();

  // Left over from a previous customer, or a mis-tap. No cash is in this sale,
  // so there is nothing for the drawer to give back.
  await page.getByLabel("Cash received").fill("500");
  await expect(page.locator(".taken-row.is-outstanding")).toContainText("0.00");

  await page.getByRole("button", { name: /Tender & print/i }).click();
  expect(be.storedSales[0].amount_tendered).toBeNull();
});

test("the server's refusal reaches the cashier, and nothing is charged", async ({ page }) => {
  await pairAndSignIn(page);

  // Only 2 rolls on hand; ask for 5. The closer look warns, but selling short
  // is the shop's call to make — the server is the one that refuses.
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "5");

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  // The till asks before it sends; the shop decides to sell it anyway.
  await page.getByRole("button", { name: /Sell short/ }).click();

  // The server's reason must reach the cashier, not a generic refusal.
  await expect(banner(page)).toContainText(/Not enough stock/i);
  expect(be.storedSales).toHaveLength(0);
});

/**
 * Selling more than the shelf count.
 *
 * The till must not refuse it — a yard genuinely holds stock the count has lost
 * track of, and refusing the money for goods the shop is standing next to is
 * worse than asking. But it must not let it happen by accident either, and the
 * cashier's last sight of the shortfall was a red number on a line they have
 * since scrolled past.
 *
 * The case that decides the design is the one BELOW: offline, there is no
 * server to refuse it, the slip prints, and the customer leaves with the goods.
 * This question is the only thing standing between a mistyped 5 and a sale
 * nobody catches until it fails to sync hours later.
 */
test("selling short is asked about at the tender, and the answer is not remembered", async ({ page }) => {
  await pairAndSignIn(page);

  // Two rolls on hand; the cashier types five.
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "5");

  // Restated where the money is taken, not only on the line.
  await expect(page.locator(".pay-short")).toContainText("2 roll on hand, selling 5");

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  const ask = page.getByRole("dialog", { name: /shelf count/i });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("2 roll on hand");
  await expect(ask).toContainText("3 short");

  // Backing out sends nothing and charges nothing.
  await ask.getByRole("button", { name: /Go back/ }).click();
  await expect(ask).toHaveCount(0);
  expect(be.storedSales).toHaveLength(0);

  // Dismissing is not answering. Pressing Tender again asks again — otherwise a
  // stray tap on the backdrop would buy a permanent licence to sell short.
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: /Go back/ }).click();

  // Correcting the quantity retires the question. The cash taken for five rolls
  // no longer settles two, so it comes off and is taken again — which is what
  // happens at the counter when a cashier fixes a line after tendering.
  await page.getByRole("button", { name: "Remove Cash payment" }).click();
  const qty = page.getByLabel("Quantity of Twin & Earth 2.5mm 100m");
  await qty.fill("2");
  await qty.press("Enter");
  await expect(page.locator(".pay-short")).toHaveCount(0);

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(ask).toHaveCount(0);
  await expect(banner(page)).toContainText(/INV-\d+/);
  expect(be.storedSales).toHaveLength(1);
});

test("offline, nothing but the question stands between a mistyped quantity and an over-sale", async ({ page }) => {
  await pairAndSignIn(page);

  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "5");

  // The line goes down. There is no server to refuse this now.
  be.offline = true;
  await page.context().setOffline(true);

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // Asked offline too — this is the case that needs it most.
  const ask = page.getByRole("dialog", { name: /shelf count/i });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: /Sell short/ }).click();

  // Deliberate, and therefore allowed: the sale completes on the device.
  await expect(banner(page)).toContainText(/will sync when the connection returns/i);
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
 * "Put it on my account", said after the goods are rung up.
 *
 * The cashier does not know every builder by sight, so the sale is a walk-in
 * until the moment it isn't. Account must therefore be a live button on a
 * walk-in sale — it asks who — rather than a dead one that leaves the cashier
 * hunting for the customer selector at the top of a different column.
 */
test("Account asks who, then charges the account, on a sale that began as a walk-in", async ({ page }) => {
  be.customers.push({
    id: "k2", code: "TRD-002", name: "Nkosi Plumbing",
    phone: "051 924 1111", is_trade: false, credit_limit: 25000,
    balance: 0, available: 25000,
  });
  await pairAndSignIn(page, USERS.employee.pin);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  // Still a walk-in: Account is offered, and it opens the picker.
  await expect(page.getByRole("button", { name: /Walk-in customer/i })).toBeVisible();
  const account = page.getByRole("button", { name: /^Account$/ });
  await expect(account).toBeEnabled();
  await account.click();
  await page.locator(".modal-row", { hasText: "Nkosi" }).click();

  // Named now — the second press puts the money on the account.
  await account.click();
  await expect(page.locator(".taken-row", { hasText: "Account" })).toContainText("R 115.00");
  await page.getByRole("button", { name: /Tender & print/i }).click();

  await expect(banner(page)).toContainText(/INV-\d+/);
  expect(be.storedSales).toHaveLength(1);
  expect(be.storedSales[0].payments).toEqual([{ method: "account", amount: 115 }]);
  expect(be.balance("k2")).toBe(115);
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
 * The closer look, which is where a described item is chosen and counted.
 *
 * Two properties matter. A search result opens rather than adds — "is that the
 * one?" and "how many?" are asked in the same breath, and answering both before
 * the line exists beats adding one and correcting it. And a SCAN still rings
 * straight through: the gun types a code and presses Enter, and no dialog may
 * ever stand in front of the hundred-times-a-day path.
 */
test("a search result opens the closer look, and the quantity is settled there", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);

  await page.getByPlaceholder(/Scan barcode/i).fill("chain");
  await page.locator(".result-row").first().click();
  const card = page.locator(".detail-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Chain 6mm Galvanised");
  await expect(card).toContainText("A1");           // where it is
  // Nothing on this screen may be a number the customer should not read.
  await expect(card).not.toContainText(/cost/i);
  await expect(card).not.toContainText(/trade/i);
  // Nothing is in the sale until it is added.
  await expect(page.locator('[data-testid="line-row"]')).toHaveCount(0);

  // Four metres of chain at R35.00, decided here rather than corrected after.
  await card.getByLabel("How many Chain 6mm Galvanised").fill("4");
  await card.getByRole("button", { name: /Add to sale · R.*140\.00/ }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('[data-testid="line-row"]')).toHaveCount(1);
  await expect(page.getByLabel("Quantity of Chain 6mm Galvanised")).toHaveValue("4");
  // The query is cleared, because the field must be ready for the next scan.
  await expect(page.getByPlaceholder(/Scan barcode/i)).toHaveValue("");

  // A scan is not a choice: it rings through with no dialog in the way.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="line-row"]')).toHaveCount(2);
  await expect(card).toHaveCount(0);

  // A line already in the sale opens the same view — to CORRECT the quantity,
  // not to add a second helping of what is already there.
  await page.locator(".line-desc-btn").first().click();
  await expect(card).toBeVisible();
  await card.getByLabel("How many Chain 6mm Galvanised").fill("6");
  await card.getByRole("button", { name: /Update sale · R.*210\.00/ }).click();
  await expect(page.locator('[data-testid="line-row"]')).toHaveCount(2);
  await expect(page.getByLabel("Quantity of Chain 6mm Galvanised")).toHaveValue("6");
});
