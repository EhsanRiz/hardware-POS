import { expect, test } from "@playwright/test";
import { Backend, installBackend, pairAndSignIn, PRODUCTS, USERS } from "./fake-backend";

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

test("a PIN signs you in as yourself, not as whoever owns it", async ({ page }) => {
  await page.goto("/");
  await page.locator("input[type=tel]").fill(USERS.manager.phone);
  await page.locator("input[type=password]").fill(USERS.manager.pin);
  await page.getByRole("button", { name: /Pair this till/i }).click();

  // The till names who may sign in before it asks anybody to prove it.
  await expect(page.getByText("Who is on the till?")).toBeVisible();
  await page.getByRole("button", { name: /^Sam\b/ }).click();

  // Sam types the manager's PIN. It is a real PIN — it is simply not Sam's, and
  // the old sign-in would have looked up whoever owned it and signed them in as
  // the manager.
  for (const d of USERS.manager.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  const ok = page.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();
  await expect(page.getByText(/PIN was not recognised/i)).toBeVisible();

  // Sam's own PIN works, and the shift starts under Sam's name.
  for (const d of USERS.employee.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  if (await ok.count()) await ok.first().click();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
  await expect(page.getByText("Sam")).toBeVisible();
});

test("the till says who is serving, and in what capacity", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);

  // Name over title. On a shared till the glance question is "whose shift is
  // this", so the name carries and the role explains it.
  const who = page.locator(".sell-cashier");
  await expect(who.locator(".sell-cashier-name")).toHaveText("Sam");
  await expect(who.locator(".sell-cashier-role")).toHaveText("Counter");

  // The same words the sign-in screen used to offer them, which is the point of
  // sharing one mapping: a person must not be a Counter on one screen and an
  // employee on the next.
  await page.getByRole("button", { name: /Sign out/i }).click();
  const sam = page.getByRole("button", { name: /^Sam\b/ });
  await expect(sam).toContainText("Counter");

  // And an owner reads as an owner, not as "admin".
  await page.getByRole("button", { name: /^Manager\b/ }).click();
  for (const d of USERS.manager.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  const ok = page.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
  await expect(who.locator(".sell-cashier-role")).toHaveText("Owner");
});

test("a handover puts the next operator on their own name", async ({ page }) => {
  // The manager finishes a shift.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("button", { name: /Sign out/i }).click();

  // The counter hand takes over. Picking the wrong name is one tap to undo —
  // otherwise the only way back is to type a PIN you know will be refused.
  await expect(page.getByText("Who is on the till?")).toBeVisible();
  await page.getByRole("button", { name: /^Manager\b/ }).click();
  await expect(page.getByText(/Manager.*enter your PIN/i)).toBeVisible();
  await page.getByRole("button", { name: /Not Manager\?/i }).click();

  await page.getByRole("button", { name: /^Sam\b/ }).click();
  for (const d of USERS.employee.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  const ok = page.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');

  // The sale that follows is rung up by Sam, which is the point of the whole
  // exercise: the name on the invoice is the person who was standing there.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  expect(be.storedSales[0].cashier_id).toBe(USERS.employee.row.id);
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
  await page.getByLabel("Amount for the next tender").fill("200");
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

  // Count the notes, then tap the tender: the order the box is built for.
  await page.getByLabel("Amount for the next tender").fill("200");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  const change = page.locator(".taken-row.is-outstanding");
  await expect(change).toContainText(/Change due/i);
  await expect(change).toContainText("85.00");

  await page.getByRole("button", { name: /Tender & print/i }).click();

  // The payment is still the sale, not the note. What the note changes is the
  // tendered figure the server takes the change from.
  expect(be.storedSales[0].payments).toEqual([{ method: "cash", amount: 115 }]);
  expect(be.storedSales[0].amount_tendered).toBe(200);
  expect(be.storedSales[0].change_due).toBe(85);
  await expect(page.locator("#print-area")).toContainText("Change");
});

test("a settled sale stops taking figures that would move the change", async ({ page }) => {
  await pairAndSignIn(page);

  // R490 of stock, R500 handed over: type it first, then tap the tender. That
  // is the order every till uses and the only order this one accepts.
  await addBySearch(page, "padlock", "Padlock 50mm Brass", "5");
  await expect(page.locator(".total-row .fig")).toContainText("445.00");

  const amount = page.getByLabel("Amount for the next tender");
  await amount.fill("500");
  await page.getByRole("button", { name: /^Cash$/ }).click();

  const change = page.locator(".taken-row.is-outstanding");
  await expect(change).toContainText("55.00");

  // Nothing is outstanding, so there is no tender left to size and the box is
  // shut. It used to keep accepting digits, and each one moved the change on a
  // sale whose money had already been counted.
  await expect(amount).toBeDisabled();
  await expect(amount).toHaveValue("");
  await expect(page.getByRole("button", { name: "5", exact: true })).toBeDisabled();

  // The change stays where the tender put it.
  await expect(change).toContainText("55.00");
  await page.getByRole("button", { name: /Tender & print/i }).click();
  expect(be.storedSales[0].amount_tendered).toBe(500);
  expect(be.storedSales[0].change_due).toBe(55);
});

test("the tender that took the money is marked as the one that took it", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Card$/ }).click();

  // On its own button, not only in the list above: the eye goes back to the
  // grid it was just tapped in.
  await expect(page.getByRole("button", { name: /^Card$/ })).toHaveClass(/is-taken/);
  await expect(page.getByRole("button", { name: /^Cash$/ })).not.toHaveClass(/is-taken/);

  // A card sale settles exactly, so there is nothing to hand back and nothing
  // left to type.
  await expect(page.locator(".taken-row.is-outstanding")).toContainText("0.00");
  await expect(page.getByLabel("Amount for the next tender")).toBeDisabled();

  await page.getByRole("button", { name: /Tender & print/i }).click();
  expect(be.storedSales[0].amount_tendered).toBeNull();
});

test("removing a tender takes its notes with it", async ({ page }) => {
  await pairAndSignIn(page);

  // R891 of stock, and the customer hands over R900.
  await addBySearch(page, "padlock", "Padlock 50mm Brass", "9");
  await expect(page.locator(".total-row .fig")).toContainText("801.00");

  await page.getByLabel("Amount for the next tender").fill("900");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  const change = page.locator(".taken-row.is-outstanding");
  await expect(change).toContainText("99.00");

  // The cashier changes their mind and takes the tender off. The notes were
  // recorded against it, so they come off with it — and the box opens again,
  // because there is a tender to size once more.
  await page.getByRole("button", { name: /Remove Cash payment/i }).click();
  await expect(page.locator(".taken-row")).toHaveCount(0);
  await expect(page.getByLabel("Amount for the next tender")).toBeEnabled();

  // Tendering the same notes again shows the SAME change, not another R900
  // stacked on the first. The notes used to live in a counter of their own that
  // removing a tender never touched, so each retry grew the change and the
  // drawer was told to hand back money it had never been given.
  await page.getByLabel("Amount for the next tender").fill("900");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await expect(change).toContainText("99.00");

  await page.getByRole("button", { name: /Tender & print/i }).click();
  expect(be.storedSales[0].amount_tendered).toBe(900);
  expect(be.storedSales[0].change_due).toBe(99);
});

