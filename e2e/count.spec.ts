import { expect, test, type Browser, type Page } from "@playwright/test";
import { Backend, installBackend, pairAndSignIn, PRODUCTS, USERS } from "./fake-backend";

/**
 * 0114: a shop counted by people from outside it.
 *
 * Two screens and two devices, as it happens in a shop: the manager starts a
 * count on the till and reads out a code; a counter from 4D types it on their
 * own phone at /count and walks the aisles. The phone is its own browser
 * context — its own storage, its own screen size — on the same fake backend,
 * so what one sends the other reads back.
 */

let be: Backend;

test.beforeEach(async ({ page }) => {
  be = await installBackend(page);
});

/** Start a count on the till and return the code it shows. */
async function startCount(page: Page, note = "Opening count"): Promise<string> {
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" }).click();
  await page.getByRole("button", { name: "Count with a team" }).click();
  await page.getByLabel("What is this count").fill(note);
  await page.getByRole("button", { name: "Start a count" }).click();
  const code = page.getByLabel("Count code");
  await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  return (await code.textContent())!;
}

/** A counter's phone: its own context, 390 wide, on the same backend. */
async function openPhone(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
  });
  const phone = await ctx.newPage();
  await installBackend(phone, be);
  return phone;
}

async function join(phone: Page, code: string, name: string) {
  await phone.goto("/count");
  await phone.getByLabel("Count code").fill(code);
  await phone.getByLabel("Your name").fill(name);
  await phone.getByRole("button", { name: "Start counting" }).click();
  await expect(phone.getByText(new RegExp(`counting as ${name}`))).toBeVisible();
}

/** Find by scan (Enter on the box) or by name, then say how many. */
async function count(phone: Page, find: string, qty: string, pick?: string) {
  const box = phone.getByLabel("Find an item");
  await box.fill(find);
  if (pick) {
    await phone.getByRole("list", { name: "Matches" })
      .getByRole("button", { name: new RegExp(pick) }).click();
  } else {
    await box.press("Enter");
  }
  await phone.getByLabel(/^How many /).fill(qty);
  await phone.getByRole("button", { name: "Save count" }).click();
}

