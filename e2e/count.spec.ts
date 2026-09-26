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

/** Any real picture will do for the phone's camera: the till's own icon. */
const PHOTO = "public/icon-192.png";

/** "I'm done", asked and confirmed, on the counter's own phone. */
async function done(phone: Page) {
  await phone.getByRole("button", { name: "I'm done counting" }).click();
  await phone.getByRole("button", { name: "Yes, I'm done" }).click();
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
  // After the scan, a photo: the reviewer pricing this tomorrow never saw it.
  await phone.getByLabel("Photo").setInputFiles(PHOTO);
  await expect(phone.getByRole("list", { name: "Photos of Tile spacers 3mm" })
    .getByRole("img")).toHaveCount(1);
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
  // The photo went up after its count, against that count.
  await expect(mine.locator("li", { hasText: "Tile spacers 3mm" })).toContainText("1 photo sent");
  expect(job.photos.map((ph) => ph.capture_ref))
    .toEqual([job.captures[3].client_ref]);

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

  // The spacers go into the catalogue NOW, through the ordinary product form,
  // while Lerato is still counting (0116). The cable ties are left for later.
  const spacers = page.getByRole("listitem", { name: "New item Tile spacers 3mm" });
  await spacers.getByRole("button", { name: "Add Tile spacers 3mm to the catalogue" }).click();
  const form = page.getByRole("heading", { name: "Add to the catalogue" }).locator("../..");
  await expect(form.getByLabel("Name")).toHaveValue("Tile spacers 3mm");
  await expect(form.getByLabel(/^Barcode/)).toHaveValue("6009114999990");
  // The stock is the count's to set, not a box to type in — and what is
  // counted so far is what goes on the shelf (0126).
  await expect(form.getByLabel("Stock", { exact: true })).toHaveValue("12");
  await expect(form.getByLabel("Counters' photos").getByRole("img")).toHaveCount(1);
  await form.getByLabel(/^Retail/).fill("24.50");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(spacers).toContainText(/In the catalogue as Tile spacers 3mm · R\s?24\.50 · on sale/);
  // On sale before anybody has said they are done, with the counter's photo.
  await expect(page.getByText(
    "Tile spacers 3mm is in the catalogue and on sale with 12 in stock. Anything more counted is added when the count is posted.")).toBeVisible();
  const onSale = PRODUCTS.find((p) => p.name === "Tile spacers 3mm")!;
  // With its twelve, not "out of stock" until somebody posts the count.
  expect(onSale).toMatchObject({ barcode: "6009114999990", price_retail: 24.5, unit_code: "pack", stock_qty: 12 });
  expect(be.stockMoves.filter((m) => m.product_id === onSale.id)).toEqual([expect.objectContaining(
    { qty_delta: 12, reason: "stocktake", note: "STK-000001: counted 12 so far" })]);
  // And it sells: two packs go before the count is posted.
  onSale.stock_qty = 10;
  expect(onSale.image_url).toBe(job.photos[0].path);
  await expect(spacers.getByRole("list", { name: "Photos of Tile spacers 3mm" })
    .getByRole("img")).toHaveCount(1);

  // NOBODY IS SHUT OUT MID-SHELF. Lerato has not said she is done, so the
  // count cannot be posted from under her.
  await expect(page.getByRole("status", { name: "Waiting for" })).toContainText("Lerato");
  await expect(page.getByRole("button", { name: "Post the count" })).toBeDisabled();

  // She says so; her phone keeps its place and can still go back.
  await done(phone);
  await expect(phone.getByRole("heading", { name: "You're done" })).toBeVisible();
  await phone.reload();
  await expect(phone.getByRole("heading", { name: "You're done" })).toBeVisible();
  await phone.getByRole("button", { name: "Carry on counting" }).click();
  await expect(phone.getByLabel("Find an item")).toBeVisible();
  await done(phone);
  await expect(phone.getByRole("heading", { name: "You're done" })).toBeVisible();

  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("table", { name: "Counters" }).locator("tr", { hasText: "Lerato" }))
    .toContainText("done");
  await page.getByRole("button", { name: "Post the count" }).click();
  await expect(page.getByText(/1 of them hidden, with no price yet/)).toBeVisible();
  await page.getByRole("button", { name: "Yes, post STK-000001" }).click();
  // The spacers were catalogued already: only the cable ties are made here.
  await expect(page.getByText(
    "STK-000001 posted: 5 items counted, 1 added to the catalogue (1 hidden until priced).")).toBeVisible();

  // Counted, plus what sold since — not what the till held before.
  expect(cement.stock_qty).toBe(29);
  expect(chain.stock_qty).toBe(12.5);
  expect(padlock.stock_qty).toBe(3);
  // Nobody counted the nails; a blank is not a zero.
  expect(untouched.stock_qty).toBe(untouchedBefore);
  const made = PRODUCTS.find((p) => p.name === "Tile spacers 3mm")!;
  // Twelve counted, two sold: ten — the early twelve not counted twice.
  expect(made).toMatchObject({ barcode: "6009114999990", price_retail: 24.5, stock_qty: 10, unit_code: "pack" });
  // The counter's photo is the new product's picture.
  expect(made.image_url).toBe(job.photos[0].path);
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
  // Cement, with a photo — both wait on the phone for the signal.
  const box = phone.getByLabel("Find an item");
  await box.fill("6001234000015");
  await box.press("Enter");
  await phone.getByLabel("How many Cement 42.5N 50kg").fill("8");
  await phone.getByLabel("Photo").setInputFiles(PHOTO);
  await expect(phone.getByRole("list", { name: "Photos of Cement 42.5N 50kg" }).getByRole("img"))
    .toHaveCount(1);
  await phone.getByRole("button", { name: "Save count" }).click();
  await count(phone, "6001234000060", "4");
  await expect(phone.getByRole("status", { name: "Sending" }))
    .toHaveText("No signal — 3 kept on this phone", { timeout: 20_000 });

  // "I'm done" with counts still in the pocket would let the shop post
  // without them: refused, and it says why.
  await done(phone);
  await expect(phone.getByRole("alert")).toContainText("3 still to send from this phone");
  await expect(phone.getByLabel("Find an item")).toBeVisible();

  // A phone that goes flat in the storeroom still has them when it wakes.
  // The page itself comes back (the service worker holds the app on a real
  // phone; the suite blocks workers, so the page is let through here) while
  // the server stays out of reach.
  await phone.context().setOffline(false);
  await phone.reload();
  await expect(phone.getByRole("region", { name: "My counts" }).locator("li.is-waiting"))
    .toHaveCount(2);
  // The photo came back with it: kept in the phone's own storage, not memory.
  await expect(phone.getByRole("region", { name: "My counts" }).locator("li", { hasText: "Cement" }))
    .toContainText("1 photo");
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
  // And its photo, once, after it.
  await expect.poll(() => be.countJobs[0].photos.length).toBe(1);
  expect(be.countJobs[0].photos[0].capture_ref).toBe(be.countJobs[0].captures[0].client_ref);

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
  await done(a);
  await done(b);

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
  // Into the catalogue now; what was merged into it comes too.
  await ties.getByRole("button", { name: "Add Cable ties 200mm to the catalogue" }).click();
  const form = page.getByRole("heading", { name: "Add to the catalogue" }).locator("../..");
  await form.getByLabel(/^Retail/).fill("65");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(ties).toContainText("In the catalogue as Cable ties 200mm");

  await page.getByRole("button", { name: "Post the count" }).click();
  await page.getByRole("button", { name: "Yes, post STK-000001" }).click();
  await expect(page.getByText(/posted: 1 item counted, 0 added to the catalogue\./)).toBeVisible();
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