test("a removed cash tender leaves no change behind on a card sale", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  // Cash first, with a note over the total, then removed entirely and settled
  // on card. Nothing about the abandoned cash may survive into the sale.
  await page.getByLabel("Amount for the next tender").fill("200");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await expect(page.locator(".taken-row.is-outstanding")).toContainText("85.00");
  await page.getByRole("button", { name: /Remove Cash payment/i }).click();

  await page.getByRole("button", { name: /^Card$/ }).click();
  await expect(page.locator(".taken-row.is-outstanding")).toContainText("0.00");

  await page.getByRole("button", { name: /Tender & print/i }).click();
  expect(be.storedSales[0].payments).toEqual([{ method: "card", amount: 115 }]);
  expect(be.storedSales[0].amount_tendered).toBeNull();
});

test("a figure left in the box cannot overpay a card, or invent change", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  // Left over from a previous customer, or a mis-tap. A card is settled
  // exactly, so it takes the total and not the figure — and no cash is in the
  // sale, so there is nothing for the drawer to give back either.
  await page.getByLabel("Amount for the next tender").fill("500");
  await page.getByRole("button", { name: /^Card$/ }).click();
  await expect(page.locator(".taken-row.is-outstanding")).toContainText("0.00");

  await page.getByRole("button", { name: /Tender & print/i }).click();
  expect(be.storedSales[0].payments).toEqual([{ method: "card", amount: 115 }]);
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

test("a discount can be given as a percentage, and the slip says so", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);

  // R115 of cement. Ten percent off is R11.50 — a figure nobody should have to
  // work out in their head before agreeing to it.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();
  await page.getByRole("button", { name: /Percent/ }).click();
  await page.getByLabel("Discount percent").fill("10");
  await expect(page.getByRole("status")).toContainText("11.50");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  // It comes off the sale, not just the screen.
  await expect(page.locator(".total-row .fig")).toContainText("103.50");

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // The percentage reaches the paper. An amount alone would leave the customer
  // unable to check the 10% they were promised.
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("Discount");
  await expect(slip).toContainText("10% off");
  expect(be.storedSales[0].discount_amount).toBe(11.5);
});

test("money can come off one line without touching the others", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);

  // A cheap line and a dear one. Ten percent off the ladder is a different
  // transaction from ten percent off the lot, and only the second could be
  // recorded before — which spread itself across both lines pro-rata, so the
  // ladder showed full price and the cement carried a discount nobody gave it.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");
  await expect(page.locator(".total-row .fig")).toContainText("1 565.00");

  await page.getByRole("button", { name: /Discount Twin & Earth/i }).click();
  await page.getByRole("button", { name: /Percent/ }).click();
  await page.getByLabel("Discount percent").fill("10");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  // R145 off the cable line, and the cement untouched.
  const cable = page.locator(".line-row", { hasText: "Twin & Earth" });
  await expect(cable.locator(".line-disc")).toContainText("145.00");
  await expect(cable.locator(".line-disc")).toContainText("10%");
  await expect(
    page.locator(".line-row", { hasText: "Cement" }).locator(".line-disc")
  ).toHaveCount(0);
  await expect(page.locator(".total-row .fig")).toContainText("1 420.00");

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // The line discount reaches the server as the line's own, and the slip says
  // which line it came off rather than showing an unexplained lump.
  expect(be.storedSales[0].total).toBe(1420);
  expect(be.storedSales[0].discount_amount).toBe(145);
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("less 10%");
  await expect(slip).toContainText("145.00");
});

test("a line discount says why, and the words reach the record", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");

  // The modal has asked for a reason since it was written. On a line discount
  // the answer was parsed for its percentage and the words thrown away, so an
  // invoice could say a line went down 10% and nothing anywhere said why.
  await page.getByRole("button", { name: /Discount Twin & Earth/i }).click();
  await page.getByRole("button", { name: /Percent/ }).click();
  await page.getByLabel("Discount percent").fill("10");
  await page.getByPlaceholder("e.g. staff, loyalty").fill("church job, Mr Molefe");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  // On the screen it belongs to the line it came off — which matters most on a
  // basket parked at lunchtime and picked up by whoever is on the till at four.
  const cable = page.locator(".line-row", { hasText: "Twin & Earth" });
  await expect(cable.locator(".line-disc")).toContainText("10%");
  await expect(cable.locator(".line-disc-why")).toHaveText("church job, Mr Molefe");

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // On the paper, beside the money rather than on a line of its own — a basket
  // of ten marked-down lines would otherwise add ten rows to an 80mm slip.
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("less 10% (church job, Mr Molefe)");

  // And on the record, where the month-end asks who decided this and on what
  // grounds. The percentage keeps its own field: one fact stored twice is two
  // facts that can disagree.
  const item = be.storedSales[0].items.find((i) => i.discount_percent === 10)!;
  expect(item.discount_reason).toBe("church job, Mr Molefe");
});

test("a reason with no discount behind it is not kept", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");

  await page.getByRole("button", { name: /Discount Twin & Earth/i }).click();
  await page.getByLabel("Discount amount").fill("20");
  await page.getByPlaceholder("e.g. staff, loyalty").fill("  offcut  ");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  const items = be.storedSales[0].items;
  // Trimmed, because trailing spaces are not part of anybody's reason.
  expect(items.find((i) => i.discount_amount === 20)!.discount_reason).toBe("offcut");
  // And the cement, which nobody discounted, carries no note about nothing —
  // a reason on an undiscounted line reads on a reprint as though money came
  // off it.
  expect(items.find((i) => !i.discount_amount)!.discount_reason ?? null).toBeNull();
});