test("a counter joins with the code, counts what the shop has and what it does not, and the shop posts it", async ({ page, browser }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  const code = await startCount(page);
  const cement = PRODUCTS.find((p) => p.sku === "CEM-425-50")!;
  const chain = PRODUCTS.find((p) => p.sku === "CHN-06")!;
  const padlock = PRODUCTS.find((p) => p.sku === "PDL-50")!;
  const untouched = PRODUCTS.find((p) => p.sku === "NAL-100")!;
  const untouchedBefore = untouched.stock_qty;

  const phone = await openPhone(browser);
  // Read across an aisle and typed by thumb: lower case, and no dash.
  await join(phone, code.replace("-", "").toLowerCase(), "Lerato");
  await expect(phone.getByRole("heading", { name: "Ladybrand Hardware" })).toBeVisible();
  // Nothing on the phone is money. The till's prices are on every product
  // the fake holds; not one of them may reach this screen.
  await expect(phone.locator("body")).not.toContainText("115");
  await expect(phone.locator("body")).not.toContainText(/R\s?\d/);

  await phone.getByLabel("Where are you?").fill("Aisle 1");

  // A scan is Enter on the box: the cement goes straight to "how many".
  await count(phone, "6001234000015", "30");
  await expect(phone.getByText("Saved: 30 Bag — Cement 42.5N 50kg")).toBeVisible();

  // Found by part of its name, and it is sold by the metre so a half is fine.
  await count(phone, "chain 6", "12.5", "Chain 6mm Galvanised");

  // Padlocks are whole. 2.5 is a typo, caught on the phone before it is sent.
  const box = phone.getByLabel("Find an item");
  await box.fill("6001234000060");
  await box.press("Enter");
  await phone.getByLabel("How many Padlock 50mm Brass").fill("2.5");
  await phone.getByRole("button", { name: "Save count" }).click();
  await expect(phone.getByRole("alert")).toHaveText("Each is counted in whole numbers");
  await phone.getByLabel("How many Padlock 50mm Brass").fill("3");
  await phone.getByRole("button", { name: "Save count" }).click();

  // A barcode the shop has never seen: the phone offers to write it down.
  await box.fill("6009114999990");
  await box.press("Enter");
  await expect(phone.getByRole("heading", { name: "Something the shop has not listed" })).toBeVisible();
  await expect(phone.getByLabel("Barcode (if it has one)")).toHaveValue("6009114999990");
  await phone.getByLabel("What is it?").fill("Tile spacers 3mm");
  await phone.getByLabel("Counted in").selectOption("pack");
  await phone.getByLabel("How many of the new item").fill("12");
  await phone.getByRole("button", { name: "Save count" }).click();

  // And something with no barcode at all.
  await phone.getByRole("button", { name: /no barcode, not in the list/ }).click();
  await phone.getByLabel("What is it?").fill("Cable ties 200mm");
  await phone.getByLabel("Counted in").selectOption("pack");
  await phone.getByLabel("How many of the new item").fill("5");
  await phone.getByRole("button", { name: "Save count" }).click();

  await expect(phone.getByRole("status", { name: "Sending" })).toHaveText("All sent");
  // One thumb, one column: nothing on a 390-wide phone scrolls sideways.
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const mine = phone.getByRole("region", { name: "My counts" });
  await expect(mine).toContainText("My counts · 5");
  await expect(mine.locator("li.is-sent")).toHaveCount(5);
  const job = be.countJobs[0];
  expect(job.captures.map((c) => [c.qty, c.location])).toEqual([
    [30, "Aisle 1"], [12.5, "Aisle 1"], [3, "Aisle 1"], [12, "Aisle 1"], [5, "Aisle 1"],
  ]);

  // THE SHOP KEEPS TRADING. A bag of cement goes out after it was counted.
  // Moved directly: the fake does not take stock down when it sells (see the
  // stock-take test in till.spec.ts); the database suite rings a real sale.
  cement.stock_qty = cement.stock_qty! - 1;

  // The till sees who is counting and what posting will do.
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("region", { name: "Open count" })).toContainText("Lerato");
  const counted = page.getByRole("table", { name: "Counted items" });
  const cementRow = counted.locator("tr", { hasText: "Cement 42.5N 50kg" });
  // Cell by cell: the till holds 239 now, so "contains 29" would hold even
  // if the screen showed the wrong column.
  const cells = cementRow.locator("td");
  await expect(cells.nth(1)).toHaveText("30 Bag");
  await expect(cells.nth(2)).toHaveText(String(cement.stock_qty));
  await expect(cells.nth(3)).toHaveText("29-1 since it was counted");

  // Price the spacers; leave the cable ties for later.
  const spacers = page.getByRole("listitem", { name: "New item Tile spacers 3mm" });
  await spacers.getByLabel("What to do with Tile spacers 3mm").selectOption("add");
  await spacers.getByLabel("Price for Tile spacers 3mm").fill("24.50");
  await spacers.getByRole("button", { name: "Save" }).click();
  await expect(spacers).toContainText("Goes on sale when the count is posted.");

  await page.getByRole("button", { name: "Post the count" }).click();
  await expect(page.getByText(/1 of them hidden, with no price yet/)).toBeVisible();
  await page.getByRole("button", { name: "Yes, post STK-000001" }).click();
  await expect(page.getByText(
    "STK-000001 posted: 5 items counted, 2 added to the catalogue (1 hidden until priced).")).toBeVisible();

  // Counted, plus what sold since — not what the till held before.
  expect(cement.stock_qty).toBe(29);
  expect(chain.stock_qty).toBe(12.5);
  expect(padlock.stock_qty).toBe(3);
  // Nobody counted the nails; a blank is not a zero.
  expect(untouched.stock_qty).toBe(untouchedBefore);
  const made = PRODUCTS.find((p) => p.name === "Tile spacers 3mm")!;
  expect(made).toMatchObject({ barcode: "6009114999990", price_retail: 24.5, stock_qty: 12, unit_code: "pack" });
  const hidden = be.shelfAdded.find((p) => p.name === "Cable ties 200mm")!;
  expect(hidden).toMatchObject({ active: false, stock_qty: 5 });

  // The phone is finished with, and says so rather than taking more counts.
  await phone.reload();
  await expect(phone.getByRole("heading", { name: "This count has finished" })).toBeVisible();
  await phone.context().close();
});