test("the counting phone installs as its own app, opening on the count", async ({ page }) => {
  await page.goto("/count");
  await expect(page.getByRole("heading", { name: "Stock count" })).toBeVisible();
  // Its own manifest, not the till's: installed, it opens at /count, named Count.
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/count.webmanifest");
  const manifest = await (await page.request.get(href!)).json();
  expect(manifest).toMatchObject({ id: "/count", start_url: "/count", short_name: "Count", display: "standalone" });
  await expect(page).toHaveTitle("Count · InnovaPOS");

  // The till keeps its own.
  await page.goto("/");
  expect(await page.locator('link[rel="manifest"]').getAttribute("href")).not.toBe("/count.webmanifest");
});

test("a counter who carries on after the till last looked still holds the post", async ({ page, browser }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  const code = await startCount(page);
  const phone = await openPhone(browser);
  await join(phone, code, "Lerato");
  await count(phone, "6001234000015", "30");
  await expect(phone.getByRole("status", { name: "Sending" })).toHaveText("All sent");
  await done(phone);
  await expect(phone.getByRole("heading", { name: "You're done" })).toBeVisible();

  // The till looks: everybody is done, and Post is offered.
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("button", { name: "Post the count" })).toBeEnabled();

  // Then she remembers a shelf — after the till last looked.
  await phone.getByRole("button", { name: "Carry on counting" }).click();
  await expect(phone.getByLabel("Find an item")).toBeVisible();

  // The till's screen is out of date; the server is not. She is not shut out.
  await page.getByRole("button", { name: "Post the count" }).click();
  await page.getByRole("button", { name: "Yes, post STK-000001" }).click();
  await expect(page.getByText(/Still counting: Lerato\./)).toBeVisible();
  expect(be.countJobs[0].status).toBe("open");
  await count(phone, "6001234000060", "4");
  await expect(phone.getByRole("status", { name: "Sending" })).toHaveText("All sent");
  expect(be.countJobs[0].captures).toHaveLength(2);
  await phone.context().close();
});