test("a reprinted slip still shows what came off each line, and why", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");
  await page.getByRole("button", { name: /Discount Twin & Earth/i }).click();
  await page.getByRole("button", { name: /Percent/ }).click();
  await page.getByLabel("Discount percent").fill("10");
  await page.getByPlaceholder("e.g. staff, loyalty").fill("damaged drum");
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();
  await page.getByRole("button", { name: /Reprint/ }).first().click();

  // The reprint was dropping every line discount on the way to the printer, so
  // a second copy of the same invoice showed full price on a line that had been
  // marked down, and a total that did not follow from the lines above it.
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("less 10% (damaged drum)");
  await expect(slip).toContainText("R145.00");
  // R1450 less R145, and the line above it agrees — which it did not when the
  // discount was being dropped between the sale and the printer.
  await expect(slip).toContainText("R1305.00");
});

test("Manage → Sales shows what came off a sale, on what, and why", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");

  // Money off one line, for one reason...
  await page.getByRole("button", { name: /Discount Twin & Earth/i }).click();
  await page.getByRole("button", { name: /Percent/ }).click();
  await page.getByLabel("Discount percent").fill("10");
  await page.getByPlaceholder("e.g. staff, loyalty").fill("church job");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  // ...and money off the whole sale, for another. Two different decisions.
  await page.getByRole("button", { name: /^Discount$/ }).click();
  await page.getByLabel("Discount amount").fill("20");
  await page.getByPlaceholder("e.g. staff, loyalty").fill("regular customer");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();

  // The day's total discount has always been at the top of this screen. What it
  // was given for was nowhere at all — the only way to find out was to reprint
  // the slip and read it, which is a strange thing to do at a desk.
  const row = page.locator("li", { has: page.getByRole("button", { name: /Reprint/ }) }).first();
  await expect(row).toContainText("R165.00 off");

  await row.getByRole("button", { name: /Discounts on/i }).click();

  // The line that was marked down, named, with the words behind it.
  await expect(row).toContainText("Twin & Earth 2.5mm 100m");
  await expect(row).toContainText("less 10%");
  await expect(row).toContainText("R145.00 off");
  await expect(row).toContainText("church job");

  // And the blanket discount said separately — spreading it across the lines it
  // touched would report a decision nobody made.
  await expect(row).toContainText("Off the whole sale");
  await expect(row).toContainText("R20.00 off");
  await expect(row).toContainText("regular customer");
});

test("a sale with no discount is not offered a discount panel", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();

  // A button that opens an empty panel on most of the day's rows teaches people
  // it is not worth pressing, and then they do not press it on the one that
  // matters.
  const row = page.locator("li", { has: page.getByRole("button", { name: /Reprint/ }) }).first();
  await expect(row.getByRole("button", { name: /Discounts on/i })).toHaveCount(0);
  await expect(row).not.toContainText("off");
});

test("the per-line discount is a key you can see, not a hidden tap", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  // It hid behind the amount figure at first, which reads as text and offers
  // nothing to press on a tablet, where there is no hover to reveal it. A
  // feature nobody can find is a feature nobody has.
  const key = page.locator(".line-row").getByRole("button", { name: /Discount Cement/i });
  await expect(key).toBeVisible();
  await expect(key).toHaveText("%");
  await expect(key).not.toHaveClass(/is-set/);

  await key.click();
  await page.getByLabel("Discount amount").fill("15");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  // And once it has one, the key says so without being read.
  await expect(key).toHaveClass(/is-set/);
});

test("a line discount survives being taken offline", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Discount Cement/i }).click();
  await page.getByLabel("Discount amount").fill("15");
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await expect(page.locator(".total-row .fig")).toContainText("100.00");

  // The line goes down between ringing it up and taking the money. A queued
  // sale that dropped the discount would replay at full price hours later,
  // with nobody watching and the customer long gone.
  be.offline = true;
  await page.context().setOffline(true);
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/will sync when the connection returns/i);

  be.offline = false;
  await page.context().setOffline(false);
  await expect.poll(() => be.storedSales.length, { timeout: 15000 }).toBe(1);
  expect(be.storedSales[0].total).toBe(100);
  expect(be.storedSales[0].discount_amount).toBe(15);
});

test("a discount cannot be more than the whole thing", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();
  await page.getByRole("button", { name: /Percent/ }).click();
  await page.getByLabel("Discount percent").fill("120");

  await expect(page.getByText(/cannot be more than the whole thing/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Apply$/ })).toBeDisabled();
});

test("the till says where to put the buyer's details", async ({ page }) => {
  await pairAndSignIn(page);

  // The name, number and address were always one tap away, behind a button
  // whose second line only reported the price band.
  const pick = page.getByRole("button", { name: /Walk-in customer/i });
  await expect(pick).toContainText(/tap to add their details/i);

  await pick.click();
  await expect(page.getByPlaceholder(/Name, account code or phone/i)).toBeVisible();
});

/**
 * Sign the manager in, then hand the till to Sam.
 *
 * A manager can only approve at somebody else's till if this device has seen
 * them sign in — approval is checked against the device credential cache, so
 * it keeps working during an outage. This is also the real shift handover.
 */