test("with no signal the phone keeps counting, and every count is sent once when it returns", async ({ page, browser }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  const code = await startCount(page);
  const phone = await openPhone(browser);
  await join(phone, code, "Pieter");
  // The catalogue reached the phone while there was signal.
  await expect(phone.getByRole("status", { name: "Sending" })).toHaveText("All sent");

  be.offline = true;
  await phone.context().setOffline(true);
  await phone.getByLabel("Where are you?").fill("Storeroom");
  await count(phone, "6001234000015", "8");
  await count(phone, "6001234000060", "4");
  await expect(phone.getByRole("status", { name: "Sending" }))
    .toHaveText("No signal — 2 kept on this phone", { timeout: 20_000 });

  // A phone that goes flat in the storeroom still has them when it wakes.
  // The page itself comes back (the service worker holds the app on a real
  // phone; the suite blocks workers, so the page is let through here) while
  // the server stays out of reach.
  await phone.context().setOffline(false);
  await phone.reload();
  await expect(phone.getByRole("region", { name: "My counts" }).locator("li.is-waiting"))
    .toHaveCount(2);
  // One taken back before it was ever sent simply goes.
  await phone.getByRole("button", { name: "Take back Padlock 50mm Brass" }).click();
  await expect(phone.getByRole("region", { name: "My counts" }).locator("li")).toHaveCount(1);
  expect(be.countJobs[0].captures).toHaveLength(0);

  be.offline = false;
  await phone.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(phone.getByRole("status", { name: "Sending" }))
    .toHaveText("All sent", { timeout: 45_000 });
  await expect.poll(() => be.countJobs[0].captures.length).toBe(1);
  expect(be.countJobs[0].captures[0]).toMatchObject({ qty: 8, location: "Storeroom" });

  // Taken back after it was sent: the shop stops counting it.
  await phone.getByRole("button", { name: "Take back Cement 42.5N 50kg" }).click();
  await expect.poll(() => be.countJobs[0].captures[0].voided).toBe(true);
  await expect(phone.getByRole("region", { name: "My counts" }).locator("li")).toHaveCount(0);
  await phone.context().close();
});

test("a second counter meeting the same new thing counts it, not a twin — and the reviewer merges the rest", async ({ page, browser }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  const code = await startCount(page);
  const a = await openPhone(browser);
  const b = await openPhone(browser);
  await join(a, code, "Lerato");
  await join(b, code, "Pieter");

  // Lerato writes down a thing with no barcode.
  await a.getByRole("button", { name: /no barcode, not in the list/ }).click();
  await a.getByLabel("What is it?").fill("Cable ties 200mm");
  await a.getByLabel("Counted in").selectOption("pack");
  await a.getByLabel("How many of the new item").fill("5");
  await a.getByRole("button", { name: "Save count" }).click();
  await expect(a.getByRole("status", { name: "Sending" })).toHaveText("All sent");

  // Pieter's phone learns of it and finds it by name, marked as new.
  await b.reload();
  await b.getByLabel("Find an item").fill("cable ties");
  const hit = b.getByRole("list", { name: "Matches" }).getByRole("button", { name: /Cable ties 200mm/ });
  await expect(hit).toContainText("new on this count");
  await hit.click();
  await b.getByLabel("How many Cable ties 200mm").fill("2");
  await b.getByRole("button", { name: "Save count" }).click();
  // And one he names his own way, which is really the same thing.
  await b.getByRole("button", { name: /no barcode, not in the list/ }).click();
  await b.getByLabel("What is it?").fill("Cable-tie black 200");
  await b.getByLabel("Counted in").selectOption("pack");
  await b.getByLabel("How many of the new item").fill("4");
  await b.getByRole("button", { name: "Save count" }).click();
  await expect(b.getByRole("status", { name: "Sending" })).toHaveText("All sent");
  expect(be.countJobs[0].newItems.map((n) => n.name)).toEqual(["Cable ties 200mm", "Cable-tie black 200"]);

  await page.getByRole("button", { name: "Refresh" }).click();
  const ties = page.getByRole("listitem", { name: "New item Cable ties 200mm" });
  await expect(ties).toContainText("7 Pack");
  await expect(ties).toContainText("Lerato, Pieter");
  const odd = page.getByRole("listitem", { name: "New item Cable-tie black 200" });
  await odd.getByLabel("What to do with Cable-tie black 200").selectOption("merge");
  await odd.getByLabel("Cable-tie black 200 is the same as").selectOption({ label: "Cable ties 200mm" });
  await odd.getByRole("button", { name: "Save" }).click();
  await expect(odd).toContainText("Counted as Cable ties 200mm.");

  // Now the ties cannot be skipped out from under what was merged into them.
  await ties.getByLabel("What to do with Cable ties 200mm").selectOption("skip");
  await ties.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(
    "Something else is merged into Cable ties 200mm. Merge that one elsewhere first.")).toBeVisible();
  await ties.getByLabel("What to do with Cable ties 200mm").selectOption("add");
  await ties.getByLabel("Price for Cable ties 200mm").fill("65");
  await ties.getByRole("button", { name: "Save" }).click();

  await page.getByRole("button", { name: "Post the count" }).click();
  await page.getByRole("button", { name: "Yes, post STK-000001" }).click();
  await expect(page.getByText(/posted: 1 item counted, 1 added to the catalogue\./)).toBeVisible();
  const made = PRODUCTS.filter((p) => /cable/i.test(p.name));
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ name: "Cable ties 200mm", stock_qty: 11, price_retail: 65 });
  await a.context().close();
  await b.context().close();
});