test("what a counter sends shows on the till by itself, and a counted item can go on sale mid-count", async ({ page, browser }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  const code = await startCount(page);
  const phone = await openPhone(browser);
  await join(phone, code, "Mary");

  // Mary writes down something the shop has never listed. Nobody touches
  // the till: it shows up there on its own.
  const box = phone.getByLabel("Find an item");
  await box.fill("9343266001987");
  await box.press("Enter");
  await phone.getByLabel("What is it?").fill("Filing Pocket");
  await phone.getByLabel("How many of the new item").fill("50");
  await phone.getByRole("button", { name: "Save count" }).click();
  await expect(phone.getByRole("status", { name: "Sending" })).toHaveText("All sent");
  const pocket = page.getByRole("listitem", { name: "New item Filing Pocket" });
  await expect(pocket).toContainText("50 Each", { timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Counters" })).toContainText("Mary");

  // Sold by the pack in the form, counted each on the shelf: refused before
  // any product is made, and it says what to do.
  await pocket.getByRole("button", { name: "Add Filing Pocket to the catalogue" }).click();
  const form = page.getByRole("heading", { name: "Add to the catalogue" }).locator("../..");
  await form.getByLabel("Sold by").selectOption("pack");
  await form.getByLabel(/^Retail/).fill("200");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toContainText("Filing Pocket was counted in each");
  expect(PRODUCTS.find((p) => p.name === "Filing Pocket")).toBeUndefined();

  // Sold each: on sale now, while Mary is still counting.
  await form.getByLabel("Sold by").selectOption("ea");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(pocket).toContainText(/In the catalogue as Filing Pocket · R\s?200\.00 · on sale/);
  // With the fifty she counted on the shelf (0126), not out of stock.
  expect(PRODUCTS.find((p) => p.name === "Filing Pocket")).toMatchObject({ price_retail: 200, stock_qty: 50 });
  await expect(page.getByRole("status", { name: "Waiting for" })).toContainText("Mary");

  // Her next scan of it counts the product itself, and shows up by itself too.
  await phone.reload();
  await box.fill("9343266001987");
  await box.press("Enter");
  await phone.getByLabel("How many Filing Pocket").fill("20");
  await phone.getByRole("button", { name: "Save count" }).click();
  const counted = page.getByRole("table", { name: "Counted items" }).locator("tr", { hasText: "Filing Pocket" });
  await expect(counted.locator("td").nth(1)).toHaveText("70 Each", { timeout: 15_000 });
  // The twenty more wait for posting; the fifty already on are not "since".
  expect(PRODUCTS.find((p) => p.name === "Filing Pocket")!.stock_qty).toBe(50);

  await done(phone);
  await expect(page.getByRole("button", { name: "Post the count" })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "Post the count" }).click();
  await page.getByRole("button", { name: "Yes, post STK-000001" }).click();
  await expect(page.getByText(/STK-000001 posted: 1 item counted, 0 added/)).toBeVisible();
  expect(PRODUCTS.find((p) => p.name === "Filing Pocket")!.stock_qty).toBe(70);
  await phone.context().close();
});