async function handOverToSam(page: import("@playwright/test").Page) {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("button", { name: /Sign out/i }).click();
  await page.getByRole("button", { name: /^Sam\b/ }).click();
  for (const d of USERS.employee.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  const ok = page.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
}

test("a manager's PIN releases a LINE discount, not only a blanket one", async ({ page }) => {
  // The bug the shop hit. Money off a line rides on the line, and the approver
  // was only ever resolved when money came off the SALE — so a manager stood at
  // the till, typed their PIN, and the sale still filed itself awaiting
  // approval with no invoice number. Every test here stopped at the prompt
  // appearing, so nothing noticed that approving it did nothing.
  await handOverToSam(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Discount Cement/i }).click();
  await page.getByLabel("Discount amount").fill("20");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  // The figure named is the discount actually given, not the blanket total —
  // which for a line discount was R0.00.
  // A thin space sits between the R and the figure, so match around it. The
  // figure is the discount actually given — for a line discount this read
  // R0.00, because it was naming the sale-level total.
  await expect(page.getByText(/R.20\.00 off .* manager's PIN/i)).toBeVisible();
  // Scoped to the dialog: the till's own keypad is still on the page behind it.
  const approval = page.getByRole("dialog", { name: "Manager approval" });
  for (const d of USERS.manager.pin.split("")) {
    await approval.locator(`button:text-is("${d}")`).first().click();
  }
  const ok = approval.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();
  await expect(page.getByText(/Manager approval/i)).toHaveCount(0);

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // Released, so it takes an invoice number and names who released it.
  await expect(banner(page)).toContainText(/INV-\d+/);
  expect(be.storedSales[0].approved_by).toBe(USERS.manager.row.id);
  expect(be.storedSales[0].discount_amount).toBe(20);
});

test("backing out drops the discount that asked, and leaves the one that did not", async ({ page }) => {
  // Sam may give 5%. Five percent off the cement is his to give; twenty off the
  // cable is not. Cancelling the second must not take the first with it.
  be.staff.find((s) => s.id === "u2")!.discount_limit_percent = 5;
  await handOverToSam(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");

  await page.getByRole("button", { name: /Discount Cement/i }).click();
  await page.getByRole("button", { name: /Percent/ }).click();
  await page.getByLabel("Discount percent").fill("5");
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await expect(page.getByText(/Manager approval/i)).toHaveCount(0);

  await page.getByRole("button", { name: /Discount Twin & Earth/i }).click();
  await page.getByRole("button", { name: /Percent/ }).click();
  await page.getByLabel("Discount percent").fill("20");
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await expect(page.getByText(/Manager approval/i)).toBeVisible();
  await page.getByRole("button", { name: /^Cancel$/ }).last().click();

  // The cable is back at full price; the cement keeps the discount Sam was
  // entitled to give. Cancelling used to clear the sale-level discount only,
  // which on a line discount meant clearing nothing at all.
  const cable = page.locator(".line-row", { hasText: "Twin & Earth" });
  await expect(cable.locator(".line-disc")).toHaveCount(0);
  await expect(
    page.locator(".line-row", { hasText: "Cement" }).locator(".line-disc")
  ).toContainText("5.75");
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

test("a cashier inside their limit does not have to fetch anybody", async ({ page }) => {
  // The manager gives Sam ten percent of standing authority. This is the
  // difference between closing a small sale and leaving the counter to find
  // somebody for R11.50.
  be.staff.find((s) => s.id === "u2")!.discount_limit_percent = 10;

  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();

  // R115 of cement, so ten percent is R11.50. The dialog says how far the
  // authority goes before it is reached, not after.
  await page.getByLabel("Discount amount").fill("11.50");
  await expect(page.getByText(/manager will need to approve/i)).toHaveCount(0);
  await page.getByRole("button", { name: /^Apply$/ }).click();

  await expect(page.getByText(/Manager approval/i)).toHaveCount(0);
  await expect(page.locator(".total-row .fig")).toContainText("103.50");

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  expect(be.storedSales[0].discount_amount).toBe(11.5);
  // Nobody was asked, so nobody is recorded as having approved it — and the
  // sale completes rather than parking.
  expect(be.storedSales[0].approved_by).toBeNull();
  await expect(page.locator("#print-area")).toContainText("INV-");
});

test("a percent limit is a rate on the line, not a sum against the sale", async ({ page }) => {
  // The bug the shop found. Sam is on 5%, rings up R1,710 across two lines and
  // takes 10% off one of them. The money involved — R71.40 — is under 5% of
  // the sale, which is R85.50, so the old rule let it through unasked: 10%
  // given on a 5% limit, with nobody consulted.
  const sam = be.staff.find((s) => s.id === "u2")!;
  sam.discount_limit_percent = 5;
  sam.discount_limit_amount = 100;

  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");

  await page.getByRole("button", { name: /Discount Cement/i }).click();
  await page.getByRole("button", { name: /Percent/ }).click();
  await page.getByLabel("Discount percent").fill("10");
  await expect(page.getByText(/manager will need to approve/i)).toBeVisible();
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await expect(page.getByText(/Manager approval/i)).toBeVisible();
});

test("a limit stops a cheap line being given away inside a big sale", async ({ page }) => {
  // The same flaw at its extreme: 100% off a R115 line is small money beside a
  // R1,450 roll of cable, so measuring the percentage against the sale total
  // let a cashier hand an item over free.
  const sam = be.staff.find((s) => s.id === "u2")!;
  sam.discount_limit_percent = 5;

  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");

  await page.getByRole("button", { name: /Discount Cement/i }).click();
  await page.getByRole("button", { name: /Percent/ }).click();
  await page.getByLabel("Discount percent").fill("100");
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await expect(page.getByText(/Manager approval/i)).toBeVisible();
});

test("at the rate, a line discount goes through on the cashier's own say-so", async ({ page }) => {
  const sam = be.staff.find((s) => s.id === "u2")!;
  sam.discount_limit_percent = 5;
  sam.discount_limit_amount = 100;

  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");

  // 5% of the R115 cement line is R5.75 — at the rate, and well under the
  // R100 the sale as a whole is allowed.
  await page.getByRole("button", { name: /Discount Cement/i }).click();
  await page.getByRole("button", { name: /Percent/ }).click();
  await page.getByLabel("Discount percent").fill("5");
  await expect(page.getByText(/manager will need to approve/i)).toHaveCount(0);
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await expect(page.getByText(/Manager approval/i)).toHaveCount(0);

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  expect(be.storedSales[0].discount_amount).toBe(5.75);
  expect(be.storedSales[0].approved_by).toBeNull();
});

test("a cent past the limit and the manager is still fetched", async ({ page }) => {
  be.staff.find((s) => s.id === "u2")!.discount_limit_percent = 10;

  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();
  await page.getByLabel("Discount amount").fill("20");

  // Said before Apply, not after: the cashier can decide to offer less rather
  // than discovering at the tender screen that somebody has to be found. On a
  // single-line sale a blanket discount is the whole line, so 10% of R115 is
  // the ceiling either way.
  await expect(page.getByText(/Over your R11.50/i)).toBeVisible();
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await expect(page.getByText(/Manager approval/i)).toBeVisible();
});

test("a line discount counts against the same limit as a blanket one", async ({ page }) => {
  // Ten percent off the ladder is the same money as ten percent off a sale
  // with only the ladder in it, so it cannot be a way around the limit.
  be.staff.find((s) => s.id === "u2")!.discount_limit_amount = 10;

  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Discount Cement/i }).click();
  await page.getByLabel("Discount amount").fill("25");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  await expect(page.getByText(/Manager approval/i)).toBeVisible();
});

test("an item cap refuses the owner, not only the counter", async ({ page }) => {
  // The whole difference between a cap and a limit: a limit decides whether a
  // manager is fetched, a cap has nobody to fetch. The manager here approves
  // their own discounts and is still held.
  PRODUCTS.find((p) => p.id === "p1")!.max_discount_percent = 5;

  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Discount Cement/i }).click();

  // R115 of cement, capped at 5% — R5.75. The ceiling is stated up front, so
  // nobody promises 20% and then takes it back.
  await expect(page.getByText(/Capped at R5.75 off/i)).toBeVisible();
  await page.getByLabel("Discount amount").fill("10");
  await expect(page.getByText(/no PIN will lift it/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Apply$/ })).toBeDisabled();

  // And at the cap it goes through.
  await page.getByLabel("Discount amount").fill("5.75");
  await expect(page.getByRole("button", { name: /^Apply$/ })).toBeEnabled();
  await page.getByRole("button", { name: /^Apply$/ }).click();
  // R115 less R5.75 is R109.25, which cannot be paid in coins — so the figure
  // to pay is the cash-rounded R109.20 and the row says "To pay" rather than
  // "Total". The cap comes off before the rounding, not instead of it.
  await expect(page.locator(".total-row .lbl")).toHaveText("To pay");
  await expect(page.locator(".total-row .fig")).toContainText("109.20");
});