test("the door: a wrong code, a closed count, and a counter taken off", async ({ page, browser }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  const code = await startCount(page);

  const stranger = await openPhone(browser);
  await stranger.goto("/count");
  await stranger.getByLabel("Count code").fill("ZZZZ-ZZZZ");
  await stranger.getByLabel("Your name").fill("Guess");
  await stranger.getByRole("button", { name: "Start counting" }).click();
  await expect(stranger.getByRole("alert")).toHaveText("That code is not open for counting");

  // The link carries the code, so a counter only types their name.
  const phone = await openPhone(browser);
  await phone.goto(`/count?c=${code.replace("-", "")}`);
  await expect(phone.getByLabel("Count code")).toHaveValue(code.replace("-", ""));
  await phone.getByLabel("Your name").fill("Lerato");
  await phone.getByRole("button", { name: "Start counting" }).click();
  await expect(phone.getByText(/counting as Lerato/)).toBeVisible();

  // Two are counting; the door closes and a third is turned away.
  await page.getByRole("button", { name: "Let nobody else join" }).click();
  await expect(page.getByText("Closed to new counters.")).toBeVisible();
  await stranger.getByLabel("Count code").fill(code);
  await stranger.getByRole("button", { name: "Start counting" }).click();
  await expect(stranger.getByRole("alert")).toHaveText("That code is not open for counting");

  // Lerato's phone is lost: taken off, and it can send nothing more.
  await page.getByRole("button", { name: "Take Lerato off the count" }).click();
  await expect(page.getByText("Lerato is off the count. What they sent stays.")).toBeVisible();
  await count(phone, "6001234000015", "3");
  await expect(phone.getByRole("heading", { name: "You have been taken off this count" })).toBeVisible();
  expect(be.countJobs[0].captures).toHaveLength(0);
  await stranger.context().close();
  await phone.context().close();
});

test("a storeman can run the count but not price it, and a sheet cannot open beside it", async ({ page }) => {
  await pairAndSignIn(page, USERS.storeman.pin);
  await startCount(page);

  // 0069's double count by another road: the sheet would post under the job.
  await page.getByRole("button", { name: "Stock take" }).click();
  await page.getByRole("button", { name: /Start a count/ }).click();
  await expect(page.getByText(/A count \(STK-000001\) is open\. Post it or abandon it/)).toBeVisible();

  await page.getByRole("button", { name: "Count with a team" }).click();
  await page.getByRole("button", { name: "Post the count" }).click();
  await page.getByRole("button", { name: "Yes, post STK-000001" }).click();
  await expect(page.getByText("Not permitted: manage_catalogue")).toBeVisible();
  expect(be.countJobs[0].status).toBe("open");

  await page.getByRole("button", { name: "Not yet" }).click();
  await page.getByRole("button", { name: "Abandon" }).click();
  await expect(page.getByText("STK-000001 abandoned. Nothing moved.")).toBeVisible();
  expect(be.countJobs[0].status).toBe("abandoned");
});