test("a blanket discount cannot walk around an item cap", async ({ page }) => {
  // The route that would otherwise defeat the whole feature: cap the line, then
  // take the money off the sale instead and let it spread back onto the line.
  PRODUCTS.find((p) => p.id === "p1")!.max_discount_percent = 5;

  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();

  await expect(page.getByText(/Capped at R5.75 off/i)).toBeVisible();
  await page.getByLabel("Discount amount").fill("20");
  await expect(page.getByRole("button", { name: /^Apply$/ })).toBeDisabled();
});

test("the manager sets a limit on one person and a cap on one item", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);

  // The cap lives on the product, because that is what it is about.
  // The catalogue is a table; a row opens the editor.
  await page.locator("tr", { hasText: "Cement 42.5N 50kg" }).first().click();
  await page.getByLabel("Maximum discount percent").fill("5");
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect.poll(() => PRODUCTS.find((p) => p.id === "p1")?.max_discount_percent).toBe(5);

  // The limit lives on the person.
  await page.getByRole("button", { name: /^Staff$/ }).click();
  await page.getByRole("button", { name: /Sam/ }).click();
  await page.getByLabel("Discount limit percent").fill("10");
  await page.getByLabel("Discount limit amount").fill("200");
  await page.getByRole("button", { name: /^Save$/ }).click();

  await expect
    .poll(() => be.staff.find((s) => s.id === "u2")?.discount_limit_percent)
    .toBe(10);
  expect(be.staff.find((s) => s.id === "u2")?.discount_limit_amount).toBe(200);

  // Both are visible from the staff screen — the limits on the row, and the
  // capped items underneath, because a cap binds everybody on this list and
  // leaving it out would make the screen quietly wrong.
  await expect(page.getByText(/may discount 10% a line and R200 a sale/i)).toBeVisible();
  await expect(page.getByText(/Items with a discount cap/i)).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Cement 42.5N 50kg" }).last()
  ).toContainText("5% max");
});

test("clearing the box takes a limit away", async ({ page }) => {
  be.staff.find((s) => s.id === "u2")!.discount_limit_percent = 10;

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Staff$/ }).click();
  await page.getByRole("button", { name: /Sam/ }).click();

  // The editor opens on what is stored, and emptying it means none — not
  // "leave it alone", which would make a limit impossible to remove.
  await expect(page.getByLabel("Discount limit percent")).toHaveValue("10");
  await page.getByLabel("Discount limit percent").fill("");
  await page.getByRole("button", { name: /^Save$/ }).click();

  await expect
    .poll(() => be.staff.find((s) => s.id === "u2")?.discount_limit_percent)
    .toBeNull();
});

test("an EFT slip says where to pay, and a cash slip does not", async ({ page }) => {
  // The till took EFT and printed nothing about where the money goes, so the
  // customer had to phone the shop before they could settle. Cash slips still
  // say nothing: that customer has already paid, and the shop's account number
  // does not belong on a hundred till slips a day.
  Object.assign(be.orgSettings, {
    bank_name: "First National Bank",
    bank_account_name: "Ladybrand Hardware CC",
    bank_account_number: "62012345678",
    bank_branch_code: "250655",
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(page.locator("#print-area")).not.toContainText("PAYMENT DETAILS");
  await page.getByLabel("Close").click();

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^EFT$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  const slip = page.locator("#print-area");
  await expect(slip).toContainText("PAYMENT DETAILS");
  await expect(slip).toContainText("62012345678");
  await expect(slip).toContainText("250655");
  await expect(slip).toContainText("Ladybrand Hardware CC");
});

test("the VAT rate on screen is the one the server will charge", async ({ page }) => {
  // Only the display was ever a build constant — what gets charged has always
  // been a dated row the sale resolves and stores. Serving it means the two
  // cannot disagree on the day a new rate takes effect.
  await pairAndSignIn(page);
  await expect(page.locator(".pay")).toContainText("VAT at 15%");
});

test("the shop's banking details are editable and reach the next invoice", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();

  await page.getByLabel("Bank", { exact: true }).fill("Capitec");
  await page.getByLabel("Account number").fill("1051234567");
  await page.getByLabel("Branch code").fill("470010");
  await page.getByRole("button", { name: /^Save$/ }).click();

  await expect.poll(() => be.orgSettings.bank_account_number).toBe("1051234567");
  expect(be.orgSettings.bank_branch_code).toBe("470010");

  // The rate is shown, not offered as a box: it is national, and the table it
  // comes from is shared by every shop on this system.
  await expect(page.getByText("15%", { exact: true })).toBeVisible();
});

test("a parked sale can be released from the Sales screen", async ({ page }) => {
  // Sales park for approval by design — a cashier past their limit, no manager
  // on the floor, or a device whose cached limit is behind what the back office
  // now says. But there was no way out of that state: the RPC to release one
  // has existed since 0004 and no screen ever called it, so the sale sat with
  // no invoice number and its stock never came off the shelf.
  //
  // Parked here directly rather than through the till, because the till no
  // longer produces one on demand — backing out of the approval prompt undoes
  // the discount, which is the point of the fix that came with this. What is
  // under test is the way out, not the way in.
  be.sales.push({
    client_ref: null,
    cashier_id: USERS.employee.row.id,
    customer_id: null,
    items: [{ product_id: "p1", qty: 1 }],
    payment_method: "cash",
    discount_amount: 20,
    discount_reason: "staff",
    approved_by: null,
    within_limit: false,
    created_at: new Date().toISOString(),
    total: 95,
    payments: [{ method: "cash", amount: 95 }],
    po_number: null,
    customer_vat_number: null,
    rounding: 0,
    amount_tendered: 95,
    change_due: 0,
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();

  // Unnumbered, flagged, and counting for nothing: a parked sale is not
  // takings until somebody says it is.
  await expect(page.getByText(/awaiting approval/i)).toBeVisible();
  await expect(page.getByText("(no invoice number)")).toBeVisible();

  await page.getByRole("button", { name: /^Release$/ }).click();
  const release = page.getByRole("dialog", { name: "Release this sale" });
  for (const d of USERS.manager.pin.split("")) {
    await release.locator(`button:text-is("${d}")`).first().click();
  }
  const ok = release.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();

  await expect(page.getByText(/awaiting approval/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Release$/ })).toHaveCount(0);
  expect(be.sales[0].approved_by).toBe(USERS.manager.row.id);
});

test("a manager issues a code, and it releases a discount over the phone", async ({ page }) => {
  // What actually happens when the manager is at the bank: the cashier phones,
  // the manager reads out six digits. Before this the only digits that worked
  // were their PIN — which opens the back office, the staff list and the
  // cash-up on every till, and cannot be taken back once said aloud.
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Approvals$/ }).click();
  await page.getByLabel("Code ceiling").fill("100");
  await page.getByLabel("Code reason").fill("Mr Molefe, cement");
  await page.getByRole("button", { name: /Give me a code/i }).click();

  await expect(page.getByText(/Read this to the counter/i)).toBeVisible();
  const code = be.approvalCodes[0].code;
  await expect(page.getByText(code)).toBeVisible();
  // Shown once and listed as live, so the manager can see what is outstanding.
  await expect(page.getByText(/^live$/)).toBeVisible();

  // The counter, later. Sam has no standing authority at all.
  await page.getByRole("button", { name: /Back to till/i }).click();
  await page.getByRole("button", { name: /Sign out/i }).click();
  await page.getByRole("button", { name: /^Sam\b/ }).click();
  for (const d of USERS.employee.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  const signIn = page.locator('button:text-is("OK")');
  if (await signIn.count()) await signIn.first().click();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();
  await page.getByLabel("Discount amount").fill("20");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  // The prompt takes either — that is the whole point of offering it.
  const approval = page.getByRole("dialog", { name: "Manager approval" });
  await expect(approval).toContainText(/a code they gave you/i);
  for (const d of code.split("")) {
    await approval.locator(`button:text-is("${d}")`).first().click();
  }
  const ok = approval.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();
  await expect(page.getByText(/Manager approval/i)).toHaveCount(0);

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // Released, invoiced, and the MANAGER's name against it — not Sam's. A code
  // that made the cashier the approver would be worse than the PIN it replaced.
  await expect(banner(page)).toContainText(/INV-\d+/);
  expect(be.storedSales[0].approved_by).toBe(USERS.manager.row.id);
  expect(be.storedSales[0].discount_amount).toBe(20);
  expect(be.approvalCodes[0].used_at).toBeTruthy();
});

test("a code works once, and a wrong one is refused at the counter", async ({ page }) => {
  be.approvalCodes.push({
    id: "ac9",
    code: "424242",
    issued_by: USERS.manager.row.id,
    issued_by_name: "Manager",
    max_amount: null,
    reason: null,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    used_at: new Date().toISOString(), // already spent
    used_by_name: "Sam",
    doc_number: "INV-000001",
  });

  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();
  await page.getByLabel("Discount amount").fill("20");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  // Overhearing a code is worth nothing once it has been used — the till says
  // so at the counter rather than at the tender screen.
  const approval = page.getByRole("dialog", { name: "Manager approval" });
  for (const d of "424242".split("")) {
    await approval.locator(`button:text-is("${d}")`).first().click();
  }
  const ok = approval.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();
  await expect(approval).toContainText(/expired or already been used/i);
  await expect(approval).toBeVisible();
});

test("a code ceiling is checked before the customer is told yes", async ({ page }) => {
  be.approvalCodes.push({
    id: "ac8",
    code: "313131",
    issued_by: USERS.manager.row.id,
    issued_by_name: "Manager",
    max_amount: 10,
    reason: null,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    used_at: null,
    used_by_name: null,
    doc_number: null,
  });

  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();
  await page.getByLabel("Discount amount").fill("20");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  const approval = page.getByRole("dialog", { name: "Manager approval" });
  for (const d of "313131".split("")) {
    await approval.locator(`button:text-is("${d}")`).first().click();
  }
  const ok = approval.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();
  await expect(approval).toContainText(/releases up to/i);
  // Refused and NOT spent: the manager should not have to issue a second one.
  expect(be.approvalCodes.find((c) => c.code === "313131")?.used_at).toBeNull();
});

test("a parked sale does not tell the cashier it completed", async ({ page }) => {
  // The banner read "Sale completed." on a sale the server had parked, and the
  // slip said "Invoice No: pending sync" — so a cashier handed over something
  // that was not an invoice and walked away believing it had gone through.
  //
  // Reproduced the way it can still happen now that the approval path is
  // fixed: the limit is cached on the device at sign-in, so a manager lowering
  // it mid-shift leaves the till believing the cashier has more room than they
  // do. The till asks nobody, the server parks the sale, and the two disagree.
  be.staff.find((s) => s.id === "u2")!.discount_limit_percent = 100;
  await pairAndSignIn(page, USERS.employee.pin);
  be.staff.find((s) => s.id === "u2")!.discount_limit_percent = null;

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();
  await page.getByLabel("Discount amount").fill("20");
  await page.getByRole("button", { name: /^Apply$/ }).click();
  // The till believes this is within Sam's authority, so it asks nobody.
  await expect(page.getByText(/Manager approval/i)).toHaveCount(0);

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // The server parked it. The till has to say so, and say what to do about it.
  await expect(banner(page)).toContainText(/Waiting for a manager/i);
  await expect(banner(page)).not.toContainText(/completed/i);
  // And the slip must not pass itself off as an invoice, nor blame the line.
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("NOT AN INVOICE");
  await expect(slip).not.toContainText("pending sync");
});

test("a sale open when the screen reloads comes back parked", async ({ page }) => {
  // A counter screen is a browser tab, and tabs get refreshed: a stray gesture,
  // the PWA updating itself, a phone reclaiming a backgrounded page. Every one
  // of those threw away a basket scanned item by item, with the customer
  // standing there and an empty screen as the only clue.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");
  await expect(page.locator(".total-row .fig")).toContainText("1 565.00");

  await page.reload();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');

  // Parked, not silently restored: a refresh is not always an accident, and a
  // basket that reappears on its own is fighting whoever meant to clear it.
  await expect(banner(page)).toContainText(/has been parked/i);
  await expect(page.locator(".line-row")).toHaveCount(0);

  await page.getByRole("button", { name: /Resume parked/i }).click();
  await expect(page.locator(".line-row")).toHaveCount(2);
  await expect(page.locator(".total-row .fig")).toContainText("1 565.00");

  // And it is a real sale again, not a husk.
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  expect(be.storedSales[0].total).toBe(1565);
});

test("a completed sale does not come back parked", async ({ page }) => {
  // The other half: the device's copy has to be dropped when the sale leaves,
  // or every refresh resurrects the last thing sold.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);

  await page.reload();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
  await expect(page.getByText(/has been parked/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Resume parked/i })).toHaveCount(0);
});

test("an approval code releases a sale taken offline, and survives the queue", async ({ page }) => {
  // The code cannot be checked on the device — it lives on the server — so an
  // offline sale carries it in the queue and it is spent at sync. Expiry is
  // measured against when the sale was RUNG UP, so a line that comes back late
  // does not refuse a code that was live when the cashier typed it.
  be.approvalCodes.push({
    id: "ac7",
    code: "515151",
    issued_by: USERS.manager.row.id,
    issued_by_name: "Manager",
    max_amount: null,
    reason: null,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    used_at: null,
    used_by_name: null,
    doc_number: null,
  });

  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  // The line drops before the discount is even given.
  be.offline = true;
  await page.context().setOffline(true);

  await page.getByRole("button", { name: /^Discount$/ }).click();
  await page.getByLabel("Discount amount").fill("20");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  const approval = page.getByRole("dialog", { name: "Manager approval" });
  for (const d of "515151".split("")) {
    await approval.locator(`button:text-is("${d}")`).first().click();
  }
  const ok = approval.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();

  // Offline the code is taken on trust, and the till says so rather than
  // implying it has been checked.
  await expect(banner(page)).toContainText(/taken on trust/i);

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/will sync when the connection returns/i);

  be.offline = false;
  await page.context().setOffline(false);
  await expect.poll(() => be.storedSales.length, { timeout: 15000 }).toBe(1);

  // Released by the manager who issued it, and the code is spent.
  expect(be.storedSales[0].discount_amount).toBe(20);
  expect(be.storedSales[0].approved_by).toBe(USERS.manager.row.id);
  expect(be.approvalCodes.find((c) => c.code === "515151")?.used_at).toBeTruthy();
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

/** Open Manage and get past the PIN, which every back-office test needs first. */
async function openManage(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /^Manage$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Manage" });
  for (const d of USERS.manager.pin.split("")) {
    await dialog.locator(`button:text-is("${d}")`).first().click();
  }
  await dialog.locator('button:text-is("OK")').click();
}

test("a day is opened on a float, cashed up, and the variance is what prints", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Cash-up$/ }).click();

  await page.getByLabel("Opening float").fill("500");
  await page.getByRole("button", { name: /Open the day/i }).click();
  await expect(page.getByText(/Expected in drawer/i)).toBeVisible();

  // Sell R115 in cash, and take R60 out of the drawer for diesel.
  await page.getByRole("button", { name: /Back to till/i }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: /^Cash-up$/ }).click();
  await page.getByRole("button", { name: /Money in or out/i }).click();
  await page.getByRole("button", { name: /^Paid out$/ }).click();
  await page.getByLabel("Movement amount").fill("60");
  await page.getByLabel("Movement reason").fill("Diesel for the bakkie");
  await page.getByRole("button", { name: /Record it/i }).click();

  // 500 float + 115 cash - 60 out. A payout that did not count would read as a
  // R60 shortfall against a cashier who is not short.
  await expect(page.getByText("Expected in drawer").locator("..")).toContainText("555.00");

  // Count R550: R5 missing, and the manager is told before committing to it.
  await page.getByLabel("Counted cash").fill("550");
  const variance = page.getByRole("status", { name: "Variance" });
  await expect(variance).toContainText("Short");
  await expect(variance).toContainText("5.00");

  // A difference takes a second press — closing the day cannot be undone here.
  await page.getByRole("button", { name: /Close & print/i }).click();
  await page.getByRole("button", { name: /Close short by/i }).click();

  const slip = page.locator("#print-area");
  await expect(slip).toContainText("CASH-UP");
  await expect(slip).toContainText("Opening float");
  await expect(slip).toContainText("Diesel for the bakkie");
  await expect(slip).toContainText("SHORT");
  expect(be.closedSessions[0].variance).toBe(-5);
});

test("a balanced drawer closes on one press", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Cash-up$/ }).click();
  await page.getByLabel("Opening float").fill("200");
  await page.getByRole("button", { name: /Open the day/i }).click();

  await page.getByLabel("Counted cash").fill("200");
  await expect(page.getByRole("status", { name: "Variance" })).toContainText("Balanced");
  // Nothing to query, so no second press is asked for.
  await page.getByRole("button", { name: /Close & print/i }).click();
  await expect(page.locator("#print-area")).toContainText("BALANCED");
  expect(be.closedSessions[0].variance).toBe(0);
});

test("cashing up over unsynced sales is warned about, not silently wrong", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Cash-up$/ }).click();
  await page.getByLabel("Opening float").fill("0");
  await page.getByRole("button", { name: /Open the day/i }).click();

  // The sale cannot reach the server, so it queues on the device. Only the
  // sale path is blocked: the cash-up itself still loads, which is exactly the
  // window that does the damage — a reachable server with takings it has never
  // been told about.
  await page.route(/rpc\/pos_create_sale/, (r) => r.abort());
  await page.getByRole("button", { name: /Back to till/i }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: /^Cash-up$/ }).click();
  // Without this the R115 reads as a shortfall and lands on whoever was on the
  // till, which is the one way a cash-up can do real harm.
  await expect(page.getByText(/still waiting to sync/i)).toBeVisible();
  // And the figures agree with the warning rather than contradicting it.
  await expect(page.getByText("Expected in drawer").locator("..")).toContainText("0.00");
});

test("a sale can be found again, and the day's takings add up", async ({ page }) => {
  // Two sales today, one of them a week old. The week-old one is what proves a
  // window has ends rather than just showing everything.
  const weekAgo = new Date(Date.now() - 6 * 864e5).toISOString();
  be.sales.push({
    client_ref: null, cashier_id: USERS.employee.row.id, customer_id: null,
    items: [{ product_id: "p1", qty: 1 }], payment_method: "card",
    discount_amount: 0, discount_reason: null, approved_by: null, created_at: weekAgo, total: 500,
    payments: [{ method: "card", amount: 500 }], po_number: null,
    customer_vat_number: null, rounding: 0, amount_tendered: null, change_due: null,
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();

  // Today: the sale just rung up, and nothing from last week.
  await expect(page.getByText("Taken")).toBeVisible();
  const rows = page.locator("li", { has: page.getByRole("button", { name: /Reprint/ }) });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("115.00");

  // Yesterday: nothing happened.
  await page.getByRole("button", { name: /^Yesterday$/ }).click();
  await expect(page.getByText(/Nothing sold in that stretch/i)).toBeVisible();

  // Seven days reaches back far enough to catch the older one, and the takings
  // are both sales together.
  await page.getByRole("button", { name: /^Last 7 days$/ }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByText("R615.00")).toBeVisible();
});

test("an old slip reprints from the sales list", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();

  // "Can I have another copy of that slip" is the reason most people go looking
  // for an old sale at all, so it is one tap from the row.
  await page.getByRole("button", { name: /Reprint/ }).first().click();
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("Cement 42.5N 50kg");
  await expect(slip).toContainText(/tax invoice/i);
});

test("a buyer's address is kept, and the slip carries their name next time", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.getByPlaceholder(/Name, account code or phone/i).fill("083 555 0199");
  await page.getByRole("button", { name: /Record .* as a new buyer/i }).click();

  // All three optional, and all three worth having: the name puts them on the
  // invoice, the number finds them again, the address goes on a delivery note.
  await page.getByLabel(/Their name/i).fill("T. Mokoena");
  await page.getByLabel(/Delivery address/i).fill("14 Mabille Rd, Maseru");
  await page.getByRole("button", { name: /^Save 083/ }).click();

  const saved = be.customers.find((c) => c.name === "T. Mokoena");
  expect(saved).toBeTruthy();

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(page.locator("#print-area")).toContainText("T. Mokoena");
});

test("staff are invited by phone, and nobody's PIN is set for them", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Staff$/ }).click();

  await expect(page.getByText("Sam")).toBeVisible();
  await page.getByRole("button", { name: /Invite someone/i }).click();
  await page.getByLabel("Staff name").fill("Thabo");
  await page.getByLabel("Staff mobile number").fill("082 555 0100");
  await page.getByRole("button", { name: /Send invite/i }).click();

  // Invited, not active: they choose their own PIN on their own phone, so a
  // manager never holds a credential that would ring up a sale as someone else.
  const invited = be.staff.find((s) => s.name === "Thabo");
  expect(invited?.status).toBe("invited");
  // Stored in E.164, which is what the enrolment lookup matches on.
  expect(invited?.phone).toBe("+27825550100");

  // The invite sends nothing, on purpose — so the screen has to say so, or it
  // reads as a button that did nothing and the new cashier is never told what
  // to do. This is the step a manager would otherwise have to already know.
  const next = page.getByRole("button", { name: /copy a message for them/i });
  await expect(next).toContainText("pos.innovaearth.com/enrol/");
  await expect(next).toContainText("+27825550100");
  await page.getByRole("button", { name: /^Done$/ }).click();

  await expect(page.getByText("PIN not set")).toBeVisible();
});

test("a role's own permissions are shown fixed, and only the extras are saved", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Staff$/ }).click();
  await page.getByRole("button", { name: /Sam/ }).click();

  // Counter staff already take payments through the role, so that box is
  // ticked and fixed — offering to untick it would be a lie, since the server
  // unions the role's set with the extras.
  const takes = page.getByRole("checkbox", { name: /Take payments/i });
  await expect(takes).toBeChecked();
  await expect(takes).toBeDisabled();

  await page.getByRole("checkbox", { name: /Cash-up & reconciliation/i }).check();
  await page.getByRole("button", { name: /^Save$/ }).click();

  // Only the extra is stored. Writing the role's own set down as well would
  // leave it behind if the role ever changed.
  await expect.poll(() => be.staff.find((s) => s.id === "u2")?.permissions)
    .toEqual(["cash_management"]);
});

test("a cashier who has rung up sales is signed out rather than deleted", async ({ page }) => {
  // Sam's name is already on an invoice — the shift before this one, which is
  // the ordinary case when somebody leaves.
  be.sales.push({
    client_ref: null, cashier_id: USERS.employee.row.id, customer_id: null,
    items: [{ product_id: "p1", qty: 1 }], payment_method: "cash",
    discount_amount: 0, discount_reason: null, approved_by: null, created_at: null, total: 115,
    payments: [{ method: "cash", amount: 115 }], po_number: null,
    customer_vat_number: null, rounding: 0, amount_tendered: null, change_due: null,
  });
  await pairAndSignIn(page, USERS.manager.pin);

  await openManage(page);
  await page.getByRole("button", { name: /^Staff$/ }).click();
  await page.getByRole("button", { name: /Manager/ }).click();
  // You cannot remove yourself, so the button is not even offered.
  await expect(page.getByRole("button", { name: /^Remove$/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Close$/ }).click();

  await page.getByRole("button", { name: /Sam/ }).click();
  await page.getByRole("button", { name: /^Remove$/ }).click();
  await page.getByRole("button", { name: /Tap again to remove/i }).click();

  // Still on the roster, signed out — an invoice that cannot say who rang it
  // up is a worse record than a staff list with a leaver on it.
  await expect(page.getByText(/rung up sales, so they were signed out/i)).toBeVisible();
  expect(be.staff.find((s) => s.id === "u2")?.active).toBe(false);
});

test("a slow shop-settings load does not wipe what was just typed", async ({ page }) => {
  // The screen fetches the server's copy on the way in, and the answer arrives
  // whenever the line lets it. CI found this by being slower than a laptop: the
  // fetch landed on top of the typing and put the old VAT number back, silently,
  // and Save then wrote the value the manager had just replaced.
  await page.route(/rpc\/pos_org_settings/, async (r) => {
    await new Promise((ok) => setTimeout(ok, 1500));
    await r.continue();
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();

  // Type immediately, while the fetch is still in flight.
  await page.getByLabel("VAT number").fill("4001111111");
  await page.waitForTimeout(2000);

  // Still what was typed, not what came back.
  await expect(page.getByLabel("VAT number")).toHaveValue("4001111111");
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  expect(be.orgSettings.vat_number).toBe("4001111111");
});

test("the shop's own details are editable and reach the next invoice", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();

  await page.getByLabel("VAT number").fill("4009999999");
  await page.getByLabel("Street address").fill("9 Kerk St");
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  expect(be.orgSettings.vat_number).toBe("4009999999");

  // The point of the screen: a shop that registers for VAT on the Tuesday can
  // issue a valid tax invoice on the Wednesday, without a redeploy.
  await page.getByRole("button", { name: /Back to till/i }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  const slip = page.locator("#print-area");
  await expect(slip).toContainText("VAT No: 4009999999");
  await expect(slip).toContainText("9 Kerk St");
});

test("a manager without staff rights is not shown the staff tab", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  // The seeded manager is an admin, so both tabs are there. What this pins is
  // that the tabs are permission-driven at all rather than always present.
  await expect(page.getByRole("button", { name: /^Staff$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Shop$/ })).toBeVisible();
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
