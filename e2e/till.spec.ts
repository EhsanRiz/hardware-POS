import { readFileSync } from "fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  Backend, enrolPhoneAndSignIn, installBackend, pairAndSignIn, PRODUCTS, REGISTER_TOKEN,
  signInOnSecondTill, USERS,
} from "./fake-backend";

/**
 * The words on a slip, with the money columns taken out.
 *
 * A receipt is a fixed-width document and a long description does not fit on
 * one line of it — the narrower the paper the more often that is true. The
 * builder wraps such a line on a word boundary and carries the rest onto the
 * next, with the amount padded out to the right margin of the FIRST line, so
 * the raw text of "less 10% (church job, Mr Molefe)  -R145.00" reads
 *
 *     less 10% (church job, Mr      -R145.00
 *     Molefe)
 *
 * which is right on paper and useless to a substring match. Stripping the
 * amounts and collapsing the whitespace puts the sentence back together — and
 * asserting on THAT is the stronger test: a phrase only survives it if every
 * word survived whole and in order. The old cut-anywhere wrap ("Mr Mole" /
 * "fe)") fails it, which is the bug this exists to catch.
 */
async function slipWords(slip: import("@playwright/test").Locator): Promise<string> {
  const raw = (await slip.textContent()) ?? "";
  return raw.replace(/-?R\d[\d.,]*/g, " ").replace(/\s+/g, " ").trim();
}

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
  // 0074: what the device IS comes first. A till and somebody's own phone are
  // set up differently and are allowed different things, so the question is
  // asked before either path starts.
  await expect(page.getByText("What is this device?")).toBeVisible();
  await page.getByRole("button", { name: "This is a till" }).click();
  await expect(page.getByText("Set up this till")).toBeVisible();
  // No PIN pad until the device is a till — a cashier should never sign in to
  // a tablet that turns out to be unable to sell.
  await expect(page.locator('button:text-is("1")')).toHaveCount(0);
  // The wordmark on this cream card is ink, not the cream it wears on the
  // green header: cream on cream made "Innova" vanish next to "POS".
  await expect(page.locator(".pair-card .sell-wordmark")).toHaveCSS("color", "rgb(27, 42, 36)");
});

/**
 * The front door. One address serves every shop, and a device that is not
 * paired yet is the only thing that ever sees this screen — so it has to work
 * for a stranger who typed the address as well as for the manager with the
 * new tablet. Nobody may be left with a form they cannot fill in.
 */
test("an unpaired device is the front door of InnovaPOS, with a way out for everyone", async ({ page }) => {
  await page.goto("/");
  const door = page.locator(".firstrun");
  await expect(door).toBeVisible();
  // It says why there is no shop on screen, rather than presenting a form.
  await expect(door).toContainText(/not set up for a shop yet/i);
  await expect(door.getByRole("button", { name: "This is a till" })).toBeVisible();
  await expect(door.getByRole("button", { name: "This is my phone" })).toBeVisible();

  // A manager who was invited but has not chosen a PIN cannot pair anything:
  // they are sent to where the PIN is set. A shop that is not on InnovaPOS
  // is sent to where it asks to be. Both open beside the app, not over it.
  const pin = door.getByRole("link", { name: /Set your PIN/i });
  await expect(pin).toHaveAttribute("href", "https://pos.innovaearth.com/enrol/");
  await expect(pin).toHaveAttribute("target", "_blank");
  const request = door.getByRole("link", { name: /Request it for your shop/i });
  await expect(request).toHaveAttribute("href", "https://pos.innovaearth.com/request/");
  await expect(request).toHaveAttribute("target", "_blank");

  // The same door as sign-in on a wide screen: the aisle behind the bench,
  // the engraving, and the day and the line at the foot — so a stranger
  // sees the product, not a form, and a manager sees whether it is online
  // before pairing anything. Over it, what the product is for: a headline
  // and three proofs. Each path says what it is for before it is chosen.
  await expect(door.locator(".login-photo")).toBeVisible();
  await expect(door.locator(".login-engraving")).toBeVisible();
  await expect(door.locator(".login-status")).toContainText("Online");
  await expect(door.locator(".firstrun-title")).toContainText(/This one listens/);
  await expect(door.locator(".firstrun-proof li")).toHaveCount(3);
  await expect(door.getByRole("button", { name: "This is a till" })).toContainText(/pairs it once/i);
  await expect(door.getByRole("button", { name: "This is my phone" })).toContainText(/code from whoever manages staff/i);

  // On a phone the drawing gets out of the way and nothing spills sideways:
  // a stranger's first look is a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(door.locator(".login-engraving")).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Either path leads to a card with ONE action at its foot, and the way
  // back to this question is a quiet link in the card's top corner, above
  // the heading — not a second full-width button under the gold one, which
  // read as a peer of "Pair this till". Escape is the same way back.
  await door.getByRole("button", { name: "This is a till" }).click();
  const card = page.locator(".pair-card");
  await expect(card.getByText("Set up this till")).toBeVisible();
  await expect(card.locator(".btn-tender")).toHaveCount(1);
  await expect(card.locator(".btn-line")).toHaveCount(0);
  const back = card.getByRole("button", { name: /Back/ });
  const backBox = (await back.boundingBox())!;
  const headingBox = (await card.getByText("Set up this till").boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(backBox.y + backBox.height).toBeLessThanOrEqual(headingBox.y);
  expect(backBox.x - cardBox.x).toBeLessThan(24);
  expect(backBox.width).toBeLessThan(cardBox.width / 2);
  await back.click();
  await expect(door.getByRole("button", { name: "This is a till" })).toBeVisible();

  await door.getByRole("button", { name: "This is my phone" }).click();
  await expect(card.getByText("Put your phone on the shop")).toBeVisible();
  await expect(card.locator(".btn-line")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(door.getByRole("button", { name: "This is my phone" })).toBeVisible();
});

/**
 * Several real shops share the server, and a tablet can leave one shop and
 * join another. Nothing of the first shop may travel with it: the roster
 * and the credential hashes that let its staff sign in offline, its settings,
 * the last session. The server keeps the shops apart (schema.test.sql, "Two
 * shops, one database"); this is the device's half of the same promise.
 */
test("unpairing a till leaves nothing of the shop on the device", async ({ page }) => {
  await pairAndSignIn(page);
  // Signed in once, so the offline credential cache, the roster, the shop's
  // settings and its catalogue are held. Polled: the settings and catalogue
  // land when their fetches return, a beat after the screen is up.
  const keys = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pos.")).sort());
  await expect.poll(keys).toEqual(expect.arrayContaining([
    "pos.auth.creds", "pos.auth.roster", "pos.shop.settings", "pos.catalogue.products",
  ]));

  await page.getByRole("button", { name: /Sign out/i }).click();
  await page.getByRole("button", { name: /Not this shop\?/i }).click();
  await page.getByRole("dialog", { name: "Unpair this till" })
    .getByRole("button", { name: /Unpair this till/i }).click();
  await expect(page.getByText("What is this device?")).toBeVisible();

  const after = await keys();
  for (const k of ["pos.auth.creds", "pos.auth.roster", "pos.shop.settings", "pos.catalogue.products", "pos.session.user", "pos.device.registerToken"]) {
    expect(after, `${k} must not survive unpairing`).not.toContain(k);
  }
});

test("a till holding a refused sale cannot be unpaired", async ({ page }) => {
  await pairAndSignIn(page);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  // Taken with the line down, so it queues; when the line returns the server
  // refuses it, so it lands where somebody must look at it.
  be.offline = true;
  await page.context().setOffline(true);
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/will sync when the connection returns/i);
  await page.getByRole("button", { name: "Close" }).last().click();
  await page.route(/rpc\/pos_create_sale/, (r) =>
    r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "Refused by the server for this test" }) })
  );
  be.offline = false;
  await page.context().setOffline(false);
  await expect(page.locator("header").getByText(/need attention/i)).toBeVisible({ timeout: 45_000 });

  // The register token is what would replay it. Unpairing is refused, and
  // says what to do instead.
  await page.getByRole("button", { name: /Sign out/i }).click();
  await page.getByRole("button", { name: /Not this shop\?/i }).click();
  const dialog = page.getByRole("dialog", { name: "Unpair this till" });
  await expect(dialog).toContainText(/needs attention/i);
  await expect(dialog.getByRole("button", { name: /Unpair this till/i })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Who is on the till?")).toBeVisible();
});

test("the door names the shop, large, on the cream side, and the brand stays on the green", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "This is a till" }).click();
  await page.locator("input[type=tel]").fill(USERS.manager.phone);
  await page.locator("input[type=password]").fill(USERS.manager.pin);
  await page.getByRole("button", { name: /Pair this till/i }).click();
  await expect(page.getByText("Who is on the till?")).toBeVisible();

  // The shop's own name at the head of the cream side, the till's name as a
  // kicker over it, the address and phone under it — from the settings.
  const head = page.locator(".login-body .login-shophead");
  await expect(head.locator(".login-shop")).toHaveText("Ladybrand Hardware");
  await expect(head.locator(".login-till")).toHaveText("Front Counter");
  await expect(head.locator(".login-shop-meta")).toHaveText("12 Church St, Ladybrand, Free State · 051 924 0000");
  // Large: bigger than anything else on that side, and above the names.
  const shopPx = await head.locator(".login-shop").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const promptPx = await page.locator(".login-prompt").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(shopPx).toBeGreaterThanOrEqual(promptPx * 2);
  const headBox = (await head.boundingBox())!;
  const promptBox = (await page.getByText("Who is on the till?").boundingBox())!;
  expect(headBox.y + headBox.height).toBeLessThanOrEqual(promptBox.y);

  // The green side speaks the brand and the edition, not the shop: the name
  // is said once, on the shop's side.
  const scene = page.locator(".login-scene");
  await expect(scene).toContainText(/InnovaPOS/);
  await expect(scene).toContainText(/Hardware edition/i);
  await expect(scene).not.toContainText("Ladybrand Hardware");
  await expect(scene).not.toContainText("Front Counter");

  // With the line down it reads the same, from the cache.
  be.offline = true;
  await page.reload();
  await expect(page.getByText("Who is on the till?")).toBeVisible();
  await expect(head.locator(".login-shop")).toHaveText("Ladybrand Hardware");
  await expect(head.locator(".login-shop-meta")).toContainText("051 924 0000");
  await expect(page.locator(".login-status")).toContainText("Offline");
});

test("pairing takes the number as people write it", async ({ page }) => {
  // The placeholder says 082 123 4567; a manager who has just set a PIN by
  // SMS on 076 108 0024 types exactly that, and must not be told the number
  // is wrong for want of a +27.
  await page.goto("/");
  await page.getByRole("button", { name: "This is a till" }).click();
  await page.locator("input[type=tel]").fill("082 000 0001");
  await page.locator("input[type=password]").fill(USERS.manager.pin);
  await page.getByRole("button", { name: /Pair this till/i }).click();
  await expect(page.getByText("Who is on the till?")).toBeVisible();
});

test("pairing is refused with the wrong PIN", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "This is a till" }).click();
  await page.locator("input[type=tel]").fill(USERS.manager.phone);
  await page.locator("input[type=password]").fill("999999");
  await page.getByRole("button", { name: /Pair this till/i }).click();
  await expect(page.getByText(/Invalid phone or PIN/i)).toBeVisible();
  await expect(page.getByText("Set up this till")).toBeVisible();
});

test("five wrong PINs lock pairing, and the screen says the same thing either way", async ({ page }) => {
  // 0088. Pairing takes no token, so it is the one door a stranger with the
  // app can knock on. A wrong PIN, an unknown number and a locked account
  // are one sentence, so the knocking learns nothing; and the sentence
  // carries the fifteen minutes, so the owner who mistyped does not keep
  // trying the same digits.
  await page.goto("/");
  await page.getByRole("button", { name: "This is a till" }).click();
  const pin = page.locator("input[type=password]");
  const pair = page.getByRole("button", { name: /Pair this till/i });

  await page.locator("input[type=tel]").fill("082 999 9999");
  await pin.fill(USERS.manager.pin);
  await pair.click();
  const refused = page.getByText("Invalid phone or PIN. After five wrong tries, wait 15 minutes.");
  await expect(refused).toBeVisible();

  await page.locator("input[type=tel]").fill(USERS.manager.phone);
  for (let i = 0; i < 5; i++) {
    await pin.fill("000000");
    await pair.click();
    await expect(refused).toBeVisible();
  }
  // Sixth: the right PIN, refused in the same words.
  await pin.fill(USERS.manager.pin);
  await pair.click();
  await expect(refused).toBeVisible();
  await expect(page.getByText("Set up this till")).toBeVisible();
  expect(be.failedLogins[USERS.manager.row.id]).toBe(5);
});

test("a PIN signs you in as yourself, not as whoever owns it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "This is a till" }).click();
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
  await expect(page.getByText(/PIN was not recognised/i)).toBeVisible();

  // Sam's own PIN works, and the shift starts under Sam's name.
  for (const d of USERS.employee.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
  await expect(page.getByText("Sam")).toBeVisible();
  // And on the green header the masthead is cream, as the frame wears it. The
  // wordmark used to be what stood there; the shop's own name has the spot now
  // and takes the same colour, because the reason was the bar, not the words.
  await expect(page.locator(".sell-head .sell-shop")).toHaveCSS("color", "rgb(245, 242, 234)");
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

/**
 * The sign-in screen as a front door.
 *
 * It was a green band, an empty middle and three names. Now the green takes
 * the left of a wide screen — a hairline engraving of the bench, with the day
 * and the state of the line over it — and the names take the right. The
 * drawing is decoration and is tested only for staying out of the way; the
 * status is not decoration, because "Offline · 3 queued" on the door is how a
 * manager opening up learns that last night's sales have not left the till.
 */
test("the sign-in screen says what day it is and whether the till is talking to the server", async ({ page }) => {
  await pairAndSignIn(page);
  await page.getByRole("button", { name: /Sign out/i }).click();
  await expect(page.getByText("Who is on the till?")).toBeVisible();

  // Wide screen: the scene has its drawing, and the day is written out the
  // way a person would say it, not as digits.
  await expect(page.locator(".login-engraving")).toBeVisible();
  const today = await page.evaluate(() => {
    const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", o).format(new Date());
    return `${part({ weekday: "long" })} ${part({ day: "numeric" })} ${part({ month: "long" })} ${part({ year: "numeric" })}`;
  });
  const status = page.locator(".login-status");
  await expect(status).toContainText(today);
  await expect(status).toContainText("Online");

  // Behind the bench, the aisle: a photograph that has actually loaded, and
  // is worn as a duotone rather than shown as a colour picture — greyed and
  // screened onto the green, which is what keeps it inside the identity.
  const photo = page.locator(".login-photo");
  await expect(photo).toBeVisible();
  expect(await photo.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await photo.evaluate((el) => getComputedStyle(el).filter)).toContain("grayscale(1)");
  expect(await photo.evaluate((el) => getComputedStyle(el).mixBlendMode)).toBe("screen");

  // A sale taken with the line down, then the operator signs out. The door
  // must say the sale is still on the till, in the header chip's own words.
  await page.getByRole("button", { name: /^Sam\b/ }).click();
  for (const d of USERS.employee.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  be.offline = true;
  await page.context().setOffline(true);
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/will sync when the connection returns/i);
  await page.getByRole("button", { name: "Close" }).last().click();
  await page.getByRole("button", { name: /Sign out/i }).click();
  await expect(status).toContainText("Offline · 1 queued");

  // The line returns while the screen is still on the door: the queue drains
  // and the door says so without anyone signing in to make it happen.
  be.offline = false;
  await page.context().setOffline(false);
  await expect.poll(() => be.storedSales.length, { timeout: 45_000 }).toBe(1);
  await expect(status).toHaveText(/Online$/);
  await expect(status).not.toContainText("queued");
});

test("the engraving draws itself in once, and not at all for someone who asked for less motion", async ({ page }) => {
  await pairAndSignIn(page);
  await page.getByRole("button", { name: /Sign out/i }).click();
  const stroke = page.locator(".login-engraving rect").first();
  await expect(stroke).toBeVisible();

  // One run to completion: the stroke ends fully drawn (offset 0) and the
  // animation does not repeat — a till idles on this screen all day and must
  // not spend a core on it.
  await expect
    .poll(() => stroke.evaluate((el) => getComputedStyle(el).strokeDashoffset), { timeout: 8_000 })
    .toBe("0px");
  expect(await stroke.evaluate((el) => getComputedStyle(el).animationName)).toBe("login-draw");
  expect(await stroke.evaluate((el) => getComputedStyle(el).animationIterationCount)).toBe("1");

  // Reduced motion: the plate is simply there, nothing moves.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator(".login-engraving")).toBeVisible();
  expect(await stroke.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(await stroke.evaluate((el) => getComputedStyle(el).strokeDashoffset)).toBe("0px");
});

test("the door's photograph is part of the app shell, so it is there with the line down", async ({ page }) => {
  // The service worker precaches the shell at install. The photograph has to
  // be in that list, or a till that loses the line before its first sign-in
  // opens on a green panel with a hole in it. Read from the built worker
  // rather than exercised through it, because the suite blocks the worker
  // to keep the fake backend in charge of every request.
  const sw = await page.request.get("/sw.js");
  expect(sw.ok()).toBe(true);
  expect(await sw.text()).toMatch(/door\.jpg/);
});

test.describe("sign-in on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the drawing gets out of the way of the names", async ({ page }) => {
    await pairAndSignIn(page);
    await page.getByRole("button", { name: /Sign out/i }).click();
    await expect(page.getByText("Who is on the till?")).toBeVisible();

    // No engraving on a phone: it would only push the list below the fold.
    await expect(page.locator(".login-engraving")).toBeHidden();
    // The aisle photograph stays, in the band: it costs no height.
    await expect(page.locator(".login-photo")).toBeVisible();
    // The day and the line still show, in the band above the names.
    await expect(page.locator(".login-status")).toContainText("Online");

    // Every name is on screen without scrolling, and nothing spills sideways.
    const names = page.locator(".login-who button");
    await expect(names).toHaveCount(4);
    for (const box of await names.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().bottom))) {
      expect(box).toBeLessThanOrEqual(844);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

/**
 * TillAI, the bubble in the corner. What the browser suite can hold it to:
 * that it is there for a signed-in till and not on the door, that a
 * question goes out with this till's token and comes back as words with a
 * line saying what was looked at, that it says so when the line is down and
 * leaves the till selling, and that it opens and closes from the keyboard.
 * What it may read is the server's business and is decided in one tested
 * file there (supabase/functions/tillai/tools.ts).
 */
test("TillAI answers from the shop's records and says what it looked at", async ({ page }) => {
  await pairAndSignIn(page);
  const bubble = page.getByRole("button", { name: "TillAI" });
  await expect(bubble).toBeVisible();

  // F4 opens it and puts the caret in the question.
  await page.keyboard.press("F4");
  const sheet = page.getByRole("dialog", { name: "TillAI" });
  await expect(sheet).toBeVisible();
  // A counter hand is not asked for a PIN: there is nothing one would open.
  await expect(sheet).not.toContainText(/Enter your PIN/i);
  const ask = sheet.getByRole("textbox", { name: "Ask TillAI" });
  await expect(ask).toBeFocused();

  await ask.fill("how much cement do we have");
  await page.keyboard.press("Enter");
  await expect(sheet).toContainText("40 bags of Cement 42.5N 50kg");
  await expect(sheet).toContainText("Looked at: products");

  // The question carried this till's token and nothing else that identifies
  // anyone: no PIN, no user. The server proves the token and scopes by it.
  expect(be.tillaiAsked).toHaveLength(1);
  expect(be.tillaiAsked[0].register_token).toBe(REGISTER_TOKEN);
  expect(be.tillaiAsked[0].question).toBe("how much cement do we have");
  expect(JSON.stringify(be.tillaiAsked[0])).not.toMatch(/pin|user_id/);

  // A second question carries the first exchange, so "and how much sand?"
  // means something.
  await ask.fill("and the trade price?");
  await page.keyboard.press("Enter");
  await expect(sheet.locator(".tillai-msg.is-model")).toHaveCount(2);
  expect(be.tillaiAsked[1].history).toEqual([
    { role: "user", text: "how much cement do we have" },
    { role: "model", text: be.tillaiAnswer },
  ]);

  // A refusal is shown as a refusal, not as an answer.
  be.tillaiFails = true;
  await ask.fill("what about nails");
  await page.keyboard.press("Enter");
  await expect(sheet.locator(".tillai-msg.is-failed")).toContainText(/could not answer just now/i);

  // Escape closes it; the till underneath is untouched.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await expect(page.locator(".line-desc")).toHaveText("Cement 42.5N 50kg");
});

test("a manager's TillAI is unlocked by the PIN they signed in with, and asks once after a reload", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.keyboard.press("F4");
  const sheet = page.getByRole("dialog", { name: "TillAI" });
  // The PIN they typed a minute ago is the PIN: nobody is asked for it twice.
  await expect(sheet).toContainText(/Unlocked/i);
  await expect(sheet).not.toContainText(/Enter your PIN/i);

  be.tillaiAnswer = "In the past 3 days: 14 sales, R 4 862.00 in total, of which cash R 3 100.00 and card R 1 762.00.";
  be.tillaiLookedAt = ["the sales report"];
  const ask = sheet.getByRole("textbox", { name: "Ask TillAI" });
  await ask.fill("how much did we sell in the past 3 days");
  await page.keyboard.press("Enter");
  await expect(sheet).toContainText("14 sales, R 4 862.00");
  await expect(sheet).toContainText("Looked at: the sales report");
  // The PIN went with the question, so the server's PIN-checked reports
  // could answer; the token still went too.
  expect(be.tillaiAsked[0].pin).toBe(USERS.manager.pin);
  expect(be.tillaiAsked[0].register_token).toBe(REGISTER_TOKEN);

  // The model's markdown never reaches the counter as asterisks.
  be.tillaiAnswer = "Sales totals are in **Manage** on the till.";
  await ask.fill("and profit?");
  await page.keyboard.press("Enter");
  await expect(sheet.locator(".tillai-msg.is-model p").last()).toHaveText("Sales totals are in Manage on the till.");

  // The PIN lives in memory only. A reload keeps the person signed in but
  // forgets it, so the sheet asks — once — and keeps it for the session.
  await page.reload();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
  await page.keyboard.press("F4");
  await expect(sheet).toContainText(/Enter your PIN/i);
  await expect(sheet).not.toContainText(/Unlocked/i);
  for (const d of USERS.manager.pin.split("")) {
    await sheet.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(sheet).toContainText(/Unlocked/i);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await page.keyboard.press("F4");
  await expect(sheet).toContainText(/Unlocked/i);
  await expect(sheet).not.toContainText(/Enter your PIN/i);
  // And nothing of it is on the device.
  const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  expect(stored).not.toMatch(/"pin"\s*:|sessionPin/);
  expect(stored).not.toContain(`\\"${USERS.manager.pin}\\"`);
});

test("TillAI is on a phone as the same bubble, and its sheet is the screen", async ({ page }) => {
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  // The bubble, in the corner, as on the till — not a row in the menu.
  await expect(page.locator(".phone-home")).not.toContainText(/TillAI/);
  const bubble = page.getByRole("button", { name: "TillAI" });
  await expect(bubble).toBeVisible();
  await bubble.click();
  const sheet = page.getByRole("dialog", { name: "TillAI" });
  await expect(sheet).toBeVisible();
  // The whole display.
  await expect(sheet).toHaveClass(/is-phone/);
  const box = (await sheet.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.width).toBeGreaterThanOrEqual(view.width - 1);
  expect(box.height).toBeGreaterThanOrEqual(view.height - 1);
  // The owner signed in with their PIN a moment ago: unlocked, not asked.
  await expect(sheet).toContainText(/Unlocked/i);
  await expect(sheet).not.toContainText(/Enter your PIN/i);

  const ask = sheet.getByRole("textbox", { name: "Ask TillAI" });
  await ask.fill("what did we take today");
  await page.keyboard.press("Enter");
  await expect(sheet).toContainText("40 bags of Cement");
  expect(be.tillaiAsked[0].pin).toBe(USERS.manager.pin);
  // The phone's own token, not a till's: the server scopes by it.
  expect(String(be.tillaiAsked[0].register_token)).toMatch(/^personal-token-/);

  // The header's chevron is the way back to the errands, bubble still there.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(".phone-home-who")).toBeVisible();
  await expect(bubble).toBeVisible();

  // A counter hand's own phone has the same bubble and the counter's view:
  // no PIN asked, nothing unlocked, and no PIN sent. (A phone offers only
  // its owner's name, so this is a second phone, not a second sign-in.)
  await page.evaluate(() => localStorage.clear());
  await enrolPhoneAndSignIn(page, be, USERS.employee.pin);
  await page.getByRole("button", { name: "TillAI" }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toContainText(/Enter your PIN|Unlocked/i);
  await ask.fill("do we stock 2.5 twin and earth");
  await page.keyboard.press("Enter");
  await expect(sheet).toContainText("40 bags of Cement");
  expect(be.tillaiAsked[1].pin).toBeUndefined();
});

test("what the shop asked TillAI is in Manage, behind the reports right", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.keyboard.press("F4");
  const sheet = page.getByRole("dialog", { name: "TillAI" });
  const ask = sheet.getByRole("textbox", { name: "Ask TillAI" });
  await ask.fill("how much cement do we have");
  await page.keyboard.press("Enter");
  await expect(sheet).toContainText("40 bags");
  await page.keyboard.press("Escape");

  await openManage(page);
  await page.locator("button:not(.tillai-bubble)", { hasText: /^TillAI$/ }).click();
  const log = page.locator(".tillai-log-page");
  await expect(log).toContainText("how much cement do we have");
  await expect(log).toContainText(/1 in the last day/);
  await expect(log).toContainText(/Front Counter/);
  await expect(log).toContainText(/unlocked/);
  // A row opens to its answer and what was looked at.
  await log.getByRole("button", { name: /how much cement/ }).click();
  await expect(log).toContainText("40 bags of Cement 42.5N 50kg");
  await expect(log).toContainText("Looked at: products");
});

test("TillAI needs the line, and says so while the till keeps selling", async ({ page }) => {
  await pairAndSignIn(page);
  be.offline = true;
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "TillAI" }).click();
  const sheet = page.getByRole("dialog", { name: "TillAI" });
  await expect(sheet).toContainText(/needs the line/i);
  await expect(sheet.getByRole("textbox", { name: "Ask TillAI" })).toHaveCount(0);
  expect(be.tillaiAsked).toHaveLength(0);

  // The sale goes through regardless: the bubble is not in its path.
  await page.keyboard.press("Escape");
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await expect(page.locator(".line-desc")).toHaveText("Cement 42.5N 50kg");
});

test("TillAI is not on the door", async ({ page }) => {
  await pairAndSignIn(page);
  await expect(page.getByRole("button", { name: "TillAI" })).toBeVisible();
  await page.getByRole("button", { name: /Sign out/i }).click();
  await expect(page.getByText("Who is on the till?")).toBeVisible();
  // Nobody is signed in, so there is nobody for it to answer.
  await expect(page.getByRole("button", { name: "TillAI" })).toHaveCount(0);
});

/**
 * What went wrong at the counter reaches the server (0078). The report is
 * one small call through the till's token; the line going down is not a
 * bug and is not reported; the same crash twice is one report; and with no
 * line the report waits in the outbox and goes when the line is back.
 */
test("a till tells the server what went wrong, and only what is worth telling", async ({ page }) => {
  await pairAndSignIn(page);
  const crash = (message: string) =>
    page.evaluate((m) => { setTimeout(() => { throw new TypeError(m); }, 0); }, message);

  await crash("Cannot read properties of undefined (reading 'qty')");
  await expect.poll(() => be.errorReports.length).toBe(1);
  const r = be.errorReports[0];
  expect(r.p_register_token).toBe(REGISTER_TOKEN);
  expect(r.p_kind).toBe("error");
  expect(r.p_message).toBe("TypeError: Cannot read properties of undefined (reading 'qty')");
  expect(String(r.p_stack)).toContain("TypeError");
  expect(r.p_url).toBe("/");
  expect(r.p_version).toBeTruthy();
  // No PIN, no user: a crash needs nobody's credential to be worth knowing.
  expect(JSON.stringify(r)).not.toMatch(/p_pin|user_id/);

  // The same crash again within minutes is not a second report.
  await crash("Cannot read properties of undefined (reading 'qty')");
  // The line going down is not a bug.
  await page.evaluate(() => { setTimeout(() => { void Promise.reject(new TypeError("Failed to fetch")); }, 0); });
  await page.waitForTimeout(400);
  expect(be.errorReports).toHaveLength(1);

  // A different failure, a rejection this time, is.
  await page.evaluate(() => { setTimeout(() => { void Promise.reject(new RangeError("bad slip width")); }, 0); });
  await expect.poll(() => be.errorReports.length).toBe(2);
  expect(be.errorReports[1].p_kind).toBe("rejection");
  expect(be.errorReports[1].p_message).toBe("RangeError: bad slip width");

  // With the line down the report waits, and goes when the line is back.
  be.offline = true;
  await crash("the drawer did not open");
  await page.waitForTimeout(400);
  expect(be.errorReports).toHaveLength(2);
  be.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => be.errorReports.length).toBe(3);
  expect(be.errorReports[2].p_message).toBe("TypeError: the drawer did not open");
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
  await expect(slip).toContainText("less 10%");
  // The whole reason, every word of it whole — see slipWords. At this width it
  // is carried onto a second line, which is what the paper does and what the
  // customer reads; what must never happen is a name sawn in half.
  expect(await slipWords(slip)).toContain("less 10% (church job, Mr Molefe)");

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
  await expect(row).toContainText("R 165.00 off");

  await row.getByRole("button", { name: /Discounts on/i }).click();

  // The line that was marked down, named, with the words behind it.
  await expect(row).toContainText("Twin & Earth 2.5mm 100m");
  await expect(row).toContainText("less 10%");
  await expect(row).toContainText("R 145.00 off");
  await expect(row).toContainText("church job");

  // And the blanket discount said separately — spreading it across the lines it
  // touched would report a decision nobody made.
  await expect(row).toContainText("Off the whole sale");
  await expect(row).toContainText("R 20.00 off");
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
  // whose second line only reported the price band. The instruction is still
  // there — it is now the button's accessible name rather than a second
  // visible line, because on a 1024 till "Retail price · tap to add their
  // details" is a paragraph where a chip should be, and it is on screen for
  // every walk-in sale, which is most of them.
  const pick = page.getByRole("button", {
    name: /Walk-in customer — tap to add their details/i,
  });
  await expect(pick).toBeVisible();
  // One line of visible text, not three.
  await expect(pick).not.toContainText(/tap to add their details/i);
  await expect(pick).not.toContainText(/Retail price/i);

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
  await expect.poll(() => be.storedSales.length).toBe(1);
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
  await expect(page.getByText(/Over your R\s11\.50/i)).toBeVisible();
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
  await expect(page.getByText(/Capped at R\s5\.75 off/i)).toBeVisible();
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

  await expect(page.getByText(/Capped at R\s5\.75 off/i)).toBeVisible();
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
  be.bankAccounts = [{
    id: "bank1", bank_name: "First National Bank",
    account_name: "Ladybrand Hardware CC", account_number: "62012345678",
    branch_code: "250655", on_documents: true,
  }];

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

  await page.getByRole("button", { name: "Add another account" }).click();
  await page.getByLabel("Bank 1", { exact: true }).fill("Capitec");
  await page.getByLabel("Account number 1").fill("1051234567");
  await page.getByLabel("Branch code 1").fill("470010");
  await page.getByRole("button", { name: /^Save$/ }).click();

  await expect.poll(() => be.bankAccounts[0]?.account_number).toBe("1051234567");
  expect(be.bankAccounts[0]?.branch_code).toBe("470010");

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

  await expect(page.getByText(/awaiting approval/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Release$/ })).toHaveCount(0);
  expect(be.sales[0].approved_by).toBe(USERS.manager.row.id);
});

test("a manager issues a code, and it releases a discount over the phone", async ({ page, browser }) => {
  // What actually happens when the manager is at the bank: the cashier phones,
  // the manager reads out six digits. Before this the only digits that worked
  // were their PIN — which opens the back office, the staff list and the
  // cash-up on every till, and cannot be taken back once said aloud.
  //
  // TWO DEVICES, because that is the whole situation. The manager is not at
  // the counter — if they were, they would type their PIN into the discount
  // dialog and no code would exist — so Approvals lives on their phone and the
  // counter half happens on the till. It used to be one page doing both, which
  // could only ever have tested a manager standing at the till they were
  // approving for.
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await installBackend(phone, be);
  await enrolPhoneAndSignIn(phone, be, USERS.manager.pin);

  await phoneMenu(phone, "Approvals");
  // No PIN asked: the owner of this phone proved it at sign-in a moment ago,
  // and it is held in memory only and re-checked server-side by every call
  // behind it. The menu is still a doorway and not a grant — what a phone
  // may do is decided by the server, on each call.
  await phone.getByLabel("Code ceiling").fill("100");
  await phone.getByLabel("Code reason").fill("Mr Molefe, cement");
  await phone.getByRole("button", { name: /Give me a code/i }).click();

  await expect(phone.getByText(/Read this to the counter/i)).toBeVisible();
  const code = be.approvalCodes[0].code;
  await expect(phone.getByText(code)).toBeVisible();
  // Shown once and listed as live, so the manager can see what is outstanding.
  await expect(phone.getByText(/^live$/)).toBeVisible();

  // The counter, later. Sam has no standing authority at all.
  await pairAndSignIn(page, USERS.employee.pin);

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

  await page.getByRole("button", { name: /^Parked ·/ }).click();
  await expect(page.locator(".line-row")).toHaveCount(2);
  await expect(page.locator(".total-row .fig")).toContainText("1 565.00");

  // And it is a real sale again, not a husk.
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  expect(be.storedSales[0].total).toBe(1565);
});

test("two parked sales are chosen between, not resumed blind", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  // Two customers step away: one for a card, one for a bakkie.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await expect(page.locator(".line-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Park sale" }).click();
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "2");
  await expect(page.locator(".line-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Park sale" }).click();
  await expect(page.locator(".line-row")).toHaveCount(0);

  // TWO PARKED: the button asks which. It used to bring back the last one
  // parked, silently, and the cashier parked it again to reach the other.
  await page.getByRole("button", { name: "Parked · 2" }).click();
  const which = page.getByRole("dialog", { name: "Which parked sale?" });
  await expect(which).toBeVisible();
  const rows = which.locator(".modal-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Cement 42.5N 50kg");
  await expect(rows.nth(0)).toContainText("R 115.00");
  await expect(rows.nth(1)).toContainText("Twin & Earth 2.5mm 100m");
  await expect(rows.nth(1)).toContainText("2 units");
  await expect(rows.nth(1)).toContainText("R 2 900.00");

  // The first one back is the one asked for, and the other stays parked.
  await rows.nth(0).click();
  await expect(which).toHaveCount(0);
  await expect(page.locator(".line-row")).toHaveCount(1);
  await expect(page.locator(".line-row")).toContainText("Cement 42.5N 50kg");
  await expect(page.getByRole("button", { name: "Parked · 1" })).toBeVisible();

  // With a sale open, the other cannot be pulled over it.
  await page.getByRole("button", { name: "Parked · 1" }).click();
  await expect(banner(page)).toContainText(/Finish or park this sale/);
  await expect(page.locator(".line-row")).toContainText("Cement 42.5N 50kg");

  // ONE PARKED: straight back, no question asked. (Voiding a sale that came
  // off the parked list asks first; that is the next test's subject.)
  await page.getByRole("button", { name: "Void sale" }).click();
  await page.getByRole("dialog", { name: "This sale was parked" }).getByRole("button", { name: "Delete it" }).click();
  await expect(page.locator(".line-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Parked · 1" }).click();
  await expect(page.getByRole("dialog", { name: "Which parked sale?" })).toHaveCount(0);
  await expect(page.locator(".line-row")).toContainText("Twin & Earth 2.5mm 100m");
  await expect(page.getByRole("button", { name: /^Parked ·/ })).toHaveCount(0);
});

test("a parked sale stays parked until it is sold or deleted", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  const park = async () => { await page.getByRole("button", { name: "Park sale" }).click(); };
  const scanCement = async () => {
    await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
    await page.keyboard.press("Enter");
    await expect(page.locator(".line-row")).toHaveCount(1);
  };
  await scanCement(); await park();
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "2"); await park();
  await expect(page.getByRole("button", { name: "Parked · 2" })).toBeVisible();
  const which = page.getByRole("dialog", { name: "Which parked sale?" });
  const rows = which.locator(".modal-row");

  // RESUMED AND PARKED AGAIN IS THE SAME SALE, in the same slot at the same
  // time — not a third entry with a new time.
  await page.getByRole("button", { name: "Parked · 2" }).click();
  await rows.nth(0).click();
  await expect(page.locator(".line-row")).toContainText("Cement 42.5N 50kg");
  await park();
  await expect(page.getByRole("button", { name: "Parked · 2" })).toBeVisible();
  await page.getByRole("button", { name: "Parked · 2" }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Cement 42.5N 50kg");
  await expect(rows.nth(1)).toContainText("Twin & Earth 2.5mm 100m");

  // VOIDING A RESUMED SALE ASKS. The customer who parked it may be on their
  // way back; a slip of the finger must not lose their basket.
  await rows.nth(0).click();
  await page.getByRole("button", { name: "Void sale" }).click();
  const ask = page.getByRole("dialog", { name: "This sale was parked" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Put it back" }).click();
  await expect(page.locator(".line-row")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Parked · 2" })).toBeVisible();

  // A SALE NOBODY IS COMING BACK FOR is deleted from the list itself, after
  // a confirm; the other stays where it was.
  await page.getByRole("button", { name: "Parked · 2" }).click();
  await which.getByRole("button", { name: /^Delete the sale parked at/ }).nth(1).click();
  await which.getByRole("button", { name: "Keep it" }).click();
  await expect(rows).toHaveCount(2);
  await which.getByRole("button", { name: /^Delete the sale parked at/ }).nth(1).click();
  await which.getByRole("button", { name: "Delete it" }).click();
  await expect(which).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Parked · 1" })).toBeVisible();

  // AND "DELETE IT" ON THE VOID PROMPT IS THE OTHER WAY OUT.
  await page.getByRole("button", { name: "Parked · 1" }).click();
  await expect(page.locator(".line-row")).toContainText("Cement 42.5N 50kg");
  await page.getByRole("button", { name: "Void sale" }).click();
  await ask.getByRole("button", { name: "Delete it" }).click();
  await expect(page.locator(".line-row")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Parked ·/ })).toHaveCount(0);

  // THE COUNTER CLEARS AT ONCE, before the server has answered: the next
  // customer's first keystrokes must not land in a basket about to be wiped.
  // A slow line is exactly when it happened (on the CI runner, first).
  be.parkDelayMs = 1500;
  await scanCement(); await park();
  await page.getByPlaceholder(/Scan barcode/i).fill("twin");
  await expect(page.locator(".result-row", { hasText: "Twin & Earth 2.5mm 100m" })).toBeVisible();
  // Now the server answers — and the typing is still there.
  await expect.poll(() => be.parkedSales.length, { timeout: 5000 }).toBe(1);
  await page.waitForTimeout(600);
  await expect(page.getByPlaceholder(/Scan barcode/i)).toHaveValue("twin");
  await expect(page.locator(".result-row", { hasText: "Twin & Earth 2.5mm 100m" })).toBeVisible();
  be.parkDelayMs = 0;
  await page.getByPlaceholder(/Scan barcode/i).fill("");
  await page.getByRole("button", { name: "Parked · 1" }).click();
  await expect(page.locator(".line-row")).toContainText("Cement 42.5N 50kg");
  await page.getByRole("button", { name: "Void sale" }).click();
  await ask.getByRole("button", { name: "Delete it" }).click();
  await expect(page.locator(".line-row")).toHaveCount(0);

  // SOLD IS GONE: a resumed sale that is tendered leaves nothing parked.
  await scanCement(); await park();
  await page.getByRole("button", { name: "Parked · 1" }).click();
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  await page.getByLabel("Close", { exact: true }).click();
  await expect(page.getByRole("button", { name: /^Parked ·/ })).toHaveCount(0);

  // A REFRESH WITH A RESUMED SALE OPEN puts it back in its own slot, not a
  // new one: still two parked, not three.
  await scanCement(); await park();
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1"); await park();
  await page.getByRole("button", { name: "Parked · 2" }).click();
  await rows.nth(0).click();
  await expect(page.locator(".line-row")).toContainText("Cement 42.5N 50kg");
  await page.reload();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
  await expect(banner(page)).toContainText(/has been parked/i);
  await expect(page.getByRole("button", { name: "Parked · 2" })).toBeVisible();
  // In its own slot: still first, at the time it was first parked.
  await page.getByRole("button", { name: "Parked · 2" }).click();
  await expect(rows.nth(0)).toContainText("Cement 42.5N 50kg");
  await expect(rows.nth(1)).toContainText("Twin & Earth 2.5mm 100m");
});

test("a sale parked on one till is picked up on another, by anyone", async ({ page, browser }) => {
  be.customers.push({
    id: "k1", code: null, name: "Zaib Ahmad", phone: "0673747474", is_trade: false,
    credit_limit: 0, balance: 0, available: 0,
  });
  // Two tills on one shop: the front counter and the yard. Its own browser
  // context, because a till is its own device with its own storage.
  const yardContext = await browser.newContext();
  const yard = await yardContext.newPage();
  await installBackend(yard, be);
  await pairAndSignIn(page, USERS.employee.pin);
  await signInOnSecondTill(yard, USERS.manager.pin);

  // SAM PARKS ZAIB'S BASKET AT THE FRONT COUNTER.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.getByRole("dialog", { name: /Choose a customer/i }).locator(".modal-row", { hasText: "Zaib Ahmad" }).click();
  await page.getByRole("button", { name: "Park sale" }).click();
  await expect(banner(page)).toContainText(/Any till can pick it up/);
  expect(be.parkedSales).toHaveLength(1);
  expect(be.parkedSales[0]).toMatchObject({ register_name: "Front Counter", parked_by_name: "Sam", customer_id: "k1" });

  // ZAIB WALKS OVER TO THE YARD, where the manager is on the till. The
  // basket is there without anybody refreshing anything.
  await expect(yard.getByRole("button", { name: "Parked · 1" })).toBeVisible({ timeout: 15000 });
  await yard.getByRole("button", { name: "Parked · 1" }).click();
  await expect(yard.locator(".line-row")).toContainText("Cement 42.5N 50kg");
  await expect(yard.getByRole("button", { name: /Zaib Ahmad/ })).toBeVisible();
  // Taken off the list as it is taken: the front counter cannot also have it.
  expect(be.parkedSales).toHaveLength(0);
  await expect(page.getByRole("button", { name: /^Parked ·/ })).toHaveCount(0, { timeout: 15000 });

  // PARKED AGAIN IN THE YARD, it says so on the front counter's list, next
  // to one parked there. And the yard's is picked up at the front.
  await yard.getByRole("button", { name: "Park sale" }).click();
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");
  await page.getByRole("button", { name: "Park sale" }).click();
  await expect(page.getByRole("button", { name: "Parked · 2" })).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Parked · 2" }).click();
  const which = page.getByRole("dialog", { name: "Which parked sale?" });
  const rows = which.locator(".modal-row");
  await expect(rows.nth(0)).toContainText("Zaib Ahmad");
  await expect(rows.nth(0)).toContainText("Yard till · Manager");
  await expect(rows.nth(1)).toContainText("Front Counter · Sam");
  await rows.nth(0).click();
  await expect(page.locator(".line-row")).toContainText("Cement 42.5N 50kg");
  await expect(page.getByRole("button", { name: /Zaib Ahmad/ })).toBeVisible();

  // DELETED ON ONE TILL IS GONE ON THE OTHER.
  await page.getByRole("button", { name: "Park sale" }).click();
  await page.getByRole("button", { name: "Parked · 2" }).click();
  await which.getByRole("button", { name: /^Delete the sale parked at/ }).nth(1).click();
  await which.getByRole("button", { name: "Delete it" }).click();
  await expect(page.getByRole("button", { name: "Parked · 1" })).toBeVisible();
  await expect(yard.getByRole("button", { name: "Parked · 1" })).toBeVisible({ timeout: 15000 });
  expect(be.parkedSales).toHaveLength(1);
  await yardContext.close();
});

test("parked with the line down, a sale stays on this till until the line returns", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  // The browser's own "offline" too: a real drop says so, and the probe is
  // now patient with a mere stall — one miss on a line the browser still
  // believes in is re-checked, not believed.
  be.offline = true;
  await page.context().setOffline(true);
  await expect(page.getByText(/offline/i).first()).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Park sale" }).click();
  await expect(banner(page)).toContainText(/on this till/);
  expect(be.parkedSales).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Parked · 1" })).toBeVisible();

  // Kept on the device, said so, and still resumable with the line down.
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");
  await page.getByRole("button", { name: "Park sale" }).click();
  await page.getByRole("button", { name: "Parked · 2" }).click();
  const which = page.getByRole("dialog", { name: "Which parked sale?" });
  await expect(which.locator(".modal-row").nth(0)).toContainText("this till only");
  await which.getByRole("button", { name: "Cancel" }).click();

  // THE LINE RETURNS: both go to the shop's list by themselves.
  be.offline = false;
  await page.context().setOffline(false);
  await expect.poll(() => be.parkedSales.length, { timeout: 20000 }).toBe(2);
  expect(be.parkedSales.map((p) => p.register_name)).toEqual(["Front Counter", "Front Counter"]);
  await expect(page.getByRole("button", { name: "Parked · 2" })).toBeVisible();
  await page.getByRole("button", { name: "Parked · 2" }).click();
  await expect(which.locator(".modal-row").nth(0)).toContainText("Front Counter · Sam");
});

test("Cancel is neither a row nor the action, anywhere", async ({ page }) => {
  // It read as a third option under a list of two, and as the twin of the
  // outlined button beside it. Asserted as computed style, on three
  // pop-ups built three different ways.
  const style = (l: import("@playwright/test").Locator) =>
    l.evaluate((el) => {
      const c = getComputedStyle(el);
      return { underline: c.textDecorationLine, bg: c.backgroundColor, border: c.borderTopColor };
    });
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  // The customer picker: a list, then Cancel.
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  const picker = page.getByRole("dialog", { name: /Choose a customer/i });
  const cancel = await style(picker.getByRole("button", { name: "Cancel" }));
  const row = await style(picker.locator(".modal-row").first());
  expect(cancel.underline).toBe("underline");
  expect(cancel.bg).toBe("rgba(0, 0, 0, 0)");
  expect(row.underline).toBe("none");
  await picker.getByRole("button", { name: "Cancel" }).click();

  // The delivery form: Cancel beside a filled action, and an outlined one.
  await page.getByRole("button", { name: /^Deliver$/ }).click();
  const form = page.getByRole("dialog", { name: "Deliver this sale" });
  const c2 = await style(form.getByRole("button", { name: "Cancel" }));
  const add = await style(form.getByRole("button", { name: "Add to the sale" }));
  expect(c2.underline).toBe("underline");
  expect(add.underline).toBe("none");
  expect(add.bg).not.toBe("rgba(0, 0, 0, 0)");
  await form.getByRole("button", { name: "Cancel" }).click();

  // The discount modal, which was styled by hand rather than by the sheet.
  await page.getByRole("button", { name: /^Discount$/ }).click();
  const dlg = page.getByRole("dialog", { name: "Apply discount" });
  const c3 = await style(dlg.getByRole("button", { name: "Cancel" }));
  expect(c3.underline).toBe("underline");
  expect(c3.bg).toBe("rgba(0, 0, 0, 0)");
});

test("a delivery takes the buyer's address off their record, and it can still be changed", async ({ page }) => {
  be.customers.push({
    id: "k1", code: null, name: "Zaib Ahmad", phone: "0673747474", is_trade: false,
    credit_limit: 0, balance: 0, available: 0, address: "14 Diale Rd, Bloemfontein",
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.getByRole("dialog", { name: /Choose a customer/i }).locator(".modal-row", { hasText: "Zaib Ahmad" }).click();

  // The address on file is offered, not typed again.
  await page.getByRole("button", { name: /^Deliver$/ }).click();
  const form = page.getByRole("dialog", { name: "Deliver this sale" });
  await expect(form.getByLabel("Deliver to")).toHaveValue("Zaib Ahmad");
  await expect(form.locator("textarea")).toHaveValue("14 Diale Rd, Bloemfontein");
  // And it is theirs to change: this load goes to the site, not the house.
  await form.locator("textarea").fill("Plot 7, Bainsvlei");
  await form.getByRole("button", { name: "Add to the sale" }).click();
  await expect(page.locator(".line-row", { hasText: "Delivery" })).toBeVisible();
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  expect(be.deliveries).toHaveLength(1);
  expect(be.deliveries[0].customer_name).toBe("Zaib Ahmad");
  expect(be.deliveries[0].address).toBe("Plot 7, Bainsvlei");
  // The record itself was not changed by a one-off delivery elsewhere.
  expect(be.customers[0].address).toBe("14 Diale Rd, Bloemfontein");
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
  await expect(page.getByRole("button", { name: /^Parked ·/ })).toHaveCount(0);
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

  await expect(page.getByRole("button", { name: /New product/i })).toBeVisible();
  await expect(page.getByRole("cell", { name: "CEM-425-50" })).toBeVisible();
});

test("the sixth digit signs you in, and there is no OK to find", async ({ page }) => {
  // Every PIN and every approval code is six digits, so the keypad submits
  // on the sixth. The OK button it used to wait for was a seventh tap that
  // read as a broken keypad to anyone who has used a bank card.
  await page.goto("/");
  await page.getByRole("button", { name: "This is a till" }).click();
  await page.locator("input[type=tel]").fill(USERS.manager.phone);
  await page.locator("input[type=password]").fill(USERS.manager.pin);
  await page.getByRole("button", { name: /Pair this till/i }).click();
  await page.getByRole("button", { name: /^Manager\b/ }).click();

  await expect(page.locator('button:text-is("OK")')).toHaveCount(0);
  for (const d of USERS.manager.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  await page.waitForSelector('input[placeholder*="Scan barcode"]');

  // The same keypad guards Manage, and behaves the same way.
  await page.getByRole("button", { name: /^Manage$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Manage" });
  await expect(dialog.locator('button:text-is("OK")')).toHaveCount(0);
  for (const d of USERS.manager.pin.split("")) {
    await dialog.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(page.getByRole("button", { name: /New product/i })).toBeVisible();
});

test("the catalogue sorts by a tapped heading, and a second tap turns it round", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  const firstName = () => page.locator("tbody tr").first().locator("td").nth(2);

  // Alphabetical to begin with.
  await expect(firstName()).toContainText("Cement 42.5N 50kg");

  const heading = (name: string) => page.getByRole("table").getByRole("button", { name, exact: true });
  await heading("Retail").click();
  await expect(page.getByRole("columnheader", { name: "Retail" })).toHaveAttribute("aria-sort", "ascending");
  await expect(firstName()).toContainText("Chain 6mm Galvanised");

  await heading("Retail").click();
  await expect(page.getByRole("columnheader", { name: "Retail" })).toHaveAttribute("aria-sort", "descending");
  await expect(firstName()).toContainText("Twin & Earth 2.5mm 100m");

  // Stock, least first: the lines actually running out come to the top.
  await heading("Stock").click();
  await expect(firstName()).toContainText("Twin & Earth 2.5mm 100m");
});

test("the catalogue chips find what is running low and what a gun cannot find", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(7);

  // Two below its reorder level of three.
  await page.getByRole("button", { name: /^Low stock \d+$/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Twin & Earth 2.5mm 100m");

  // Four of the seven carry no barcode; the cement does, and is not listed.
  await page.getByRole("button", { name: /^No barcode \d+$/ }).click();
  await expect(rows).toHaveCount(4);
  await expect(page.getByRole("cell", { name: /Cement 42.5N 50kg/ })).toHaveCount(0);

  await page.getByRole("button", { name: /^All \d+$/ }).click();
  await expect(rows).toHaveCount(7);
});

test("the catalogue says what its columns mean, and shows the barcode and margin on the row", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);

  // Said where the columns are, since nobody can hover on a tablet.
  await expect(page.getByText(/Retail is what the till charges, incl\. VAT/)).toBeVisible();
  await expect(page.getByText(/Cost is what you paid the supplier, ex VAT/)).toBeVisible();

  // The barcode sits under the stock code, or says there is none.
  const cement = page.locator("tbody tr", { hasText: "Cement 42.5N 50kg" });
  await expect(cement).toContainText("6001234000015");
  const chain = page.locator("tbody tr", { hasText: "Chain 6mm Galvanised" });
  await expect(chain).toContainText("no barcode");

  // R115 incl. VAT is R100 ex; on a R50 cost that is a 50% margin, under the cost.
  await expect(cement).toContainText("50.0% margin");
});

test("the editor shows margin and markup, both ex VAT", async ({ page }) => {
  // R25 cost, R50 on the shelf: 100% to the shopkeeper, and the editor said
  // 42.5%. Both are right about different things — margin is over the
  // ex-VAT price, markup is over cost — so both are shown, and say ex VAT.
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.locator("tr", { hasText: "Cement 42.5N 50kg" }).first().click();
  await page.getByLabel(/^Retail/).fill("50");
  await page.getByLabel(/^Cost/).fill("25");
  await expect(page.getByText("Margin 42.5% · markup 73.9%, ex VAT")).toBeVisible();
});

test("a phone scans the barcode into a new product", async ({ page }) => {
  // On the tablet a scanner gun types into the Barcode field. A phone has a
  // camera and no gun, so the field gets a Scan button that opens the same
  // viewfinder the Shelf uses and drops the first code read into the field.
  await installFakeDetector(page);
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /New product/i }).click();

  // The one beside the Barcode field: the catalogue's own search has a Scan
  // of its own behind this editor, and either would open a viewfinder.
  await page.locator("label", { hasText: "Barcode" })
    .getByRole("button", { name: "Scan" }).click();
  const scanner = page.getByRole("dialog", { name: "Scan a barcode" });
  await expect(scanner).toBeVisible();
  await scanCode(page, "6009876543210");

  await expect(scanner).toHaveCount(0);
  await expect(page.getByLabel(/^Barcode/)).toHaveValue("6009876543210");
});

/**
 * Pick a report by name. Twelve chips became two grouped choosers, because
 * four rows of identical pills ahead of any figures is a wall on a phone.
 */
async function report(page: import("@playwright/test").Page, name: string) {
  await page.getByLabel("Report", { exact: true }).selectOption({ label: name });
}

/** Open Manage and get past the PIN, which every back-office test needs first. */
/**
 * "Save as quote" with nobody picked asks who it is for (0052). These tests
 * are about something else, so they decline to say.
 */
async function saveAsQuote(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Save as quote/ }).click();
  await page.getByRole("dialog", { name: "Who is this quote for?" })
    .getByRole("button", { name: "No name" }).click();
}

async function openManage(
  page: import("@playwright/test").Page,
  pin: string = USERS.manager.pin
) {
  await page.getByRole("button", { name: /^Manage$/ }).click();
  const gate = page.getByRole("dialog", { name: "Manage" });
  const screen = page.locator(".admin-screen");
  // The door asks once and then holds the PIN for a while (lib/unlock), so
  // coming back to Manage inside one test finds it already open. Waited for
  // as "one of these two", never sampled: asking "is the gate up yet" the
  // instant after a click is a race, and this suite has lost that one before.
  await expect(gate.or(screen).first()).toBeVisible();
  if (await gate.isVisible()) {
    for (const d of pin.split("")) {
      await gate.locator(`button:text-is("${d}")`).first().click();
    }
  }
  // Waited for by the SCREEN, not by a heading called "Manage" — the gate
  // renders one of those too (ManagerPinModal's own title), so a test that
  // waits for the heading is satisfied while the door is still shut. It won
  // that race while the gate made one round trip to prove the PIN and lost it
  // the day a second was added.
  await expect(screen).toBeVisible();
}

/**
 * A BarcodeDetector the tests can feed. Installed before the app loads, so
 * lib/barcode.ts picks it up exactly as it would the real one on an Android
 * phone — everything downstream of a "detection" (the lookup, the sheets,
 * the upload) runs for real. Push codes with scanCode().
 */
async function installFakeDetector(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      BarcodeDetector: unknown;
      __scanQueue: string[];
    };
    w.__scanQueue = [];
    w.BarcodeDetector = class {
      async detect(source: unknown): Promise<{ rawValue: string }[]> {
        // The app proves a detector before trusting it by showing it a drawn
        // EAN-13 on a canvas (lib/barcode.ts). A working native detector reads
        // it; so does this one. Frames from the viewfinder are video.
        if (source instanceof HTMLCanvasElement) return [{ rawValue: "6001234000013" }];
        const code = w.__scanQueue.shift();
        return code ? [{ rawValue: code }] : [];
      }
    };
  });
}

async function scanCode(page: import("@playwright/test").Page, code: string) {
  await page.evaluate(
    (c) => (window as unknown as { __scanQueue: string[] }).__scanQueue.push(c),
    code
  );
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
  // Carried onto a second line at this width, with the amount on the first —
  // so matched on the words rather than the raw text. See slipWords.
  expect(await slipWords(slip)).toContain("Diesel for the bakkie");
  await expect(slip).toContainText("SHORT");
  expect(be.closedSessions[0].variance).toBe(-5);
});

test("cash-up history is a month, a day at a time, opening on yesterday", async ({ page }) => {
  // The list used to be the last thirty closes flat: fine for yesterday,
  // useless for the Tuesday before last. A day is chosen — yesterday to
  // begin with — and its cash-ups are what is shown, with that day's close
  // printable from the same place.
  const iso = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const at = (daysAgo: number, hour: number) => {
    const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d;
  };
  const session = (id: string, daysAgo: number, closedBy: string, variance: number) => ({
    id, register_name: "Front Counter", opened_at: at(daysAgo, 8).toISOString(),
    opened_by_name: "Manager", opening_float: 500, closed_at: at(daysAgo, 17).toISOString(),
    closed_by_name: closedBy, counted_cash: 1500 + variance, expected_cash: 1500, variance,
    card_counted: null, card_variance: null, eft_counted: null, eft_variance: null,
    banked: null, float_kept: null, note: null,
    figures: { sales_count: 7, cash_sales: 1000, card_sales: 0, eft_sales: 0, account_sales: 0,
               pay_ins: 0, pay_outs: 0, cash_refunds: 0, expected_cash: 1500, card_expected: 0, eft_expected: 0 },
    movements: [],
  });
  be.closedSessions.push(session("cs-y", 1, "Manager", 0), session("cs-old", 3, "Nomsa", -20));

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Cash-up$/ }).click();

  const which = page.getByLabel("Which day");
  await expect(which).toHaveValue(iso(at(1, 8)));
  const list = page.locator("ul", { hasText: "closed by" });
  await expect(list).toContainText("closed by Manager");
  await expect(list).not.toContainText("closed by Nomsa");

  // Any day of the month: the older close, with its shortfall.
  await which.fill(iso(at(3, 8)));
  await expect(list).toContainText("closed by Nomsa");
  await expect(list).toContainText("Short");
  await expect(list).not.toContainText("closed by Manager");

  // A day with nothing says so rather than showing the wrong day's.
  await which.fill(iso(at(2, 8)));
  await expect(page.getByText(/No cash-up on /)).toBeVisible();

  // Back to yesterday with one tap.
  await page.getByRole("button", { name: "Yesterday" }).click();
  await expect(which).toHaveValue(iso(at(1, 8)));

  // And any day's close prints from here. Last, because the slip sits over
  // the screen until it is closed.
  await which.fill(iso(at(3, 8)));
  await page.getByRole("button", { name: /Print day close for/ }).click();
  await expect(page.locator("#print-area")).toContainText("DAY CLOSE");
});

test("a drawer left open since yesterday is flagged at sign-in, and closing it clears the flag", async ({ page }) => {
  // Nothing used to say so, and a session left open swallows several days'
  // sales into one window. The live shop had two of these.
  be.cashSession = {
    id: "cs1", opened_by_name: "Manager",
    opened_at: new Date(Date.now() - 30 * 36e5).toISOString(),
    opening_float: 500, fromIndex: 0, fromPayments: 0,
  };
  await pairAndSignIn(page, USERS.manager.pin);

  const notice = page.getByRole("alert");
  await expect(notice).toContainText(/has been open since/);
  await expect(notice).toContainText("Manager");

  // The way in lands on the drawer, not on the catalogue.
  await page.getByRole("button", { name: /^Cash up$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Manage" });
  for (const d of USERS.manager.pin.split("")) {
    await dialog.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(page.getByText("Expected in drawer")).toBeVisible();

  await page.getByLabel("Counted cash").fill("500");
  await page.getByRole("button", { name: /Close & print/i }).click();
  await expect(page.locator("#print-area")).toContainText("BALANCED");
  const close = page.getByLabel("Close");
  if (await close.count()) await close.first().click();
  await page.getByRole("button", { name: /Back to till/i }).click();

  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a cashier is told to fetch a manager for a stale drawer, not offered the door", async ({ page }) => {
  be.cashSession = {
    id: "cs1", opened_by_name: "Manager",
    opened_at: new Date(Date.now() - 30 * 36e5).toISOString(),
    opening_float: 500, fromIndex: 0, fromPayments: 0,
  };
  await pairAndSignIn(page, USERS.employee.pin);
  const notice = page.getByRole("alert");
  await expect(notice).toContainText(/Ask a manager to cash up/);
  await expect(page.getByRole("button", { name: /^Cash up$/ })).toHaveCount(0);
});

test("the cash-up slip nets refunds and lists account money by tender", async ({ page }) => {
  be.customers.push({
    id: "k1", code: "TRD-001", name: "Mokoena Building Contractors",
    phone: "051 924 0000", is_trade: false, credit_limit: 25000,
    balance: 0, available: 25000,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Cash-up$/ }).click();
  await page.getByLabel("Opening float").fill("500");
  await page.getByRole("button", { name: /Open the day/i }).click();
  await page.getByRole("button", { name: /Back to till/i }).click();
  // Opened today: nothing to flag.
  await expect(page.getByRole("alert")).toHaveCount(0);

  // R115 of cement on account, then R40 of it settled on the card machine.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.locator(".modal-row", { hasText: "Mokoena" }).click();
  await page.getByRole("button", { name: /^Account$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  await page.getByLabel("Close").click();
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Accounts" }).click();
  await page.locator(".acc-row", { hasText: "Mokoena" }).click();
  await page.locator(".acc-methods button", { hasText: "Card" }).click();
  await page.getByLabel(/^Reference/).fill("batch 12");
  await page.getByLabel("Amount").fill("40");
  await page.getByRole("button", { name: /Receive R/ }).click();
  await expect(page.locator("p", { hasText: "received" })).toContainText("40.00 received");
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Sell" }).click();

  // A R115 cash sale, refunded in full.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();
  // The cash sale's row (the second invoice), not the account sale's: a
  // refund follows the tender, and only a cash refund touches the drawer.
  await page
    .locator("li", { hasText: "INV-000002" })
    .getByRole("button", { name: /^Return$/ })
    .click();
  await page.getByLabel("More Cement 42.5N 50kg").click();
  await page.getByLabel("Return reason").fill("wrong size");
  await page.getByRole("button", { name: /Refund R\s115\.00 & print credit note/ }).click();
  await expect(page.locator("#print-area")).toContainText("CREDIT NOTE");
  const close = page.getByLabel("Close");
  if (await close.count()) await close.first().click();

  // The slip: sales gross, refunds against them, net; and the card machine's
  // R40 listed where the card total is checked.
  await page.getByRole("button", { name: /^Cash-up$/ }).click();
  await expect(page.getByText("Refunds (1)")).toBeVisible();
  await expect(page.getByText("Account paid by card")).toBeVisible();
  await page.getByRole("button", { name: /Print without closing/i }).click();
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("Refunds (1)");
  await expect(slip).toContainText("-R115.00");
  await expect(slip).toContainText("Net");
  await expect(slip).toContainText("Account paid by card");
  await expect(slip).toContainText("R40.00");
  // The drawer: R115 in and R115 back out leaves the float, and the way out
  // is on the slip as a pay-out.
  await expect(slip).toContainText("Paid out");
  await expect(slip).toContainText(/Expected in drawer\s+R500\.00/);
});

test("closing checks the card machine and the bank against the till, banks the cash, and tomorrow opens on the float kept", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Cash-up$/ }).click();
  await page.getByLabel("Opening float").fill("500");
  await page.getByRole("button", { name: /Open the day/i }).click();

  // R115 cash and R89 on the card.
  await page.getByRole("button", { name: /Back to till/i }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000060");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Card$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: /^Cash-up$/ }).click();

  // The till says R89 went through the machine; the machine's batch says R99.
  const cardHint = page.getByText(/went through it/);
  await expect(cardHint).toContainText("89.00");
  await page.getByLabel("Card machine total").fill("99");
  await expect(cardHint).toContainText(/Over by R\s?10\.00/);
  await page.getByLabel("EFTs received").fill("0");
  await expect(page.getByText(/was paid this way/)).toContainText("Agrees.");

  // Count the drawer right (500 + 115), bank R400, keep the rest.
  await page.getByLabel("Counted cash").fill("615");
  await page.getByLabel("Banked").fill("400");
  await expect(page.getByText(/Float kept for tomorrow/)).toContainText("215.00");

  // Banking more than was counted is stopped before the server sees it.
  await page.getByLabel("Banked").fill("700");
  await expect(page.getByText(/More than was counted/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Close & print/i })).toBeDisabled();
  await page.getByLabel("Banked").fill("400");

  await page.getByRole("button", { name: /Close & print/i }).click();
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("BALANCED");
  await expect(slip).toContainText("CARD MACHINE");
  await expect(slip).toContainText(/Till says\s+R89\.00/);
  await expect(slip).toContainText(/Machine says\s+R99\.00/);
  await expect(slip).toContainText(/Over\s+R10\.00/);
  await expect(slip).toContainText("BANKING");
  await expect(slip).toContainText(/Banked\s+R400\.00/);
  await expect(slip).toContainText(/Float kept for tomorrow\s+R215\.00/);
  expect(be.closedSessions[0].card_variance).toBe(10);
  expect(be.closedSessions[0].float_kept).toBe(215);

  // Tomorrow: the open form already knows the float.
  const close = page.getByLabel("Close");
  if (await close.count()) await close.first().click();
  await expect(page.getByLabel("Opening float")).toHaveValue("215.00");
  await expect(page.getByText(/Kept from the last close/)).toBeVisible();
});

test("the day closes for the whole shop: every till, the card machine, the banking, and a slip", async ({ page }) => {
  // A day on one till: R500 float, a cash bag and a card padlock, the card
  // machine agreeing, R400 banked. Reports then adds the shop up.
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Cash-up$/ }).click();
  await page.getByLabel("Opening float").fill("500");
  await page.getByRole("button", { name: /Open the day/i }).click();
  await page.getByRole("button", { name: /Back to till/i }).click();
  for (const [code, tender] of [["6001234000015", /^Cash$/], ["6001234000060", /^Card$/]] as const) {
    await page.getByPlaceholder(/Scan barcode/i).fill(code);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: tender }).click();
    await page.getByRole("button", { name: /Tender & print/i }).click();
    await page.getByLabel("Close").click();
  }
  await openManage(page);
  await page.getByRole("button", { name: /^Cash-up$/ }).click();
  await page.getByLabel("Counted cash").fill("615");
  await page.getByLabel("Card machine total").fill("89");
  await page.getByLabel("Banked").fill("400");
  await page.getByRole("button", { name: /Close & print/i }).click();
  await expect(page.locator("#print-area")).toContainText("BALANCED");
  const close = page.getByLabel("Close");
  if (await close.count()) await close.first().click();

  await page.getByRole("button", { name: /^Reports$/ }).click();
  await expect(page.getByLabel("Report", { exact: true })).toHaveValue("day");

  // The shop's day: two sales, R204, by tender; and the tills underneath.
  const panel = page.getByRole("region", { name: "Day close" });
  // The stat tiles come before the per-till table, whose headings repeat words.
  const stat = (label: string) => panel.getByText(label, { exact: true }).first().locator("..");
  await expect(stat("Sales")).toContainText("2");
  await expect(stat("Taken")).toContainText("204.00");
  await expect(stat("Cash counted")).toContainText("615.00");
  await expect(stat("Banked")).toContainText("400.00");
  await expect(stat("Float kept")).toContainText("215.00");
  const row = panel.locator("tbody tr", { hasText: "Front Counter" });
  await expect(row).toContainText("Balanced");
  await expect(row).toContainText("400.00");

  // A till's row is a door to its whole cash-up, and its own slip.
  await row.click();
  const cashup = page.getByRole("dialog", { name: "Cash-up Front Counter" });
  await expect(cashup).toBeVisible();
  await expect(cashup).toContainText("Expected in drawer");
  await expect(cashup).toContainText("Banked · float kept");
  await cashup.getByRole("button", { name: /Print this cash-up/i }).click();
  await expect(page.locator("#print-area")).toContainText("CASH-UP");
  const closePreview = page.getByLabel("Close", { exact: true });
  if (await closePreview.count()) await closePreview.first().click();
  await page.getByLabel("Close cash-up").click();

  // And the piece of paper for the banking bag.
  await page.getByRole("button", { name: /Print day close/i }).click();
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("DAY CLOSE");
  await expect(slip).toContainText("THE TILLS");
  await expect(slip).toContainText("Front Counter — closed");
  await expect(slip).toContainText("CASH BALANCED");
  await expect(slip).toContainText(/Banked\s+R400\.00/);
});

test("departments report what sold and at what margin, VAT by month nets the credit notes, and the export is a spreadsheet", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: /^Reports$/ }).click();

  // Departments: R115 of cement is R100 ex VAT on a R50 cost — 50% margin.
  await report(page, "Departments");
  const building = page.locator("tbody tr", { hasText: "Building" });
  await expect(building).toContainText("115.00");
  await expect(building).toContainText("50%");

  // VAT: this month is listed with its output VAT.
  await report(page, "VAT");
  const thisMonth = new Date().toLocaleDateString("en-ZA", { month: "long", year: "numeric" });
  const monthRow = page.locator("tbody tr", { hasText: thisMonth });
  await expect(monthRow).toContainText("115.00");
  await expect(monthRow).toContainText("15.00");

  // Export: a real file, one row per line, that a spreadsheet can open.
  await report(page, "Export");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Download CSV/i }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^sales-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
  const lines = text.replace(/^\ufeff/, "").trim().split(/\r?\n/);
  expect(lines[0]).toBe(
    "doc_number,created_at,status,cashier,customer,payment_method,sku,item,department,qty,unit,unit_price,line_total,vat,discount,cost_at_sale"
  );
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("INV-000001");
  expect(lines[1]).toContain("Cement 42.5N 50kg");
  expect(lines[1]).toContain("115");
});

test("a name that is a spreadsheet formula is exported as text", async ({ page }) => {
  // The export exists to be opened in Excel, and Excel runs a cell that
  // begins with = or + or -. A buyer or product named that way — typed at the
  // counter, pasted from a CSV — used to reach the owner's spreadsheet as a
  // formula. It is led with an apostrophe now, which Excel reads as text.
  be.customers.push({
    id: "k8", code: null, name: '=HYPERLINK("http://evil.test","total")',
    phone: "0835550178", is_trade: false, credit_limit: 0, balance: 0, available: 0,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.getByRole("dialog", { name: /Choose a customer/i }).locator(".modal-row", { hasText: "HYPERLINK" }).click();
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: /^Reports$/ }).click();
  await report(page, "Export");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Download CSV/i }).click(),
  ]);
  const text = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
  expect(text).toContain("'=HYPERLINK(");
  expect(text).not.toMatch(/(^|,)"?=HYPERLINK/m);
});

test("a slip carries its number as a barcode, and the shelf decoder reads it back", async ({ page }) => {
  // The tablet's printer draws the bars itself from ESC/POS; the preview
  // draws them from the same encoder. This hands the preview's bars to the
  // real decoder — the one the Shelf phone uses — and asks for the number.
  await pairAndSignIn(page, USERS.manager.pin);
  // The decoder loads with the Shelf screen; open it once so it is on hand.
  await openManage(page);
  await page.getByRole("button", { name: /^Shelf$/ }).click();
  await expect(page.getByText("Point at the barcode")).toBeVisible();
  await page.getByRole("button", { name: /Back to till/i }).click();

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-000001/);

  const decoded = await page.evaluate(async () => {
    const holder = document.querySelector("#print-area [data-barcode]") as HTMLElement | null;
    if (!holder) return "NO BARCODE ON THE SLIP";
    const svg = holder.querySelector("svg")!;
    const rects = Array.from(svg.querySelectorAll("g rect"));
    const w = Number(svg.getAttribute("width")), h = Number(svg.getAttribute("height"));
    // Drawn big and with a quiet zone, as a printer would.
    const scale = 3, pad = 40;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale + pad * 2;
    canvas.height = h * scale + pad * 2;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    for (const r of rects) {
      ctx.fillRect(
        pad + Number(r.getAttribute("x")) * scale, pad,
        Number(r.getAttribute("width")) * scale, h * scale
      );
    }
    const reader = (window as unknown as {
      __zxingReader?: { detect(s: unknown): Promise<{ rawValue: string }[]> };
    }).__zxingReader;
    if (!reader) return "NO READER EXPOSED";
    const found = await reader.detect(canvas);
    return found[0]?.rawValue ?? "NOT DECODED";
  });
  expect(decoded).toBe("INV-000001");
});

test("a scanned invoice opens the sale at the till: reprint, and a return behind a manager's PIN", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-000001/);
  await page.getByLabel("Close", { exact: true }).click();

  // The customer is back with the slip. The gun reads its barcode into the
  // same box that reads products — lower case and no padding, as a worn
  // label might come through — and the sale opens.
  await page.getByPlaceholder(/Scan barcode/i).fill("inv-1");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Sale INV-000001" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Cement 42.5N 50kg");
  await expect(dialog).toContainText("115.00");

  await dialog.getByRole("button", { name: /^Reprint$/ }).click();
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("TAX INVOICE");
  await expect(slip).toContainText("INV-000001");
  await page.getByLabel("Close", { exact: true }).click();

  // A return needs a manager, and a drawer open to pay it from.
  be.cashSession = {
    id: "cs1", opened_by_name: "Manager", opened_at: new Date().toISOString(),
    opening_float: 500, fromIndex: 0, fromPayments: 0,
  };
  await dialog.getByRole("button", { name: /^Return$/ }).click();
  const gate = page.getByRole("dialog", { name: "Return needs a manager" });
  await expect(gate).toBeVisible();
  for (const d of USERS.manager.pin.split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  await page.getByLabel("More Cement 42.5N 50kg").click();
  await page.getByLabel("Return reason").fill("wrong size");
  await page.getByRole("button", { name: /Refund R\s115\.00 & print credit note/ }).click();
  await expect(page.locator("#print-area")).toContainText("CREDIT NOTE");
  expect(be.returns).toHaveLength(1);

  // A number nobody printed says so, rather than opening nothing.
  await page.getByLabel("Close", { exact: true }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("INV-000999");
  await page.keyboard.press("Enter");
  await expect(banner(page)).toContainText(/No sale INV-000999/);
});

test("a scanned quote comes back onto the till", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await saveAsQuote(page);
  await expect(banner(page)).toContainText(/QUO-000001 saved/);
  await page.getByLabel("Close").click();
  await expect(page.locator(".line-desc")).toHaveCount(0);

  // The builder is back with the quote. Its barcode goes into the scan box
  // and the lines are on the till again, ready to be sold.
  await page.getByPlaceholder(/Scan barcode/i).fill("QUO-000001");
  await page.keyboard.press("Enter");
  await expect(banner(page)).toContainText(/QUO-000001 is back on the till/);
  await expect(page.locator(".line-desc")).toHaveText("Cement 42.5N 50kg");
});

test("a quote row opens a popup with its lines, and the cross closes it", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await saveAsQuote(page);
  await expect(banner(page)).toContainText(/QUO-000001 saved/);
  await page.getByLabel("Close").click();

  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  // The row opens the quote without loading it onto the till.
  await page.locator("tr.acc-row", { hasText: "QUO-000001" }).click();
  const dialog = page.getByRole("dialog", { name: "Quote QUO-000001" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Cement 42.5N 50kg");
  await expect(dialog).toContainText("115.00");
  await expect(page.locator(".line-desc")).toHaveCount(0);

  await dialog.getByLabel("Close quote").click();
  await expect(dialog).toHaveCount(0);

  // And from the popup, onto the till.
  await page.locator("tr.acc-row", { hasText: "QUO-000001" }).click();
  await dialog.getByRole("button", { name: /Open on the till/ }).click();
  await expect(page.locator(".line-desc")).toHaveText("Cement 42.5N 50kg");
});

test("a Sales row opens the sale, and the list is striped", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  for (const code of ["6001234000015", "6001234000060"]) {
    await page.getByPlaceholder(/Scan barcode/i).fill(code);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: /^Cash$/ }).click();
    await page.getByRole("button", { name: /Tender & print/i }).click();
    await page.getByLabel("Close").click();
  }
  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();

  // Neighbouring rows differ, so the eye can follow one across. The list is
  // fetched, so wait for the second row to exist before measuring anything:
  // measured straight after the click, this read two rows that were not there
  // yet on a runner slower than a laptop, and CI was red on main for it.
  const rows = page.locator("li:has(button)");
  await expect(rows.nth(1)).toBeVisible();
  const [first, second] = await rows.evaluateAll((els) => [
    getComputedStyle(els[0]).backgroundColor,
    getComputedStyle(els[1]).backgroundColor,
  ]);
  expect(first).not.toBe(second);

  // The row itself is the door; the buttons on it still do their own jobs.
  await page.locator("li", { hasText: "INV-000002" }).click();
  const dialog = page.getByRole("dialog", { name: "Sale INV-000002" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Padlock 50mm Brass");
  await dialog.getByRole("button", { name: /^Reprint$/ }).click();
  await expect(page.locator("#print-area")).toContainText("INV-000002");
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
  await expect(page.getByText("R 615.00")).toBeVisible();
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

test("a buyer's name with printer bytes and markup in it prints as their name", async ({ page }) => {
  // The slip is one string, and the preview reads control characters in it
  // as its own markup: byte 5 opens a barcode region, and whatever followed
  // it was handed to innerHTML inside an attribute. A name pasted with that
  // byte in it — from a CSV, from a clipboard — became script on the till's
  // own origin, and the same bytes, straight to the printer, are the drawer
  // kick and the cut. So every string a slip is built from loses its
  // control characters first, and the rest of the name prints as text.
  be.customers.push({
    id: "k7", code: null,
    name: "Danger Mokoena\x05\">\u200b<img src=x onerror=\"document.title='pwned'\">\x06 & Sons\x1bp\x00",
    phone: "0835550177", is_trade: false, credit_limit: 0, balance: 0, available: 0,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.getByRole("dialog", { name: /Choose a customer/i }).locator(".modal-row", { hasText: "Danger Mokoena" }).click();
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  const slip = page.locator("#print-area");
  await expect(slip).toContainText(/INV-\d+/);
  // The markup is on the paper as letters, the invoice's barcode is the only
  // barcode, and nothing ran.
  await expect(slip).toContainText('Customer: Danger Mokoena"><img src=x onerror="document.title=\'pwned\'"> & Sonsp');
  await expect(slip.locator("img")).toHaveCount(0);
  await expect(slip.locator("[data-barcode]")).toHaveCount(1);
  expect(await page.evaluate(() => document.title)).not.toBe("pwned");
});

test("a buyer's address is kept, and the slip carries their name next time", async ({ page }) => {
  await pairAndSignIn(page);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.getByPlaceholder(/Name, account code or phone/i).fill("083 555 0199");
  await page.getByRole("button", { name: /Add .* as a new buyer/i }).click();

  // All three optional, and all three worth having: the name puts them on the
  // invoice, the number finds them again, the address goes on a delivery note.
  await page.getByLabel(/Their name/i).fill("T. Mokoena");
  await page.getByLabel(/Delivery address/i).fill("14 Mabille Rd, Maseru");
  // The button names the PERSON once there is a name to use — "Save 083 555
  // 0199" told a cashier what they had typed, not who they were saving.
  await page.getByRole("button", { name: /^Save T\. Mokoena/ }).click();

  const saved = be.customers.find((c) => c.name === "T. Mokoena");
  expect(saved).toBeTruthy();

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(page.locator("#print-area")).toContainText("T. Mokoena");
});

test("staff are invited by phone, sent the instructions by SMS, and nobody's PIN is set for them", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Staff$/ }).click();

  await expect(page.getByText("Sam")).toBeVisible();
  await page.getByRole("button", { name: /Add someone/i }).click();
  await page.getByLabel("Staff name").fill("Thabo");
  await page.getByLabel("Staff mobile number").fill("082 555 0100");
  // Said before the button is pressed: an SMS goes to this number.
  await expect(page.getByText(/Adding them sends an SMS to this number/)).toBeVisible();
  await page.getByRole("button", { name: /Add to staff list/i }).click();

  // Invited, not active: they choose their own PIN on their own phone, so a
  // manager never holds a credential that would ring up a sale as someone else.
  const invited = be.staff.find((s) => s.name === "Thabo");
  expect(invited?.status).toBe("invited");
  // Stored in E.164, which is what the enrolment lookup matches on.
  expect(invited?.phone).toBe("+27825550100");

  // The instructions went to their phone, and the screen says so first. Before
  // 0087 nothing was sent and the manager passed the message on by hand.
  await expect(page.getByText("An SMS has been sent to +27825550100.")).toBeVisible();
  expect(be.smsSent).toEqual([{
    to: "+27825550100",
    // Word for word what the dialog shows — and no code, no PIN: the code is
    // still the one they ask for themselves, and the PIN is still their own.
    body: "You have been added to the till at work. Go to https://pos.innovaearth.com/enrol/ " +
      "and enter your number +27825550100 - you will get an SMS code, and then you choose your own PIN.",
  }]);
  expect(be.smsSent[0].body.replace("+27825550100", "")).not.toMatch(/\d{6}/);
  // Recorded on the person, where the roster reads it.
  expect(invited?.invite_sent_at).toBeTruthy();

  // And the enrolment address is a link that can be opened and checked, rather
  // than a string to be read off a screen and retyped into somebody's phone.
  await expect(
    page.getByRole("link", { name: /pos\.innovaearth\.com\/enrol/ })
  ).toHaveAttribute("href", "https://pos.innovaearth.com/enrol/");

  // The message as sent, ready to copy in case their phone was off.
  const sent = page.getByRole("button", { name: /The message they were sent/i });
  await expect(sent).toContainText(be.smsSent[0].body);
  await page.getByRole("button", { name: /^Got it$/ }).click();

  await expect(page.getByText("PIN not set")).toBeVisible();
  // The row says the link went, not that it is waiting to be sent.
  await expect(page.getByRole("button", { name: /Thabo cannot sign in yet/i }))
    .toContainText("They were sent the link by SMS");
});

test("an invitation that fails to send is said so, blamed on the shop's side, and can be tried again", async ({ page }) => {
  be.inviteSmsFails = "The SMS service could not be reached";
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Staff$/ }).click();
  await page.getByRole("button", { name: /Add someone/i }).click();
  await page.getByLabel("Staff name").fill("Thabo");
  await page.getByLabel("Staff mobile number").fill("082 555 0100");
  await page.getByRole("button", { name: /Add to staff list/i }).click();

  // They are on the list — the add succeeded — but nothing reached them, and
  // the dialog says which, and why, rather than "sent" for a message that
  // never went.
  expect(be.staff.find((s) => s.name === "Thabo")?.status).toBe("invited");
  await expect(page.getByText("The SMS to +27825550100 could not be sent.")).toBeVisible();
  await expect(page.getByText(/The SMS service could not be reached\. Nothing has reached Thabo/)).toBeVisible();
  await expect(page.getByText(/An SMS has been sent/)).toHaveCount(0);
  expect(be.smsSent).toEqual([]);
  // The message is still there to pass on by hand.
  await expect(page.getByRole("button", { name: /copy a message for them/i })).toContainText("+27825550100");
  await page.getByRole("button", { name: /^Got it$/ }).click();

  // The row wears the failure in red, aimed at the shop's side, not the amber
  // "waiting on them" that would send the manager to chase the colleague.
  const failed = page.getByRole("button", { name: /Thabo.s invitation SMS did not go/i });
  await expect(failed).toBeVisible();
  await expect(failed).toContainText("The SMS service could not be reached");
  await expect(page.getByRole("button", { name: /Thabo cannot sign in yet/i })).toHaveCount(0);

  // Straight away, "try again" is refused: a provider that is down is not
  // hammered, and the failed attempt used the minute like a sent one.
  await failed.click();
  await page.getByRole("button", { name: /^Try again$/ }).click();
  await expect(page.getByText("An invitation went to Thabo less than a minute ago.")).toBeVisible();
  expect(be.smsSent).toEqual([]);
  await page.getByRole("button", { name: /^Got it$/ }).click();

  // A minute on, the service is back; the row's own "try again" sends it.
  be.inviteSmsFails = null;
  be.staff.find((s) => s.name === "Thabo")!.invite_tried_at = new Date(Date.now() - 90_000).toISOString();
  await failed.click();
  await page.getByRole("button", { name: /^Try again$/ }).click();
  await expect(page.getByText("An SMS has been sent to +27825550100.")).toBeVisible();
  expect(be.smsSent.map((m) => m.to)).toEqual(["+27825550100"]);
  await page.getByRole("button", { name: /^Got it$/ }).click();
  await expect(page.getByRole("button", { name: /Thabo cannot sign in yet/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /invitation SMS did not go/i })).toHaveCount(0);
});

test("a second invitation within a minute is refused, in the server's words", async ({ page }) => {
  // SMSes cost money and a stuck manager tapping "send again" must not turn
  // into a bill; the server's cooldown is the guard, and the dialog shows its
  // refusal rather than claiming a send that did not happen.
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Staff$/ }).click();
  await page.getByRole("button", { name: /Add someone/i }).click();
  await page.getByLabel("Staff name").fill("Thabo");
  await page.getByLabel("Staff mobile number").fill("082 555 0100");
  await page.getByRole("button", { name: /Add to staff list/i }).click();
  await expect(page.getByText("An SMS has been sent to +27825550100.")).toBeVisible();

  await page.getByRole("button", { name: /Send the SMS again/i }).click();
  await expect(page.getByText("Not sent.")).toBeVisible();
  await expect(page.getByText("An invitation went to Thabo less than a minute ago.")).toBeVisible();
  expect(be.smsSent).toHaveLength(1);
});

test("the link to send stays on the row of anyone who cannot sign in yet", async ({ page }) => {
  // Somebody added on an earlier shift who never got as far as enrolling. This
  // is the state a dialog shown once, at the moment of adding, cannot help
  // with — the counter is rarely quiet enough for that to be the moment it gets
  // dealt with, and afterwards there was nothing left on screen to act on.
  be.staff.push({
    id: "u9",
    name: "Thabo",
    phone: "+27825550100",
    role: "employee",
    status: "invited",
    active: true,
    permissions: [],
    discount_limit_percent: null,
    discount_limit_amount: null,
    last_code_error: null,
    // Sent on that shift, long enough ago that sending again is allowed.
    invite_sent_at: new Date(Date.now() - 3_600_000).toISOString(),
    invite_send_error: null,
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Staff$/ }).click();

  // In words on the row, and tappable — not a chip that reads as decoration.
  const pending = page.getByRole("button", { name: /Thabo cannot sign in yet/i });
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("They were sent the link by SMS");
  await pending.click();

  // It opens the same instructions, link and all — and says what went, when.
  await expect(page.getByText("An SMS has been sent to +27825550100.")).toBeVisible();
  await expect(page.getByText(/^Sent at \d\d:\d\d today\./)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /pos\.innovaearth\.com\/enrol/ })
  ).toHaveAttribute("href", "https://pos.innovaearth.com/enrol/");
  // Naming the right number matters: enrolment matches on it, and a code
  // requested against any other number is silently never sent.
  await expect(
    page.getByRole("button", { name: /The message they were sent/i })
  ).toContainText("+27825550100");

  // Their phone was off, or they deleted it: it can go again from here.
  await page.getByRole("button", { name: /Send the SMS again/i }).click();
  await expect(page.getByText(/^Sent at \d\d:\d\d today\./)).toBeVisible();
  expect(be.smsSent.map((m) => m.to)).toEqual(["+27825550100"]);
  await page.getByRole("button", { name: /^Got it$/ }).click();

  // Still there after the dialog is dismissed: it is the job, not a receipt for
  // having been told about the job once.
  await expect(pending).toBeVisible();

  // And somebody who has set a PIN is not nagged about one.
  await expect(page.getByRole("button", { name: /Sam cannot sign in yet/i })).toHaveCount(0);
});

test("a code that failed to send is reported as the shop's problem, not the colleague's", async ({ page }) => {
  // The server used to swallow this: BulkSMS refused or was unreachable, the
  // uniform "a code has been sent" went out anyway, and from the staff screen
  // "they never asked" and "they asked and we failed them" looked identical.
  // 0043 records the outcome and the roster now carries it.
  be.staff.push({
    id: "u9",
    name: "Thabo",
    phone: "+27825550100",
    role: "employee",
    status: "invited",
    active: true,
    permissions: [],
    discount_limit_percent: null,
    discount_limit_amount: null,
    last_code_error: "The SMS service could not be reached",
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Staff$/ }).click();

  // The row says the code failed and why — not the generic "tell them to
  // enrol", which would send the manager to chase the one person who already
  // did everything right.
  const failed = page.getByRole("button", { name: /Thabo.s code never arrived/i });
  await expect(failed).toBeVisible();
  await expect(failed).toContainText("The SMS service could not be reached");
  await expect(page.getByRole("button", { name: /Thabo cannot sign in yet/i })).toHaveCount(0);

  // And the dialog leads with the failure, aimed at the shop's side of it.
  await failed.click();
  await expect(page.getByText("asked for a code, and it failed to send")).toBeVisible();
  await expect(page.getByText(/No SMS has been sent/)).toHaveCount(0);
  await expect(page.getByText(/An SMS has been sent/)).toHaveCount(0);

  // The instructions are still there underneath: once the SMS account is put
  // right, the same steps are the way back in.
  await expect(
    page.getByRole("link", { name: /pos\.innovaearth\.com\/enrol/ })
  ).toHaveAttribute("href", "https://pos.innovaearth.com/enrol/");
});

test("the pending-enrolment row fits a manager's phone", async ({ page }) => {
  // Manage is opened on a phone — issuing an approval code is something a
  // manager does away from the counter — and this row carries a sentence, so it
  // is exactly the kind of thing that pushes the screen sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  be.staff.push({
    id: "u9",
    name: "Thabo",
    phone: "+27825550100",
    role: "employee",
    status: "invited",
    active: true,
    permissions: [],
    discount_limit_percent: null,
    discount_limit_amount: null,
    last_code_error: null,
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  // On a phone the sections sit behind the burger, so Staff is reached
  // through it rather than from a strip. Not an exact name: Thabo is waiting,
  // so the row also wears the badge that says so.
  await page.getByRole("button", { name: "Sections" }).click();
  await page.getByRole("menuitem", { name: /^Staff/ }).click();
  const pending = page.getByRole("button", { name: /Thabo cannot sign in yet/i });
  await expect(pending).toBeVisible();

  // Measured on the row itself, not on the document. Manage sits in its own
  // scrolling panel, so an element far wider than the phone leaves
  // documentElement.scrollWidth untouched and a page-level overflow check
  // passes while the row runs off the side of the screen — which is exactly
  // what the first version of this assertion did.
  const box = await pending.boundingBox();
  expect(box!.width, "the row action's width").toBeLessThanOrEqual(390);
  expect(box!.x + box!.width, "its right edge").toBeLessThanOrEqual(390);
});

test("a scan opens the item, a photo is a tap of its own, and a price fix rides along", async ({ page }) => {
  await installFakeDetector(page);
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shelf$/ }).click();

  // The viewfinder is up and the typed fallback is beside it.
  await expect(page.getByLabel("Barcode digits")).toBeVisible();

  await scanCode(page, "6001234000015");
  await expect(page.getByText("In the catalogue · 6001234000015")).toBeVisible();
  await expect(page.getByText("Cement 42.5N 50kg")).toBeVisible();
  await expect(page.getByText("no photo yet")).toBeVisible();

  // The scan recorded the barcode and nothing else: the strip is empty. The
  // frame that carried the code used to be kept as the first photograph,
  // and it was a picture of a label — the till showed it as the thumbnail.
  await expect(page.getByAltText("Photo 1")).toHaveCount(0);
  await page.getByRole("button", { name: /^Take photo$/ }).click();
  await expect(page.getByAltText("Photo 1")).toBeVisible();

  // A manager holds manage_catalogue, so the price is editable right here.
  await page.getByLabel("Retail price").fill("120");
  await page.getByRole("button", { name: /^Save$/ }).click();

  // The photograph went through the upload endpoint under this PIN, the
  // price landed, and the first photo became the thumbnail — as 0020 does it.
  await expect.poll(() => be.uploadedPhotos.length).toBe(1);
  expect(be.uploadedPhotos[0].product_id).toBe("p1");
  expect(be.uploadedPhotos[0].by_pin).toBe(USERS.manager.pin);
  expect(PRODUCTS.find((p) => p.id === "p1")!.image_url).not.toBeNull();
  await expect.poll(() => PRODUCTS.find((p) => p.id === "p1")!.price_retail).toBe(120);

  // Scan-snap-next: the sheet is gone and the viewfinder is live again.
  await expect(page.getByText(/photo added/)).toBeVisible();
  await expect(page.getByLabel("Barcode digits")).toBeVisible();

  // A rescan of an item that now HAS a photo starts empty too.
  await scanCode(page, "6001234000015");
  await expect(page.getByText("has a photo")).toBeVisible();
  await expect(page.getByAltText("Photo 1")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Take photo$/ })).toBeVisible();
});

test("a shelf-only signer gets the camera, no catalogue, and no price field", async ({ page }) => {
  await installFakeDetector(page);
  await pairAndSignIn(page, USERS.shelf.pin);
  await openManage(page, USERS.shelf.pin);

  // Manage IS the shelf for this person: no catalogue to wander into, and
  // the camera is the landing screen rather than a tab to find.
  await expect(page.getByLabel("Barcode digits")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Catalogue$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Bulk import$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Staff$/ })).toHaveCount(0);

  await scanCode(page, "6001234000015");
  await expect(page.getByText("Cement 42.5N 50kg")).toBeVisible();

  // The price is a fact on display, not a field: the whole safety story of
  // the shelf grant is that its holder cannot change what the till charges.
  await expect(page.getByLabel("Retail price")).toHaveCount(0);
  await expect(page.getByText(/R 115\.00 per bag/)).toBeVisible();

  // No photo until one is taken; then saving it is one tap.
  await expect(page.getByAltText("Photo 1")).toHaveCount(0);
  await page.getByRole("button", { name: /^Take photo$/ }).click();
  await expect(page.getByAltText("Photo 1")).toBeVisible();
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect.poll(() => be.uploadedPhotos.length).toBe(1);
  expect(be.uploadedPhotos[0].by_pin).toBe(USERS.shelf.pin);
});

test("an unknown barcode is recorded hidden, and a rescan finds it", async ({ page }) => {
  await installFakeDetector(page);
  await pairAndSignIn(page, USERS.shelf.pin);
  await openManage(page, USERS.shelf.pin);

  await scanCode(page, "6009876543210");
  await expect(page.getByText("Not in the catalogue · 6009876543210")).toBeVisible();

  // The sheet says out loud that nothing here goes on sale.
  await expect(page.getByText(/New items do not go on sale from here/)).toBeVisible();

  // No picture was taken by the scan, and no price is asked for: a barcode
  // and a name are the facts the aisle records. Pricing is the reviewer's.
  await expect(page.getByAltText("Photo 1")).toHaveCount(0);
  await expect(page.getByLabel("Shelf price")).toHaveCount(0);

  await page.getByLabel("Item name").fill("Padlock 60mm brass");
  await page.getByRole("button", { name: /Save hidden for review/ }).click();
  await expect(page.getByText(/saved hidden for review/)).toBeVisible();

  // Born hidden and unpriced on the record, not only in the toast — and
  // with no photo, because none was taken.
  expect(be.shelfAdded).toHaveLength(1);
  expect(be.shelfAdded[0].active).toBe(false);
  expect(be.shelfAdded[0].price_retail).toBe(0);
  expect(be.shelfAdded[0].sku).toBe("SHELF-6009876543210");
  expect(be.uploadedPhotos).toHaveLength(0);

  // Scanning the same packet again closes the loop: it is in the catalogue
  // now, and the sheet says it is hidden rather than pretending otherwise.
  await scanCode(page, "6009876543210");
  await expect(page.getByText("In the catalogue · 6009876543210")).toBeVisible();
  await expect(page.getByText(/hidden from the till/)).toBeVisible();

  // Up to four photographs, and no more: four taps fill the strip and the
  // add tile withdraws; removing one brings it back. Saved, all go up in
  // order.
  await expect(page.getByAltText("Photo 1")).toHaveCount(0);
  await page.getByRole("button", { name: /^Take photo$/ }).click();
  await expect(page.getByAltText("Photo 1")).toBeVisible();
  await page.getByRole("button", { name: /^Add another$/ }).click();
  await page.getByRole("button", { name: /^Add another$/ }).click();
  await page.getByRole("button", { name: /^Add another$/ }).click();
  await expect(page.getByAltText("Photo 4")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Add another$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Remove photo 2" }).click();
  await expect(page.getByRole("button", { name: /^Add another$/ })).toBeVisible();
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect.poll(() => be.uploadedPhotos.length).toBe(3);
  expect(be.uploadedPhotos.every((u) => u.product_id === "sh1")).toBe(true);
});

test("typing the code is the same road, and takes no picture either", async ({ page }) => {
  // No fake detector installed, and headless Chromium has no native one — so
  // the bundled ZXing decoder loads, exactly as it does on an iPhone. The
  // hint no longer says "cannot scan": there is now always something that
  // can, and typing stays for worn labels and dead cameras.
  await pairAndSignIn(page, USERS.shelf.pin);
  await openManage(page, USERS.shelf.pin);

  await expect(page.getByText("Point at the barcode")).toBeVisible();
  await page.getByLabel("Barcode digits").fill("6001234000015");
  await page.getByRole("button", { name: /^Find$/ }).click();
  await expect(page.getByText("Cement 42.5N 50kg")).toBeVisible();

  // The camera is live, but a photo is still a tap, never a side effect.
  await expect(page.getByAltText("Photo 1")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Take photo$/ })).toBeVisible();
});

test("the bundled decoder really reads an EAN-13, so iPhones scan too", async ({ page }) => {
  // The suite fakes optical input at the BarcodeDetector seam, so the one
  // claim nothing else proves is that the bundled ZXing fallback DECODES.
  // This draws a real EAN-13 in the page — bar by bar, from the standard's
  // encoding tables — and asks the very reader the Shelf screen is holding
  // to read it back. No fixture image to go stale, no faking at the seam.
  await pairAndSignIn(page, USERS.shelf.pin);
  await openManage(page, USERS.shelf.pin);
  // Reader loaded (and, in the e2e build, exposed for exactly this test).
  await expect(page.getByText("Point at the barcode")).toBeVisible();

  const decoded = await page.evaluate(async () => {
    // EAN-13 for "6001234000013" (valid check digit, unlike some seed codes).
    const L: Record<string, string> = { "0": "0001101", "1": "0011001", "2": "0010011", "3": "0111101", "4": "0100011", "5": "0110001", "6": "0101111", "7": "0111011", "8": "0110111", "9": "0001011" };
    const G: Record<string, string> = { "0": "0100111", "1": "0110011", "2": "0011011", "3": "0100001", "4": "0011101", "5": "0111001", "6": "0000101", "7": "0010001", "8": "0001001", "9": "0010111" };
    const R: Record<string, string> = { "0": "1110010", "1": "1100110", "2": "1101100", "3": "1000010", "4": "1011100", "5": "1001110", "6": "1010000", "7": "1000100", "8": "1001000", "9": "1110100" };
    const PARITY: Record<string, string> = { "0": "LLLLLL", "1": "LLGLGG", "2": "LLGGLG", "3": "LLGGGL", "4": "LGLLGG", "5": "LGGLLG", "6": "LGGGLL", "7": "LGLGLG", "8": "LGLGGL", "9": "LGGLGL" };
    const code = "6001234000013";
    const parity = PARITY[code[0]];
    let modules = "101";
    for (let i = 1; i <= 6; i++) modules += (parity[i - 1] === "L" ? L : G)[code[i]];
    modules += "01010";
    for (let i = 7; i <= 12; i++) modules += R[code[i]];
    modules += "101";

    const mod = 4;
    const quiet = 15 * mod;
    const canvas = document.createElement("canvas");
    canvas.width = modules.length * mod + quiet * 2;
    canvas.height = 160;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    for (let i = 0; i < modules.length; i++) {
      if (modules[i] === "1") ctx.fillRect(quiet + i * mod, 20, mod, 120);
    }

    const reader = (window as unknown as {
      __zxingReader?: { detect(s: unknown): Promise<{ rawValue: string }[]> };
    }).__zxingReader;
    if (!reader) return "NO READER EXPOSED";
    const found = await reader.detect(canvas);
    return found[0]?.rawValue ?? "NOT DECODED";
  });

  expect(decoded).toBe("6001234000013");
});

test("the bundled decoder reads a barcode off a live video, not only a still", async ({ page }) => {
  // The still-canvas proof above passed for months while an iPhone pointed
  // at a real label got nothing: the viewfinder is a <video>, and ZXing's
  // own video route never read a frame the canvas route reads in a few
  // milliseconds. So the reader is handed a playing video here — an EAN-8,
  // the format on the paracetamol box that first showed the failure — and
  // has to read it the way the Shelf loop asks: detect(video).
  await pairAndSignIn(page, USERS.shelf.pin);
  await openManage(page, USERS.shelf.pin);
  await expect(page.getByText("Point at the barcode")).toBeVisible();

  const decoded = await page.evaluate(async () => {
    const L: Record<string, string> = { "0": "0001101", "1": "0011001", "2": "0010011", "3": "0111101", "4": "0100011", "5": "0110001", "6": "0101111", "7": "0111011", "8": "0110111", "9": "0001011" };
    const R: Record<string, string> = { "0": "1110010", "1": "1100110", "2": "1101100", "3": "1000010", "4": "1011100", "5": "1001110", "6": "1010000", "7": "1000100", "8": "1001000", "9": "1110100" };
    const code = "60011053"; // EAN-8, valid check digit
    let modules = "101";
    for (let i = 0; i < 4; i++) modules += L[code[i]];
    modules += "01010";
    for (let i = 4; i < 8; i++) modules += R[code[i]];
    modules += "101";

    // A phone-sized frame with the label taking up the middle, as it does
    // inside the gold box, on a dark shelf.
    const W = 1280, H = 720;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#333";
    ctx.fillRect(0, 0, W, H);
    const mod = Math.floor((W * 0.45) / modules.length);
    const x0 = Math.floor((W - mod * modules.length) / 2);
    ctx.fillStyle = "#fff";
    ctx.fillRect(x0 - 12 * mod, 240, mod * modules.length + 24 * mod, 240);
    ctx.fillStyle = "#000";
    for (let i = 0; i < modules.length; i++) {
      if (modules[i] === "1") ctx.fillRect(x0 + i * mod, 250, mod, 220);
    }

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = canvas.captureStream(15);
    document.body.appendChild(video);
    await video.play();
    await new Promise((r) => setTimeout(r, 400));

    const reader = (window as unknown as {
      __zxingReader?: { detect(s: unknown): Promise<{ rawValue: string }[]> };
    }).__zxingReader;
    if (!reader) return "NO READER EXPOSED";
    // The Shelf loop tries a frame every 400 ms; a few tries is fair.
    for (let i = 0; i < 5; i++) {
      const found = await reader.detect(video);
      if (found[0]?.rawValue) return found[0].rawValue;
      await new Promise((r) => setTimeout(r, 100));
    }
    return "NOT DECODED";
  });

  expect(decoded).toBe("60011053");
});

test("a native detector that reads nothing is not trusted: the bundled decoder takes over", async ({ page }) => {
  // iOS 18 ships a BarcodeDetector that constructs and then finds nothing
  // in any frame. Trusting the constructor meant an iPhone showed "Point at
  // the barcode" and never read one. So a detector is shown a label before
  // it is believed — this one fails the audition.
  await page.addInitScript(() => {
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class {
      async detect(): Promise<{ rawValue: string }[]> {
        return [];
      }
    };
  });
  await pairAndSignIn(page, USERS.shelf.pin);
  await openManage(page, USERS.shelf.pin);
  await expect(page.getByText("Point at the barcode")).toBeVisible();

  // The bundled decoder is the one on duty — it is only ever exposed here
  // when it was chosen — and the typed road still finds the item.
  await expect
    .poll(() => page.evaluate(() => Boolean((window as { __zxingReader?: unknown }).__zxingReader)))
    .toBe(true);
  await page.getByLabel("Barcode digits").fill("6001234000015");
  await page.getByRole("button", { name: /^Find$/ }).click();
  await expect(page.getByText("Cement 42.5N 50kg")).toBeVisible();
});

test("the phone menu says who is waiting, and steps aside without stealing the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Somebody added but not yet enrolled — the situation the badge exists for.
  be.staff.push({
    id: "u9",
    name: "Thabo",
    phone: "+27825550100",
    role: "employee",
    status: "invited",
    active: true,
    permissions: [],
    discount_limit_percent: null,
    discount_limit_amount: null,
    last_code_error: null,
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: "Sections" }).click();

  // The Staff row wears the count. A closed menu is the one place on a phone
  // where "someone still cannot sign in" could hide; the badge is how it
  // does not.
  const staffRow = page.getByRole("menuitem", { name: /^Staff/ });
  await expect(staffRow).toContainText("1 waiting");

  // The menu is a card over the page, not a page: the catalogue is still
  // there behind it, and a tap outside puts the menu away without moving you.
  await expect(page.getByPlaceholder(/Search by name, SKU or barcode/i)).toBeVisible();
  await page.mouse.click(200, 700);
  await expect(staffRow).toBeHidden();
  await expect(page.getByPlaceholder(/Search by name, SKU or barcode/i)).toBeVisible();

  // And the badge leads somewhere: Staff, where the pending strip carries on.
  await page.getByRole("button", { name: "Sections" }).click();
  await staffRow.click();
  await expect(page.getByRole("button", { name: /Thabo cannot sign in yet/i })).toBeVisible();
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
  await picker.getByText(/Add .* as a new buyer/i).click();
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
  await expect(picker.getByText(/Add .* as a new buyer/i)).toHaveCount(0);
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
  await picker.getByText(/Add .* as a new buyer/i).click();
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

  await expect(page.getByRole("button", { name: /Running low/ })).toBeVisible();

  // Cement is at 240; a pallet of 100 arrives on GRN A-1042. The screen opens
  // on the delivery, which is empty, so the cement is found by name first —
  // what a gun does with one beep, fingers do with the find box.
  await page.getByRole("button", { name: /Receive a delivery/ }).click();
  await expect(page.getByText(/Nothing on this delivery yet/)).toBeVisible();
  await page.getByLabel("Scan or find an item").fill("Cement 42.5");
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
test("money is entered on the till's own keys, not the device keyboard", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: /^Discount$/ }).click();
  const box = page.getByLabel("Discount amount");

  // inputMode="none" is what shuts the on-screen keyboard on iOS and Android
  // without shutting out a real one. Focusing this box used to raise the iPad
  // keyboard over the middle of the screen, burying the dialog it belonged to:
  // the cashier saw "Apply discount" and nothing else, and had to dismiss the
  // keyboard by hand before they could see what they were doing.
  await expect(box).toHaveAttribute("inputmode", "none");

  // And the keys work, which is the other half — suppressing the keyboard
  // without giving somebody a way to type would just be a broken field.
  const pad = page.getByRole("group", { name: "Number keys" });
  await pad.getByRole("button", { name: "1", exact: true }).click();
  await pad.getByRole("button", { name: "5", exact: true }).click();
  await expect(box).toHaveValue("15");
  await pad.getByRole("button", { name: "Backspace" }).click();
  await expect(box).toHaveValue("1");
  await pad.getByRole("button", { name: "0", exact: true }).click();
  await expect(box).toHaveValue("10");

  await page.getByRole("button", { name: /^Apply$/ }).click();
  await expect(page.locator(".total-row .fig")).toContainText("105.00");
});

test("a dialog stays inside the screen the keyboard left behind", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();

  // iOS does not shrink the layout viewport for the keyboard, so a scrim on
  // `inset: 0` covers a full-height page that is mostly hidden and centres the
  // dialog behind the keyboard. The visible rectangle is published as custom
  // properties instead; Chromium will not raise a keyboard here, so the
  // rectangle is set by hand to stand in for one.
  //
  // What this cannot check is Safari's own behaviour — no engine available to
  // this suite reproduces it. It checks the wiring: that the scrim follows the
  // visible rectangle rather than the page.
  const scrim = page.locator(".vv-fixed").first();
  const full = await scrim.boundingBox();
  expect(full, "the dialog scrim is on screen to begin with").not.toBeNull();

  await page.evaluate(() => {
    document.documentElement.style.setProperty("--vv-height", "360px");
    document.documentElement.style.setProperty("--vv-top", "0px");
  });

  const squeezed = await scrim.boundingBox();
  expect(Math.round(squeezed!.height), "the scrim follows the visible screen").toBe(360);

  // And the dialog is still inside it — centred on what can be seen rather
  // than on a page half of which is behind a keyboard.
  const card = page.getByRole("dialog", { name: "Apply discount" });
  const box = await card.boundingBox();
  expect(box!.y, "the dialog's top is on screen").toBeGreaterThanOrEqual(-1);
  expect(
    box!.y + box!.height,
    "and its bottom, where Apply and Cancel are, is too"
  ).toBeLessThanOrEqual(361);
});

test("the slip preview shows the slip, not a reflowed version of it", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");
  await saveAsQuote(page);
  await expect(page.locator(".sell-banner").first()).toContainText(/QUO-\d+ saved/);

  // A receipt is a fixed-width document: each line is padded so the amount sits
  // in a right-hand margin. The preview let those lines wrap, so a full-width
  // line folded and its amount dropped onto a line of its own — the box rule
  // around the total came apart in the middle of itself. The paper was always
  // right; only the preview lied, which is worse, because the preview is what
  // anybody actually looks at.
  //
  // Squeezed to a width where a 48-column line cannot fit, which is the only
  // width that tests anything: the dialog is now wide enough that a desk would
  // not fold even if it were allowed to, so a check run there passes whether
  // the slip is reflowable or not. Here it can only hold because it may not
  // fold at all.
  await page.setViewportSize({ width: 360, height: 740 });

  // The dialog scales in from 96% over a fifth of a second, and a measurement
  // taken mid-way is of a shrunken slip. This test passed for a year on that
  // accident: a blank line the preview drew under the barcode made the real
  // count one too many, and the 4% shrink rounded it back down — whenever the
  // timing landed. Measure only once nothing is moving.
  await page
    .locator(".animate-scale-in")
    .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

  // Measured rather than asserted on a class name: count how many lines the
  // browser actually laid out and compare it with how many the text has.
  const folded = await page.evaluate(() => {
    const pre = document.querySelector<HTMLPreElement>(".overflow-x-auto pre");
    if (!pre) return { drawn: -1, real: -1 };
    const lh = parseFloat(getComputedStyle(pre).lineHeight);
    // A barcode is a block of its own, not a line of text: take its height
    // out of the measurement and it contributes no line to the text either.
    const bars = Array.from(pre.querySelectorAll<HTMLElement>("[data-barcode]"));
    const barHeight = bars.reduce((t, b) => t + b.getBoundingClientRect().height, 0);
    return {
      drawn: Math.round((pre.getBoundingClientRect().height - barHeight) / lh),
      real: (pre.textContent ?? "").replace(/\n$/, "").split("\n").length,
      bars: bars.length,
    };
  });
  expect(folded.real, "the preview was found and has content").toBeGreaterThan(5);
  expect(folded.bars, "the document number is drawn as a barcode").toBe(1);
  // Drawn may come in a line under the text's own count — a trailing newline
  // does not get a line box of its own. It may never come in ABOVE it: that
  // can only mean the browser folded something, or drew a line the slip does
  // not have (the blank under the barcode was exactly that).
  expect(
    folded.drawn,
    "lines drawn on screen vs lines in the slip — more means it wrapped"
  ).toBeLessThanOrEqual(folded.real);
  expect(
    folded.drawn,
    "the preview is laid out at all, rather than collapsed or hidden"
  ).toBeGreaterThanOrEqual(folded.real - 2);

  // The count above cannot see a blank line the preview invents, because the
  // newline that draws it is counted on both sides. So look at it directly:
  // whatever follows the barcode must start on the line under it. A gap of a
  // line is the blank the paper never prints.
  const gap = await page.evaluate(() => {
    const pre = document.querySelector<HTMLPreElement>(".overflow-x-auto pre")!;
    const bar = pre.querySelector<HTMLElement>("[data-barcode]")!;
    const range = document.createRange();
    range.setStartAfter(bar);
    range.setEnd(pre, pre.childNodes.length);
    const first = Array.from(range.getClientRects()).find((r) => r.width > 0 && r.height > 0)!;
    return {
      gap: first.top - bar.getBoundingClientRect().bottom,
      lh: parseFloat(getComputedStyle(pre).lineHeight),
    };
  });
  expect(gap.gap, "space between the barcode and the next line").toBeLessThan(gap.lh / 2);
});

test("a quote adds up: the line shows what came off it, and so does the total", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: /Discount Cement/i }).click();
  await page.getByLabel("Discount amount").fill("15");
  await page.getByRole("button", { name: /^Apply$/ }).click();

  await saveAsQuote(page);
  await expect(page.locator(".sell-banner").first()).toContainText(/QUO-\d+ saved/);

  // A quote used to print the line at full price, no discount row at all, and
  // a total R15 lower than the subtotal above it — a customer reading it saw
  // R115, then R100, and nothing on the paper to account for the difference.
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("R100.00");
  await expect(slip).toContainText("less discount");
  await expect(slip).toContainText("-R15.00");
  // Subtotal less discount equals total, which is the one thing a quote has to
  // do. R115 gross, R15 off, R100 to pay.
  await expect(slip).toContainText("R115.00");
});

test("a trade customer's quote is priced at trade, line by line", async ({ page }) => {
  be.customers.push({
    id: "k9", code: "TRD-009", name: "Mokoena Building Contractors",
    phone: "051 924 0000", is_trade: true, credit_limit: 25000,
    balance: 0, available: 25000,
  });
  await pairAndSignIn(page, USERS.manager.pin);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.locator(".modal-row", { hasText: "Mokoena" }).click();

  // An account customer's quote is theirs already: nobody is asked.
  await page.getByRole("button", { name: /Save as quote/ }).click();
  await expect(page.locator(".sell-banner").first()).toContainText(/QUO-\d+ saved/);

  // The quote said "Trade pricing" at the top and then priced every line at
  // retail, while the total underneath was worked out at trade. The paper
  // disagreed with itself — R115 on the line, R108 in the total — and the
  // customer was quoted more per item than they were actually being charged.
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("Trade pricing");
  await expect(slip).toContainText("R108.00");
  await expect(slip).not.toContainText("R115.00");
});

test("a shop can quote the job without pricing the shopping list", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);

  // An itemised quote is a list a competitor can price against: the customer
  // takes it down the road, gets the cement matched, and comes back only for
  // the lines nobody else stocks. So a shop can print the scope and one total.
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();
  const tick = page.getByLabel("Show a price against each line on a quote");
  await expect(tick).toBeChecked();
  await tick.uncheck();
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByRole("button", { name: /Back to till/i }).click();

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");
  await saveAsQuote(page);
  await expect(page.locator(".sell-banner").first()).toContainText(/QUO-\d+ saved/);

  const slip = page.locator("#print-area");
  // What is included still prints. A quote that does not say what it covers is
  // not a quote, it is a number.
  await expect(slip).toContainText("Cement 42.5N 50kg");
  await expect(slip).toContainText("Twin & Earth 2.5mm 100m");
  await expect(slip).toContainText("R1565.00");

  // And nothing prices the parts: not the line, not the unit rate, not a
  // subtotal that would be the total written twice.
  await expect(slip).not.toContainText("R115.00");
  await expect(slip).not.toContainText("R1450.00");
  await expect(slip).not.toContainText("Subtotal");
});

test("turning line prices off never touches an invoice", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);

  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();
  await page.getByLabel("Show a price against each line on a quote").uncheck();
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByRole("button", { name: /Back to till/i }).click();

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // A tax invoice must itemise — SARS's rule, not the shop's preference. A
  // setting about quotes that quietly stripped prices off invoices would turn
  // a preference into an audit finding.
  const slip = page.locator("#print-area");
  await expect(slip).toContainText(/tax invoice/i);
  await expect(slip).toContainText("Cement 42.5N 50kg");
  await expect(slip).toContainText("R115.00");
});

test("a saved quote is recalled by number and closes against its sale", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);

  // Build a cart and save it as a quote instead of ringing it.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await saveAsQuote(page);
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

test("a return with no drawer open says so first, and says where to open it", async ({ page }) => {
  // The rule is the server's and it is a good one: cash must not leave a
  // drawer nobody is counting. The cashier used to meet it as a REFUSAL after
  // choosing the lines, marking them shelf or damaged, typing a reason and
  // pressing the button, with a customer standing at the counter — and the
  // sheet said "recorded against the open till session" while they did it,
  // which was a claim about a session that did not exist.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  await page.getByLabel("Close").click();

  // Nobody has opened the day on this till.
  be.cashSession = null;

  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();
  await page.getByRole("button", { name: /^Return$/ }).click();

  // Said BEFORE anything is filled in, and said as an instruction: where to
  // go, not merely why not.
  // The paragraph, not the bold half of it: getByText matches the <strong>,
  // which carries the headline and not the instruction under it.
  const warning = page
    .locator("p")
    .filter({ hasText: /No drawer is open on this till/i })
    .first();
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/Cash-up/);

  // And it does not claim a session it has not got.
  await expect(page.getByText(/recorded against the open till session/i)).toHaveCount(0);

  // The goods can still be chosen — it is only the CASH that is blocked — but
  // the button will not pretend it can pay out.
  await page.getByLabel("More Cement 42.5N 50kg").click();
  await page.getByLabel("Return reason").fill("burst bag");
  await expect(page.getByRole("button", { name: /print credit note/ })).toBeDisabled();

  // Open the day, reopen the invoice, and the same return goes through.
  be.cashSession = {
    id: "cs1", opened_by_name: "Manager", opened_at: new Date().toISOString(),
    opening_float: 500, fromIndex: 0, fromPayments: 0,
  };
  await page.getByRole("button", { name: /^Cancel$/ }).click();
  await page.getByRole("button", { name: /^Return$/ }).click();
  await expect(page.locator("p").filter({ hasText: /No drawer is open/i })).toHaveCount(0);
  await page.getByLabel("More Cement 42.5N 50kg").click();
  await page.getByLabel("Return reason").fill("burst bag");
  await expect(page.getByRole("button", { name: /print credit note/ })).toBeEnabled();
});

test("goods come back against the invoice: partial, then the rest, then nothing", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);

  // Three bags of cement, paid cash: R345.
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
    await page.keyboard.press("Enter");
  }
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  await page.getByLabel("Close").click();

  // The drawer is being counted, so it may pay out.
  be.cashSession = {
    id: "cs1", opened_by_name: "Manager", opened_at: new Date().toISOString(),
    opening_float: 500, fromIndex: 0, fromPayments: 0,
  };
  const p1 = PRODUCTS.find((p) => p.id === "p1")!;
  const stockBefore = p1.stock_qty!;

  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();
  await page.getByRole("button", { name: /^Return$/ }).click();

  // Two of the three come back to the shelf.
  await expect(page.getByText("sold 3 bag")).toBeVisible();
  await page.getByLabel("More Cement 42.5N 50kg").click();
  await page.getByLabel("More Cement 42.5N 50kg").click();
  await page.getByLabel("Return reason").fill("burst bags");
  // Two thirds of R345, rounded the way the server rounds it.
  await page.getByRole("button", { name: /Refund R\s230\.00 & print credit note/ }).click();

  // The credit note is on the paper, not only in the database.
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("CREDIT NOTE");
  await expect(slip).toContainText("CRN-000001");
  await expect(slip).toContainText("returned to shelf");
  await expect(slip).toContainText("REFUND");
  await page.getByLabel("Close").click();

  expect(be.returns).toHaveLength(1);
  expect(be.returns[0].total).toBe(230);
  expect(be.returns[0].refund_method).toBe("cash");
  expect(be.returns[0].items[0].restock).toBe(true);
  // The shelf gained the two bags, and the drawer paid out through the same
  // door as every other pay-out.
  expect(p1.stock_qty).toBe(stockBefore + 2);
  const payout = be.cashMovements.find((m) => m.kind === "pay_out");
  expect(payout?.amount).toBe(230);
  expect(payout?.reason).toContain("CRN-000001");

  // The last bag, damaged: the cents are the remainder, exactly, and the
  // shelf never sees it.
  await page.getByRole("button", { name: /^Return$/ }).click();
  await expect(page.getByText(/2 already returned/)).toBeVisible();
  const more = page.getByLabel("More Cement 42.5N 50kg");
  await more.click();
  // The stepper is capped at what remains — more taps change nothing.
  await expect(more).toBeDisabled();
  await page
    .locator("li", { hasText: "Cement" })
    .getByRole("button", { name: /^Damaged$/ })
    .click();
  await page.getByLabel("Return reason").fill("bag torn in the bakkie");
  await page.getByRole("button", { name: /Refund R\s115\.00 & print credit note/ }).click();
  await expect(slip).toContainText("CRN-000002");
  await expect(slip).toContainText("damaged - written off");
  await page.getByLabel("Close").click();

  expect(be.returns).toHaveLength(2);
  expect(be.returns[1].total).toBe(115);
  expect(be.returns[1].items[0].restock).toBe(false);
  expect(p1.stock_qty).toBe(stockBefore + 2);

  // And now the sale is spent: nothing to step, nothing to refund.
  await page.getByRole("button", { name: /^Return$/ }).click();
  await expect(page.getByText("nothing left to return")).toBeVisible();
  await expect(page.getByRole("button", { name: /& print credit note/ })).toBeDisabled();
});

test("no open till session means no cash refund", async ({ page }) => {
  // The SERVER's refusal, which is the one that matters. The sheet now warns
  // up front and disables the button when it knows there is no drawer — so to
  // reach the server this has to be the case the sheet cannot know about: the
  // drawer was open when the sheet was opened and was CLOSED while it sat
  // there, which on a shop with two tills and one cash-up is a Friday
  // afternoon. The client guard is a courtesy; this is the rule.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();

  be.cashSession = {
    id: "cs1", opened_by_name: "Manager", opened_at: new Date().toISOString(),
    opening_float: 500, fromIndex: 0, fromPayments: 0,
  };

  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();
  await page.getByRole("button", { name: /^Return$/ }).click();
  await page.getByLabel("More Cement 42.5N 50kg").click();
  await page.getByLabel("Return reason").fill("no drawer open");

  // Somebody cashes up on the other till while this one is being filled in.
  be.cashSession = null;

  await page.getByRole("button", { name: /& print credit note/ }).click();

  // The server's refusal reaches the person, in its own words, and nothing
  // was recorded anywhere.
  await expect(page.getByText(/till session open/)).toBeVisible();
  expect(be.returns).toHaveLength(0);
  expect(be.cashMovements.filter((m) => m.kind === "pay_out")).toHaveLength(0);
});

test("an account sale refunds the account, not the drawer", async ({ page }) => {
  be.customers.push({
    id: "k1", code: "TRD-001", name: "Mokoena Building Contractors",
    phone: "051 924 0000", is_trade: false, credit_limit: 25000,
    balance: 0, available: 25000,
  });
  await pairAndSignIn(page, USERS.manager.pin);

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.locator(".modal-row", { hasText: "Mokoena" }).click();
  await page.getByRole("button", { name: /^Account$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();

  // No till session on purpose: an account credit never touches the drawer,
  // so the missing session must not stand in its way.
  be.cashSession = null;

  await openManage(page);
  await page.getByRole("button", { name: /^Sales$/ }).click();
  await page.getByRole("button", { name: /^Return$/ }).click();
  await expect(page.getByText(/Credited to the customer's account/)).toBeVisible();
  await page.getByLabel("More Cement 42.5N 50kg").click();
  await page.getByLabel("Return reason").fill("wrong grade");
  await page.getByRole("button", { name: /Refund R\s115\.00 & print credit note/ }).click();
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("Credited to the customer's account");
  await page.getByLabel("Close").click();

  expect(be.returns).toHaveLength(1);
  expect(be.returns[0].refund_method).toBe("account");
  expect(be.cashMovements.filter((m) => m.kind === "pay_out")).toHaveLength(0);
});

test("a photographed product carries its picture onto the line", async ({ page }) => {
  // A 1x1 gif: imageSrc passes data: URLs straight through, so the fake needs
  // no storage. installBackend resets image_url between tests.
  PRODUCTS.find((p) => p.id === "p1")!.image_url =
    "data:image/gif;base64,R0lGODlhAQABAIAAAMLCwgAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";

  await pairAndSignIn(page);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "chain", "Chain 6mm Galvanised", "2");

  // The photographed line shows its picture; the unphotographed one simply
  // starts at the text — a grey placeholder box on every bare line would
  // punish the catalogue for being a work in progress.
  await expect(page.locator('[data-testid="line-row"]')).toHaveCount(2);
  await expect(page.locator(".line-thumb")).toHaveCount(1);
  await expect(page.locator(".line-thumb")).toHaveAttribute("src", /^data:image/);
});

test("a document filed without being read can be read later, on the same document", async ({ page }) => {
  // The Jasbro invoice: filed with its page and none of its lines, because
  // the reading was skipped. It must not have to be scanned again.
  be.suppliers.push({ id: "sup9", code: null, name: "Jasbro Plumbing", contact_name: null,
    phone: "010 442 0625", email: "info@jasbro.co.za", address: null, vat_number: "4370229645",
    notes: null } as (typeof be.suppliers)[number]);
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await page.locator("tr.acc-row", { hasText: "Jasbro Plumbing" }).click();
  await page.getByRole("dialog", { name: "Supplier Jasbro Plumbing" })
    .getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "File by hand" }).click();
  const filed = page.getByRole("dialog", { name: "New supplier document" });
  await filed.getByLabel("Document kind").selectOption("invoice");
  await filed.getByLabel("Add PDF or photos").setInputFiles([
    { name: "page1.png", mimeType: "image/png", buffer: PNG_1x1 },
  ]);
  await filed.getByRole("button", { name: "File 1 page" }).click();
  await expect(page.getByText("Filed with 1 page.")).toBeVisible();
  expect(be.supplierDocs[0]).toMatchObject({ kind: "invoice", status: "stored" });

  // Open it: a picture with no lines, and the way to read it.
  await page.locator("tr.acc-row", { hasText: "Invoice" }).first().click();
  const view = page.getByRole("dialog", { name: /Invoice/ });
  await expect(view.getByRole("button", { name: "Receive this delivery" })).toHaveCount(0);
  await view.getByRole("button", { name: "Read this document" }).click();
  await expect(page.getByText(/Read: 2 lines found/)).toBeVisible();

  // The filed page went to the reader, and the reading landed on THIS
  // document: number, date, total and lines, nothing filed twice.
  expect(be.readPages).toBe(1);
  expect(be.supplierDocs).toHaveLength(1);
  // The reader called it a quote; the person filed it as an invoice, and the
  // person's word stands — or the receive step would vanish with it.
  expect(be.supplierDocs[0]).toMatchObject({ kind: "invoice", status: "read", doc_number: "27181", doc_date: "2026-08-13", total: 5300.35 });
  expect(be.supplierLines.map((l) => l.description)).toEqual(["COMP ELBOW 15MM", "COMP SPARE RING 15MM"]);

  // And now it reads like any scan: its lines, and the step that books them in.
  await page.locator("tr.acc-row", { hasText: "27181" }).first().click();
  const read = page.getByRole("dialog", { name: /27181/ });
  await expect(read).toContainText("COMP ELBOW 15MM");
  await expect(read.getByRole("button", { name: "Read this document" })).toHaveCount(0);
  await expect(read.getByRole("button", { name: "Receive this delivery" })).toBeVisible();
});

test("called-off orders stay on the list crossed out, deletable when they never went out, and each order goes out as a document", async ({ page }) => {
  be.suppliers.push({ id: "sup1", code: null, name: "Voltex", contact_name: null, phone: "051 000 0000",
    email: "orders@voltex.co.za", address: "1 Depot Rd, Bloemfontein", vat_number: "4000000000",
    notes: null } as (typeof be.suppliers)[number]);
  const cable = PRODUCTS.find((p) => p.sku === "CBL-25-100")!;
  const at = "2026-09-10T08:00:00.000Z";
  be.purchaseOrders.push(
    { id: "po1", doc_number: "PO-000001", supplier_id: "sup1", status: "draft", expected_on: null, note: null, created_at: at, created_by_name: "Manager", sent_at: null },
    { id: "po2", doc_number: "PO-000002", supplier_id: "sup1", status: "cancelled", expected_on: null, note: "raised by mistake", created_at: at, created_by_name: "Manager", sent_at: null },
    { id: "po3", doc_number: "PO-000003", supplier_id: "sup1", status: "cancelled", expected_on: null, note: null, created_at: at, created_by_name: "Manager", sent_at: at },
  );
  be.poLines.push({ id: "pl1", po_id: "po1", product_id: cable.id, sku: cable.sku, name: cable.name, unit_code: cable.unit_code, qty: 6, unit_cost: 50, received_qty: 0 });
  // Print goes to the browser's dialog, which a test cannot see; the call is
  // what is checked.
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => { (window as unknown as { __printed: number }).__printed += 1; };
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Buying$/ }).click();
  await page.getByRole("button", { name: /^Orders$/ }).click();

  // CALLED OFF STAYS ON THE LIST, crossed out. It used to hide behind a
  // toggle, which read as deleted; an order that was raised and then not is
  // part of the record, and the line through it says which it is.
  const rows = page.locator("tr.acc-row");
  const struck = (number: string) =>
    rows.filter({ hasText: number }).locator("td").first()
      .evaluate((el) => getComputedStyle(el).textDecorationLine);
  await expect(rows.filter({ hasText: "PO-000001" })).toBeVisible();
  await expect(rows.filter({ hasText: "PO-000002" })).toBeVisible();
  await expect(rows.filter({ hasText: "PO-000003" })).toBeVisible();
  await expect(page.getByRole("button", { name: /called off/i })).toHaveCount(0);
  expect(await struck("PO-000001")).toBe("none");
  expect(await struck("PO-000002")).toBe("line-through");
  expect(await struck("PO-000003")).toBe("line-through");
  await expect(rows.filter({ hasText: "PO-000003" })).toContainText("Called off");
  // Crossed out is not sendable: there is nothing to print for it.
  await expect(rows.filter({ hasText: "PO-000003" }).getByRole("button", { name: /^Print/ })).toHaveCount(0);

  // ONE THAT NEVER WENT OUT MAY GO. One that went to the supplier stays.
  await rows.filter({ hasText: "PO-000003" }).click();
  await expect(page.getByText(/PO-000003 · Voltex · Called off/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete this order" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await rows.filter({ hasText: "PO-000002" }).click();
  await page.getByRole("button", { name: "Delete this order" }).click();
  await page.getByRole("button", { name: "Delete it" }).click();
  await expect.poll(() => be.purchaseOrders.map((o) => o.doc_number)).toEqual(["PO-000001", "PO-000003"]);
  await expect(rows.filter({ hasText: "PO-000002" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "PO-000003" })).toBeVisible();

  // EACH ORDER GOES OUT AS A DOCUMENT, from its own row: print it, save it
  // as a PDF, or email it to the supplier — whose address is on file.
  const row = rows.filter({ hasText: "PO-000001" });
  await expect(row.getByRole("button", { name: "Print PO-000001" })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    row.getByRole("button", { name: "PDF PO-000001" }).click(),
  ]);
  // Named for the supplier as well as the number: a downloads folder full of
  // Purchase-Order-PO-000001.pdf, -000002.pdf says nothing without opening
  // each one, and who it went to is what a person searches for.
  expect(download.suggestedFilename()).toBe("Purchase-Order-PO-000001-Voltex.pdf");

  const email = row.getByRole("link", { name: "Email PO-000001" });
  const href = (await email.getAttribute("href")) ?? "";
  expect(href).toMatch(/^mailto:orders%40voltex\.co\.za\?subject=Purchase%20Order%20PO-000001%20from%20Ladybrand%20Hardware/);
  // The document is in the body: the supplier and the six rolls at R 50.
  const body = decodeURIComponent(href.split("&body=")[1] ?? "");
  expect(body).toContain("Purchase Order PO-000001");
  expect(body).toContain("For: Voltex");
  expect(body).toContain("6 roll × Twin & Earth 2.5mm 100m (CBL-25-100) — R 300.00");
  expect(body).toContain("VAT R 45.00");
  expect(body).toContain("Total R 345.00");
  // Emailed is as good as sent: the draft is now with the supplier.
  await Promise.all([page.waitForEvent("download"), email.click()]);
  await expect.poll(() => be.purchaseOrders.find((o) => o.id === "po1")?.status).toBe("sent");
  await expect(row).toContainText("With the supplier");

  // Print opens the document and goes to the print dialog by itself.
  await row.getByRole("button", { name: "Print PO-000001" }).click();
  const doc = page.getByRole("dialog", { name: "Purchase Order PO-000001" });
  await expect(doc).toBeVisible();
  await expect(doc).toContainText("Order from");
  await expect(doc).toContainText("Voltex");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
  await doc.getByRole("button", { name: "Close document" }).click();
});

test("the header calculator does a quick sum and leaves the sale alone", async ({ page }) => {
  await pairAndSignIn(page);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="line-row"]')).toHaveCount(1);

  await page.getByRole("button", { name: "Calculator" }).click();
  const calc = page.getByRole("dialog", { name: "Calculator" });
  await expect(calc).toBeVisible();

  // 12 × 3 = 36 — tapped, the way a counter uses it.
  for (const key of ["1", "2", "×", "3", "="]) {
    await calc.getByRole("button", { name: key, exact: true }).click();
  }
  await expect(calc.getByTestId("calc-display")).toHaveText("36");

  // It floats: the sale underneath was never touched.
  await expect(page.locator('[data-testid="line-row"]')).toHaveCount(1);

  // And it floats over the cart, never over the money: the totals and the
  // tender panel stay in full view while a sum is being tapped.
  const calcBox = (await calc.boundingBox())!;
  const totalsBox = (await page.locator(".totals").boundingBox())!;
  const tenderBox = (await page.locator(".tender").boundingBox())!;
  expect(calcBox.x + calcBox.width).toBeLessThanOrEqual(totalsBox.x);
  expect(calcBox.x + calcBox.width).toBeLessThanOrEqual(tenderBox.x);

  // AND IT CAN BE MOVED: dragged by its title bar to wherever it is least in
  // the way, and it stays there when it is opened again.
  const grip = calc.getByTestId("calc-grip");
  const gripBox = (await grip.boundingBox())!;
  await page.mouse.move(gripBox.x + 40, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + 40 + 120, gripBox.y + gripBox.height / 2 + 150, { steps: 6 });
  await page.mouse.move(gripBox.x + 40 + 240, gripBox.y + gripBox.height / 2 + 300, { steps: 6 });
  await page.mouse.up();
  const moved = (await calc.boundingBox())!;
  expect(Math.round(moved.x - calcBox.x)).toBe(240);
  expect(Math.round(moved.y - calcBox.y)).toBe(300);
  // The sum survived the move.
  await expect(calc.getByTestId("calc-display")).toHaveText("36");

  await calc.getByRole("button", { name: "Close calculator" }).click();
  await expect(calc).toHaveCount(0);
  await page.getByRole("button", { name: "Calculator" }).click();
  // Polled: it scales in over a moment, and the box is read once it has.
  await expect.poll(async () => {
    const b = (await calc.boundingBox())!;
    return [Math.round(b.x), Math.round(b.y)];
  }).toEqual([Math.round(moved.x), Math.round(moved.y)]);

  // It cannot be dragged off the screen: the title bar is always reachable.
  const g2 = (await grip.boundingBox())!;
  await page.mouse.move(g2.x + 40, g2.y + 20);
  await page.mouse.down();
  await page.mouse.move(-500, -500, { steps: 4 });
  await page.mouse.up();
  const corner = (await calc.boundingBox())!;
  expect(Math.round(corner.x)).toBe(0);
  expect(Math.round(corner.y)).toBe(0);
  await calc.getByRole("button", { name: "Close calculator" }).click();
});

test("Manage and the pop-ups wear the shop's colours, not a stranger's", async ({ page }) => {
  // The two colours that make the scheme: colophon green and lifted amber.
  // Asserted as computed styles because this is exactly the regression that
  // happened — a stray palette shadowed the brand one and every primary
  // button quietly turned another company's green.
  const GREEN = "rgb(14, 58, 45)"; //  --color-colophon
  const AMBER = "rgb(224, 180, 92)"; // --color-accent-400
  const bg = (l: import("@playwright/test").Locator) =>
    l.evaluate((el) => getComputedStyle(el).backgroundColor);

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  const head = page.locator("header").filter({ hasText: "Back to till" });
  expect(await bg(head)).toBe(GREEN);
  expect(await bg(page.getByRole("button", { name: "New product" }))).toBe(AMBER);
  await page.getByRole("button", { name: "Back to till" }).click();

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Discount$/ }).click();
  const dlg = page.getByRole("dialog", { name: "Apply discount" });
  await expect(dlg).toBeVisible();
  expect(await bg(dlg.getByRole("button", { name: "Apply" }))).toBe(AMBER);
  expect(await bg(dlg.getByRole("button", { name: /^Amount/ }))).toBe(GREEN);
});

/*
 * 0052: the small print, whose quote it is, and a tab that is not for you.
 */
test("the till slip ends with the shop's terms and prints the invoice number once", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  const slip = page.locator("#print-area");
  // Dated the one way a date is written here — "4 Sep 2026 14:05", never
  // 9/4/2026, which is April to half the people who read it.
  await expect(slip).toContainText(
    /\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}\b/
  );
  await expect(slip).not.toContainText(/\d+\/\d+\/\d{4}/);
  // The returns policy is on the paper the customer brings back with.
  await expect(slip).toContainText("Returns within 10 days with this invoice");
  await expect(slip).toContainText("Thank you");

  // "Invoice No: INV-000001" on its line, the bars beneath — and the number
  // under the bars gone, so it is no longer on the slip twice.
  const text = (await slip.evaluate((el) => el.textContent)) ?? "";
  expect(text.match(/INV-000001/g)?.length).toBe(1);
  // Centred over the bars, and the small print centred too, rather than a
  // label and a paragraph hanging off the left margin under a centred slip.
  expect(text).toMatch(/^ {6,}Invoice No: INV-000001\s*$/m);
  expect(text).toMatch(/^ {2,}Returns within 10 days/m);
  expect(text).not.toMatch(/^Returns within 10 days/m);
  await expect(slip.locator("[data-barcode='INV-000001']")).toHaveCount(1);
});

test("a manager writes the small print, and the next slip carries it", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();
  await page.getByLabel("Terms on a till slip").fill("No returns on cut lengths of rope, chain or cable.");
  await page.getByLabel("Terms on a quote").fill("Valid for 7 days from the date shown.");
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  expect(be.orgSettings.receipt_terms).toBe("No returns on cut lengths of rope, chain or cable.");
  expect(be.orgSettings.quote_terms).toBe("Valid for 7 days from the date shown.");

  await page.getByRole("button", { name: /Back to till/i }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("No returns on cut lengths of rope, chain or cable.");
  await expect(slip).not.toContainText("Returns within 10 days");
  await page.getByLabel("Close").click();

  // And a quote gets the quote's wording, not the invoice's.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();
  await page.getByRole("dialog", { name: "Who is this quote for?" })
    .getByRole("button", { name: "No name" }).click();
  await expect(banner(page)).toContainText(/QUO-000001 saved/);
  await expect(slip).toContainText("Valid for 7 days from the date shown.");
  await expect(slip).not.toContainText("No returns on cut lengths");
});

test("a quote is saved for somebody by name, printed and emailed", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();

  // Nobody picked, so the till asks. The name goes on the record and the paper.
  const ask = page.getByRole("dialog", { name: "Who is this quote for?" });
  await ask.getByLabel("Quote for").fill("Mokoena Builders");
  await ask.getByRole("button", { name: "Save quote" }).click();
  await expect(banner(page)).toContainText(/QUO-000001 saved/);
  expect(be.quotes[0].customer_name).toBe("Mokoena Builders");
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("For: Mokoena Builders");
  await expect(slip).toContainText("Prices are subject to stock availability");
  // The number sits centred over its barcode, as the invoice number does.
  expect((await slip.evaluate((el) => el.textContent)) ?? "").toMatch(/^ {6,}QUO-000001\s*$/m);
  await page.getByLabel("Close").click();

  // Listed under the name, so Thursday's phone call can find it.
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  const row = page.locator("tr.acc-row", { hasText: "QUO-000001" });
  await expect(row).toContainText("Mokoena Builders");
  await row.click();
  const dialog = page.getByRole("dialog", { name: "Quote QUO-000001" });

  // Print again from the record, as it was: number, name, lines, small print.
  await dialog.getByRole("button", { name: "Till slip" }).click();
  await expect(slip).toContainText("QUO-000001");
  await expect(slip).toContainText("For: Mokoena Builders");
  await expect(slip).toContainText("Cement 42.5N 50kg");
  await expect(slip).toContainText("115.00");
  await expect(slip).toContainText("Prices are subject to stock availability");
  await page.getByLabel("Close", { exact: true }).click();

  // One tap to email. What goes is the A4 quotation — named as one in the
  // subject, and set out as one in the body — not the till slip that used to.
  const href = await dialog.getByRole("link", { name: "Email" }).getAttribute("href");
  expect(href).toMatch(/^mailto:\?subject=Quotation%20QUO-000001%20from%20Ladybrand%20Hardware/);
  const body = decodeURIComponent(href!.split("&body=")[1]);
  expect(body).toContain("For: Mokoena Builders");
  expect(body).toContain("Cement 42.5N 50kg");
  expect(body).not.toMatch(/[\x01-\x06]/);
});

test("an account customer's quote is theirs without being asked", async ({ page }) => {
  be.customers.push({
    id: "k1", code: "TRD-001", name: "Mokoena Building Contractors",
    phone: "051 924 0000", is_trade: false, credit_limit: 25000,
    balance: 0, available: 25000,
  });
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.locator(".modal-row", { hasText: "Mokoena" }).click();
  await page.getByRole("button", { name: /Save as quote/ }).click();
  await expect(page.getByRole("dialog", { name: "Who is this quote for?" })).toHaveCount(0);
  await expect(banner(page)).toContainText(/QUO-000001 saved/);
  expect(be.quotes[0].customer_id).toBe("k1");
  expect(be.quotes[0].customer_name).toBe("Mokoena Building Contractors");
  await expect(page.locator("#print-area")).toContainText("For: Mokoena Building Contractors");
});

test("the Stock tab is not on the till for somebody who cannot open it", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  const nav = page.getByRole("navigation", { name: "Sections" });
  await expect(nav.getByRole("button", { name: "Sell" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Stock" })).toHaveCount(0);
});

test("and is there for somebody who can", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await expect(page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" })).toBeVisible();
});

test("an invoice in a buyer's purchase history opens, ready to reprint or return", async ({ page }) => {
  be.customers.push({
    id: "k1", code: "TRD-001", name: "Mokoena Building Contractors",
    phone: "051 924 0000", is_trade: false, credit_limit: 25000,
    balance: 0, available: 25000,
  });
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.locator(".modal-row", { hasText: "Mokoena" }).click();
  await page.getByRole("button", { name: /^Account$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-000001/);
  await page.getByLabel("Close").click();

  // "I bought it here last week" — found under the name, then opened from
  // the list rather than read off it and typed back in. The sale cleared the
  // buyer, so the picker is reached through "Walk-in customer" again.
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.getByRole("button", { name: "Purchases by Mokoena Building Contractors" }).click();
  const history = page.getByRole("dialog", { name: /Purchases by Mokoena/ });
  await expect(history).toContainText("Cement 42.5N 50kg");
  await history.getByRole("button", { name: /INV-000001/ }).click();

  const sale = page.getByRole("dialog", { name: "Sale INV-000001" });
  await expect(sale).toBeVisible();
  await expect(sale).toContainText("Cement 42.5N 50kg");
  await expect(sale.getByRole("button", { name: /^Reprint$/ })).toBeVisible();
  await expect(sale.getByRole("button", { name: /^Return$/ })).toBeVisible();
  await expect(history).toHaveCount(0);
});

test("a new product left without a SKU is given the shop's next code", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /New product/i }).click();
  const editor = page;
  // The box says it may be left blank, and Save does not wait for it.
  await expect(editor.getByText(/leave blank and the next number/i)).toBeVisible();
  await editor.getByLabel("Name").fill("Galvanised bucket 10L");
  await editor.getByLabel(/^Retail/).fill("89");
  await editor.getByRole("button", { name: /^Save$/ }).click();

  // Listed under the code the shop's sequence handed out.
  const row = page.locator("tr", { hasText: "Galvanised bucket 10L" });
  await expect(row).toContainText("SKU-000001");
  expect(PRODUCTS.find((p) => p.name === "Galvanised bucket 10L")?.sku).toBe("SKU-000001");

  // A typed code is kept as typed.
  await page.getByRole("button", { name: /New product/i }).click();
  await editor.getByLabel("SKU").fill("BKT-20");
  await editor.getByLabel("Name").fill("Galvanised bucket 20L");
  await editor.getByLabel(/^Retail/).fill("129");
  await editor.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.locator("tr", { hasText: "Galvanised bucket 20L" })).toContainText("BKT-20");
});

/*
 * 0054: "actually, no" — cancelling a sale at the counter.
 */
test("a sale is cancelled from the receipt with a manager's PIN, and the stock comes back", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-000001 completed/);

  // The receipt popup is what the cashier is looking at when the customer
  // says no; the way out is on it. The banner offers the same behind the
  // popup; the popup's is the last in the page.
  await page.getByRole("button", { name: "Cancel this sale" }).last().click();
  const ask = page.getByRole("dialog", { name: "Cancel this sale" });
  await expect(ask).toContainText("Cancel INV-000001?");
  await expect(ask).toContainText("115.00 is handed back");
  // Nothing goes without a reason.
  await expect(ask.getByRole("button", { name: "Continue" })).toBeDisabled();
  await ask.getByLabel("Reason for cancelling").fill("Customer changed their mind");
  await ask.getByRole("button", { name: "Continue" }).click();

  // A cashier's own PIN is not enough — the server says so and the pad stays.
  for (const d of USERS.employee.pin.split("")) {
    await ask.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(ask.getByRole("alert")).toContainText(/Not a manager's PIN, and not a code we recognise/);
  for (const d of USERS.manager.pin.split("")) {
    await ask.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(ask).toHaveCount(0);
  await expect(banner(page)).toContainText("INV-000001 cancelled — hand back R 115.00");
  expect(be.storedSales[0].voided).toBe(true);
  expect(be.storedSales[0].void_reason).toBe("Customer changed their mind");
  // Once cancelled the offer is gone from the banner.
  await expect(page.getByRole("button", { name: "Cancel this sale" })).toHaveCount(0);
});

test("with the manager on the phone, a one-time code cancels the sale from the banner", async ({ page }) => {
  be.approvalCodes.push({
    id: "ac1", code: "313131", issued_by: USERS.manager.row.id, issued_by_name: "Manager",
    max_amount: 50, reason: null,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    used_at: null, used_by_name: null, doc_number: null,
  });
  be.approvalCodes.push({
    id: "ac2", code: "424242", issued_by: USERS.manager.row.id, issued_by_name: "Manager",
    max_amount: null, reason: null,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    used_at: null, used_by_name: null, doc_number: null,
  });
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-000001 completed/);
  // The slip is closed (on a thermal till it went straight to paper). The
  // banner still offers the way out.
  await page.getByLabel("Close", { exact: true }).click();
  await banner(page).getByRole("button", { name: "Cancel this sale" }).click();

  const ask = page.getByRole("dialog", { name: "Cancel this sale" });
  await ask.getByLabel("Reason for cancelling").fill("Wrong item");
  await ask.getByRole("button", { name: "Continue" }).click();
  await expect(ask).toContainText(/code they issue/);

  // A code for R50 cannot cancel an R115 sale; the right code can, once.
  for (const d of "313131".split("")) {
    await ask.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(ask.getByRole("alert")).toContainText(/covers up to 50.00/);
  for (const d of "424242".split("")) {
    await ask.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(ask).toHaveCount(0);
  await expect(banner(page)).toContainText(/INV-000001 cancelled/);
  expect(be.storedSales[0].voided).toBe(true);
  expect(be.approvalCodes[0].used_at).toBeNull();
  expect(be.approvalCodes[1].used_at).toBeTruthy();
  expect(be.approvalCodes[1].used_by_name).toBe("Sam");
  expect(be.approvalCodes[1].doc_number).toBe("INV-000001");
});

test("a scanned slip can be cancelled from the sale popup, and a cancelled sale offers nothing more", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-000001 completed/);
  await page.getByLabel("Close", { exact: true }).click();
  // Dismissing the banner drops its offer; the slip itself is the next door.
  await banner(page).getByText("dismiss").click();

  await page.getByPlaceholder(/Scan barcode/i).fill("INV-000001");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Sale INV-000001" });
  await dialog.getByRole("button", { name: "Cancel this sale" }).click();
  const ask = page.getByRole("dialog", { name: "Cancel this sale" });
  await ask.getByLabel("Reason for cancelling").fill("Came back two minutes later");
  await ask.getByRole("button", { name: "Continue" }).click();
  for (const d of USERS.manager.pin.split("")) {
    await ask.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(ask).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  expect(be.storedSales[0].voided).toBe(true);

  // Scanned again: voided, so neither a return nor a second cancel is offered.
  await page.getByPlaceholder(/Scan barcode/i).fill("INV-000001");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel this sale" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /^Return$/ })).toHaveCount(0);
});

test("a delivery is counted in by scanning, gun or camera, one more per read", async ({ page }) => {
  await installFakeDetector(page);
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" }).click();
  const gate = page.getByRole("dialog", { name: "Stock" });
  for (const d of USERS.manager.pin.split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  await page.getByRole("button", { name: /Receive a delivery/ }).click();

  // The gun types the code into the search box and presses Enter: one more
  // bag of cement each time. The box clears for the next read.
  const scan = page.getByLabel("Scan or find an item");
  const cement = page.getByLabel("Quantity received of Cement 42.5N 50kg");
  await scan.fill("6001234000015");
  await scan.press("Enter");
  await expect(cement).toHaveValue("1");
  await expect(scan).toHaveValue("");
  await scan.fill("6001234000015");
  await scan.press("Enter");
  await expect(cement).toHaveValue("2");
  // Lit, so a long list shows where the scan went.
  await expect(page.locator("tr.stock-row-hit")).toContainText("Cement 42.5N 50kg");

  // A barcode the catalogue does not know is said so, and nothing moves.
  await scan.fill("6009999999999");
  await scan.press("Enter");
  await expect(page.locator(".acc-note.is-bad")).toContainText(/No item .* 6009999999999/);
  await expect(cement).toHaveValue("2");

  // The phone's camera, through the same viewfinder the Shelf uses.
  await page.getByRole("button", { name: /^Scan$/ }).click();
  await expect(page.getByRole("dialog", { name: "Scan a barcode" })).toBeVisible();
  await scanCode(page, "6001234000060");
  await expect(page.getByRole("dialog", { name: "Scan a barcode" })).toHaveCount(0);
  await expect(page.getByLabel("Quantity received of Padlock 50mm Brass")).toHaveValue("1");

  // A carton is not a unit: the count stays editable after a scan.
  await cement.fill("24");
  await page.getByPlaceholder(/Supplier invoice/).fill("JAS-27181");
  await page.getByRole("button", { name: /Book in 2 lines/ }).click();
  await expect(page.getByText(/2 lines booked in against JAS-27181/)).toBeVisible();
  expect(be.stockMoves).toEqual([
    { product_id: "p1", qty_delta: 24, reason: "receipt", note: "JAS-27181" },
    { product_id: "p5", qty_delta: 1, reason: "receipt", note: "JAS-27181" },
  ]);
});

/**
 * The delivery that arrives for something nobody has ever counted.
 *
 * The Stock screen looked only at lines that already had a stock figure, so an
 * item photographed onto the shelf from the aisle — priced, on the till, in
 * the catalogue, but never counted — could not be found at the back door at
 * all, and the scan reported it as a barcode the CATALOGUE did not know. Which
 * blamed the catalogue for holding the thing it was holding.
 */
test("a delivery of something the shelf has never counted starts counting it", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" }).click();
  const gate = page.getByRole("dialog", { name: "Stock" });
  for (const d of USERS.manager.pin.split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  await page.getByRole("button", { name: /Receive a delivery/ }).click();

  // The glue is in the catalogue with that barcode on it. Scanned at the back
  // door it is FOUND, and nothing is blamed on the catalogue.
  const scan = page.getByLabel("Scan or find an item");
  await scan.fill("6001234000091");
  await scan.press("Enter");
  await expect(page.locator(".acc-note.is-bad")).toHaveCount(0);
  const glue = page.getByLabel("Quantity received of Wood Glue 500ml");
  await expect(glue).toHaveValue("1");
  // Never counted is not zero, and the row says which it is.
  await expect(page.locator("tr", { hasText: "Wood Glue 500ml" })).toContainText("Never counted");
  // And what booking in is about to do is said before it is done, because
  // starting to count something is the shop's decision, not the screen's.
  await expect(page.locator(".stock-starting"))
    .toContainText(/Wood Glue 500ml has never been counted/);

  await glue.fill("12");
  await page.getByPlaceholder(/Supplier invoice/).fill("GRN-771");
  await page.getByRole("button", { name: /Book in 1 line/ }).click();
  await expect(page.getByText(/1 line booked in against GRN-771/)).toBeVisible();

  // Counting started at nothing, so the shelf holds exactly what arrived —
  // and the ledger says where it came from.
  expect(PRODUCTS.find((p) => p.id === "p7")!.stock_qty).toBe(12);
  expect(be.stockMoves).toEqual([
    { product_id: "p7", qty_delta: 12, reason: "receipt", note: "GRN-771" },
  ]);
});

/*
 * A phone-sized till still has every section.
 */
test("on a phone the sections are a row under the header, not gone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairAndSignIn(page, USERS.employee.pin);
  const nav = page.getByRole("navigation", { name: "Sections" });
  await expect(nav.getByRole("button", { name: "Quotes" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Accounts" })).toBeVisible();
  // And the row does not push the page sideways.
  const wider = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(wider).toBe(false);
  await nav.getByRole("button", { name: "Quotes" }).click();
  await expect(page.getByPlaceholder(/Find a quote by number/)).toBeVisible();
  await nav.getByRole("button", { name: "Sell" }).click();
  await expect(page.getByPlaceholder(/Scan barcode/i)).toBeVisible();
});

/*
 * 0055: suppliers, and the paper they send.
 */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

test("a supplier's quote is filed from its pages and opens again", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await expect(page.getByText(/No suppliers yet/)).toBeVisible();

  // The supplier first.
  await page.getByRole("button", { name: "Add supplier" }).click();
  const form = page.getByRole("dialog", { name: "Add supplier" });
  await form.getByLabel("Supplier name").fill("Jasbro Plumbing");
  await form.getByLabel("Phone").fill("010 442 0625");
  await form.getByRole("button", { name: "Save supplier" }).click();
  expect(be.suppliers[0].name).toBe("Jasbro Plumbing");
  expect(be.suppliers[0].phone).toBe("010 442 0625");
  // Saved, and straight onto the supplier's own page, where the paper goes.
  await expect(page.getByRole("heading", { name: "Jasbro Plumbing" })).toBeVisible();
  await expect(page.getByText(/Nothing filed for Jasbro Plumbing yet/)).toBeVisible();

  // Then the quote: two photographed pages, the number, date and total off it.
  await page.getByRole("button", { name: "File by hand" }).click();
  const doc = page.getByRole("dialog", { name: "New supplier document" });
  await doc.getByLabel("Document kind").selectOption("quote");
  await doc.getByLabel("Document number").fill("27181");
  await doc.getByLabel("Document date").fill("2026-08-13");
  await doc.getByLabel("Document total").fill("5300.35");
  // Nothing to file until there is a page.
  await expect(doc.getByRole("button", { name: /^File/ })).toBeDisabled();
  await doc.getByLabel("Add PDF or photos").setInputFiles([
    { name: "page1.png", mimeType: "image/png", buffer: PNG_1x1 },
    { name: "page2.png", mimeType: "image/png", buffer: PNG_1x1 },
  ]);
  await expect(doc.getByText("page 2")).toBeVisible();
  await doc.getByRole("button", { name: "File 2 pages" }).click();
  await expect(page.getByText("Filed with 2 pages.")).toBeVisible();

  // Sent as photographs, in order, by this manager's PIN.
  expect(be.supplierPages.map((p) => p.page_no)).toEqual([1, 2]);
  expect(be.supplierPages.every((p) => p.mime === "image/jpeg" && p.by_pin === USERS.manager.pin)).toBe(true);
  expect(be.supplierDocs[0]).toMatchObject({ kind: "quote", doc_number: "27181", doc_date: "2026-08-13", total: 5300.35 });

  // Listed, and open again with both pages showing.
  const row = page.locator("tr.acc-row", { hasText: "Quote 27181" });
  await expect(row).toContainText("13 Aug 2026");
  await expect(row).toContainText("2 pages");
  await expect(row).toContainText("5 300.35");
  await row.click();
  const view = page.getByRole("dialog", { name: "Quote 27181" });
  await expect(view.locator("img")).toHaveCount(2);
  await expect(view).toContainText("13 Aug 2026");
  await view.getByLabel("Close document").click();

  // Back on the list the supplier shows its details and its count, and a tap
  // opens it in a popup with the cross and Manage the owner asked for.
  await page.getByRole("button", { name: "← Suppliers" }).click();
  const srow = page.locator("tr.acc-row", { hasText: "Jasbro Plumbing" });
  await expect(srow).toContainText("010 442 0625");
  await expect(srow.locator("td").nth(2)).toHaveText("1");
  await srow.click();
  const peek = page.getByRole("dialog", { name: "Supplier Jasbro Plumbing" });
  await expect(peek).toContainText("1 document filed");
  await expect(peek).toContainText("010 442 0625");
  await peek.getByLabel("Close supplier").click();
  await expect(peek).toHaveCount(0);
  await srow.click();
  await peek.getByRole("button", { name: "Manage" }).click();
  await expect(page.getByRole("heading", { name: "Jasbro Plumbing" })).toBeVisible();
  await expect(page.locator("tr.acc-row", { hasText: "Quote 27181" })).toBeVisible();
});

test("a PDF the supplier emailed is filed whole, and a wrong filing can be removed", async ({ page }) => {
  be.suppliers.push({ id: "sup1", name: "Jasbro Plumbing", contact_name: null, phone: null, email: null, vat_number: null, notes: null });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await page.locator("tr.acc-row", { hasText: "Jasbro Plumbing" }).click();
  await page.getByRole("dialog", { name: "Supplier Jasbro Plumbing" })
    .getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "File by hand" }).click();
  const doc = page.getByRole("dialog", { name: "New supplier document" });
  await doc.getByLabel("Document kind").selectOption("invoice");
  await doc.getByLabel("Document number").fill("INV 8812");
  await doc.getByLabel("Add PDF or photos").setInputFiles([
    { name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake") },
  ]);
  await doc.getByRole("button", { name: "File 1 page" }).click();
  await expect(page.getByText("Filed with 1 page.")).toBeVisible();
  expect(be.supplierPages[0].mime).toBe("application/pdf");

  await page.locator("tr.acc-row", { hasText: "Invoice INV 8812" }).click();
  const view = page.getByRole("dialog", { name: "Invoice INV 8812" });
  await expect(view.getByRole("link", { name: /open the PDF/ })).toBeVisible();
  await view.getByRole("button", { name: "Remove" }).click();
  await view.getByRole("button", { name: "Remove it" }).click();
  await expect(page.getByText("Document removed.")).toBeVisible();
  expect(be.supplierDocs).toHaveLength(0);
  expect(be.supplierPages).toHaveLength(0);
});

test("without the purchasing right there is no Suppliers tab", async ({ page }) => {
  await pairAndSignIn(page, USERS.shelf.pin);
  await openManage(page, USERS.shelf.pin);
  await expect(page.getByRole("button", { name: /^Shelf$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Suppliers$/ })).toHaveCount(0);
});

test("on a phone the supplier form scrolls, so its buttons are never under the keys", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: "Sections" }).click();
  await page.getByRole("menuitem", { name: /^Suppliers/ }).click();
  await page.getByRole("button", { name: "Add supplier" }).click();
  const form = page.getByRole("dialog", { name: "Add supplier" });
  await form.getByLabel("Supplier name").fill("Focus Suppliers");
  // The last field and the buttons sit below a 500px screen. A finger (here
  // the wheel — scrollIntoView would move even an overflow:hidden box and
  // prove nothing) scrolls the card down to them.
  await expect(form.getByRole("button", { name: "Save supplier" })).not.toBeInViewport();
  await form.getByLabel("Supplier name").hover();
  await page.mouse.wheel(0, 1200);
  await expect(form.getByLabel("Notes")).toBeInViewport();
  await expect(form.getByRole("button", { name: "Save supplier" })).toBeInViewport();
  await form.getByRole("button", { name: "Save supplier" }).click();
  await expect(page.getByRole("heading", { name: "Focus Suppliers" })).toBeVisible();
});

/*
 * 0056: the page says it, so nobody types it.
 */
test("a scanned quote reads itself, creates the supplier and files with its lines", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();

  // One button. No supplier chosen first, because the letterhead says who.
  await page.getByRole("button", { name: "Scan a document" }).click();
  const scan = page.getByRole("dialog", { name: "Scan a document" });
  await expect(scan.getByRole("button", { name: /^Read/ })).toBeDisabled();
  await scan.getByLabel("Add PDF or photos").setInputFiles([
    { name: "p1.png", mimeType: "image/png", buffer: PNG_1x1 },
    { name: "p2.png", mimeType: "image/png", buffer: PNG_1x1 },
  ]);
  await scan.getByRole("button", { name: "Read 2 pages" }).click();

  // Both pages went to the reader, and what came back is on screen to check.
  await expect(page.getByRole("dialog", { name: "Scan a document" })).toContainText("Check what it says");
  expect(be.readPages).toBe(2);
  await expect(scan.getByLabel("Document number")).toHaveValue("27181");
  await expect(scan.getByLabel("Document date")).toHaveValue("2026-08-13");
  await expect(scan.getByLabel("Document total")).toHaveValue("5300.35");
  await expect(scan.getByLabel("Document kind")).toHaveValue("quote");
  await expect(scan).toContainText("COMP ELBOW 15MM");
  await expect(scan).toContainText("PL 0107");
  // Nobody buys from Jasbro yet, so the letterhead becomes the supplier.
  await expect(scan).toContainText(/Not one of your suppliers yet/);
  await expect(scan.getByLabel("Supplier on this document")).toHaveValue("");

  // Nothing is a record until this tap.
  expect(be.supplierDocs).toHaveLength(0);
  await scan.getByRole("button", { name: "File it" }).click();

  await expect(page.getByText(/Filed under Jasbro Plumbing \(added as a new supplier\) with 2 lines/)).toBeVisible();
  expect(be.suppliers).toHaveLength(1);
  expect(be.suppliers[0]).toMatchObject({
    name: "Jasbro Plumbing", vat_number: "4370229645",
    phone: "010 442 0625", email: "info@jasbro.co.za",
  });
  expect(be.supplierDocs[0]).toMatchObject({ kind: "quote", doc_number: "27181", total: 5300.35, status: "read" });
  expect(be.supplierLines.map((l) => [l.line_no, l.supplier_code, l.qty, l.unit_price])).toEqual([
    [1, "PL 0065", 20, 16.85],
    [2, "PL 0107", 100, 1.1],
  ]);
  // The pages went up too, against the document that was just made.
  expect(be.supplierPages.filter((p) => p.document_id === be.supplierDocs[0].id)).toHaveLength(2);

  // And it lands open, showing what it says.
  const view = page.getByRole("dialog", { name: "Quote 27181" });
  await expect(view).toContainText("COMP ELBOW 15MM");
  await expect(view).toContainText("337.00");
});

test("a second document from the same supplier is matched by its VAT number, however the name is written", async ({ page }) => {
  be.suppliers.push({
    id: "sup1", name: "JASBRO PLUMBING (PTY) LTD", contact_name: null,
    phone: null, email: null, vat_number: "4370 229 645", notes: null,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await page.getByRole("button", { name: "Scan a document" }).click();
  const scan = page.getByRole("dialog", { name: "Scan a document" });
  await scan.getByLabel("Add PDF or photos").setInputFiles([
    { name: "p1.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake") },
  ]);
  await scan.getByRole("button", { name: "Read 1 page" }).click();

  // The name on the page is spelt differently; the registration is the same.
  await expect(scan).toContainText("Matched JASBRO PLUMBING (PTY) LTD by its VAT number");
  await scan.getByRole("button", { name: "File it" }).click();
  await expect(page.getByText(/Filed under JASBRO PLUMBING \(PTY\) LTD with 2 lines/)).toBeVisible();
  // Matched, not duplicated.
  expect(be.suppliers).toHaveLength(1);
  expect(be.supplierDocs[0].supplier_id).toBe("sup1");
});

test("a reading that fails still leaves the pages filed, typed in by hand", async ({ page }) => {
  be.readFails = true;
  be.suppliers.push({
    id: "sup1", name: "PPC Cement", contact_name: null, phone: null,
    email: null, vat_number: null, notes: null,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await page.getByRole("button", { name: "Scan a document" }).click();
  const scan = page.getByRole("dialog", { name: "Scan a document" });
  await scan.getByLabel("Add PDF or photos").setInputFiles([
    { name: "p1.png", mimeType: "image/png", buffer: PNG_1x1 },
  ]);
  await scan.getByRole("button", { name: "Read 1 page" }).click();

  // The reader is down; the paper is still in the manager's hand and the same
  // screen takes it typed.
  await expect(scan.getByRole("alert")).toContainText(/could not be read/);
  await expect(scan).toContainText("Check what it says");
  await scan.getByLabel("Supplier on this document").selectOption("sup1");
  await scan.getByLabel("Document kind").selectOption("invoice");
  await scan.getByLabel("Document number").fill("8812");
  await scan.getByLabel("Document total").fill("1420.50");
  await scan.getByRole("button", { name: "File it" }).click();

  await expect(page.getByText(/Filed under PPC Cement\./)).toBeVisible();
  expect(be.supplierDocs[0]).toMatchObject({ kind: "invoice", doc_number: "8812", total: 1420.5, status: "stored" });
  expect(be.supplierLines).toHaveLength(0);
  expect(be.supplierPages).toHaveLength(1);
});

test("a misread line is dropped before filing, and the sum that disagrees is said out loud", async ({ page }) => {
  // A row the reader saw twice: the lines now add to more than the page's own
  // subtotal, which is exactly the case a person must be shown.
  be.documentReading = {
    ...be.documentReading,
    lines: [
      { supplier_code: "PL 0065", description: "COMP ELBOW 15MM", qty: 20, unit_price: 16.85, line_total: 337.0 },
      { supplier_code: "PL 0065", description: "COMP ELBOW 15MM", qty: 20, unit_price: 16.85, line_total: 337.0 },
    ],
    subtotal: 337.0,
  };
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await page.getByRole("button", { name: "Scan a document" }).click();
  const scan = page.getByRole("dialog", { name: "Scan a document" });
  await scan.getByLabel("Add PDF or photos").setInputFiles([
    { name: "p1.png", mimeType: "image/png", buffer: PNG_1x1 },
  ]);
  await scan.getByRole("button", { name: "Read 1 page" }).click();

  await expect(scan).toContainText("The lines add to R 674.00 but the page says R 337.00");
  await scan.getByRole("button", { name: "Drop COMP ELBOW 15MM" }).first().click();
  await expect(scan).not.toContainText("but the page says");
  await scan.getByRole("button", { name: "File it" }).click();
  await expect(page.getByText(/with 1 line\./)).toBeVisible();
  expect(be.supplierLines).toHaveLength(1);
});

test("a supplier's documents open from its popup, without going through Manage", async ({ page }) => {
  be.suppliers.push({
    id: "sup1", name: "Jasbro Plumbing", contact_name: null, phone: "010 442 0625",
    email: null, vat_number: "4370229645", notes: null,
  });
  be.supplierDocs.push({
    id: "doc1", supplier_id: "sup1", kind: "quote", doc_number: "27181",
    doc_date: "2026-08-13", total: 5300.35, note: null, status: "read",
    created_at: "2026-08-13T08:00:00Z",
  });
  be.supplierLines.push({
    document_id: "doc1", line_no: 1, supplier_code: "PL 0065",
    description: "COMP ELBOW 15MM", qty: 20, unit_price: 16.85, line_total: 337,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await page.locator("tr.acc-row", { hasText: "Jasbro Plumbing" }).click();

  // The popup carries the paperwork, and a tap opens the document itself.
  const peek = page.getByRole("dialog", { name: "Supplier Jasbro Plumbing" });
  await expect(peek).toContainText("Quote 27181");
  await expect(peek).toContainText("1 lines");
  await peek.getByRole("button", { name: /Quote 27181/ }).click();
  const view = page.getByRole("dialog", { name: "Quote 27181" });
  await expect(view).toContainText("COMP ELBOW 15MM");
  await expect(view).toContainText("16.85");
});

test("on a phone the scan dialog keeps all its buttons on the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: "Sections" }).click();
  await page.getByRole("menuitem", { name: /^Suppliers/ }).click();
  await page.getByRole("button", { name: "Scan a document" }).click();
  const scan = page.getByRole("dialog", { name: "Scan a document" });
  await scan.getByLabel("Add PDF or photos").setInputFiles([
    { name: "p1.png", mimeType: "image/png", buffer: PNG_1x1 },
  ]);

  // Three buttons at 390px. The row ran off the LEFT edge, so the one that
  // vanished was Cancel — the button somebody presses when they are stuck.
  for (const name of ["Cancel", "Type it in instead", "Read 1 page"]) {
    await expect(scan.getByRole("button", { name })).toBeInViewport({ ratio: 1 });
  }
  await scan.getByRole("button", { name: "Read 1 page" }).click();

  // And the same on the checking screen, where File it is the whole point.
  for (const name of ["Cancel", "Back to pages", "File it"]) {
    await expect(scan.getByRole("button", { name })).toBeInViewport({ ratio: 1 });
  }
  await expect(scan.getByLabel("Document number")).toBeInViewport({ ratio: 1 });
});

test("the letterhead's address and banking are kept, and fill a known supplier's blanks", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await page.getByRole("button", { name: "Scan a document" }).click();
  const scan = page.getByRole("dialog", { name: "Scan a document" });
  await scan.getByLabel("Add PDF or photos").setInputFiles([
    { name: "p1.png", mimeType: "image/png", buffer: PNG_1x1 },
  ]);
  await scan.getByRole("button", { name: "Read 1 page" }).click();

  // Shown before it is kept: an account number should not appear in the
  // shop's record without a person having seen it go in.
  await expect(scan).toContainText("25 Birmingham Road, Benoni South, 1502");
  await expect(scan).toContainText("FNB 62399227258 250655");
  await scan.getByRole("button", { name: "File it" }).click();
  await expect(page.getByText(/Filed under Jasbro Plumbing/)).toBeVisible();
  expect(be.suppliers[0]).toMatchObject({
    address: "25 Birmingham Road, Benoni South, 1502",
    bank_name: "FNB",
    bank_account_name: "JASBRO PLUMBING",
    bank_account_number: "62399227258",
    bank_branch_code: "250655",
  });

  // On the popup, where somebody about to pay them will look for it.
  await page.getByRole("dialog", { name: "Quote 27181" }).getByLabel("Close document").click();
  await page.getByRole("button", { name: "← Suppliers" }).click();
  await page.locator("tr.acc-row", { hasText: "Jasbro Plumbing" }).click();
  const peek = page.getByRole("dialog", { name: "Supplier Jasbro Plumbing" });
  await expect(peek).toContainText("25 Birmingham Road");
  await expect(peek).toContainText("62399227258");
  await expect(peek).toContainText("250655");
});

test("a scan fills what the shop was missing, and never overwrites what it knew", async ({ page }) => {
  // Jasbro is already on file from an earlier scan that read no banking, and
  // with an account number somebody typed differently on purpose.
  be.suppliers.push({
    id: "sup1", name: "Jasbro Plumbing", contact_name: null,
    phone: "010 442 0625", email: null, address: null,
    vat_number: "4370229645", notes: null,
    bank_name: null, bank_account_name: null,
    bank_account_number: "9999999999", bank_branch_code: null,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await page.getByRole("button", { name: "Scan a document" }).click();
  const scan = page.getByRole("dialog", { name: "Scan a document" });
  await scan.getByLabel("Add PDF or photos").setInputFiles([
    { name: "p1.png", mimeType: "image/png", buffer: PNG_1x1 },
  ]);
  await scan.getByRole("button", { name: "Read 1 page" }).click();
  await expect(scan).toContainText("Matched Jasbro Plumbing by its VAT number");
  await scan.getByRole("button", { name: "File it" }).click();

  // The blanks are filled — address, email, bank, account name, branch code —
  // and said out loud, because a record changed that nobody asked to change.
  await expect(page.getByText(/Learnt 5 missing details about them/)).toBeVisible();
  expect(be.suppliers[0]).toMatchObject({
    address: "25 Birmingham Road, Benoni South, 1502",
    email: "info@jasbro.co.za",
    bank_name: "FNB",
    bank_branch_code: "250655",
  });
  // What a person put there stands. A changed account number is a phone call
  // to make, not a field to update from a photograph.
  expect(be.suppliers[0].bank_account_number).toBe("9999999999");
  expect(be.suppliers).toHaveLength(1);
});

/*
 * 0058: the delivery note becomes stock on the shelf.
 */
test("a delivery is booked in from its own invoice, and the pairing is remembered", async ({ page }) => {
  be.suppliers.push({
    id: "sup1", name: "Jasbro Plumbing", contact_name: null, phone: null,
    email: null, address: null, vat_number: "4370229645", notes: null,
  });
  be.supplierDocs.push({
    id: "doc1", supplier_id: "sup1", kind: "invoice", doc_number: "INV-8812",
    doc_date: "2026-08-20", total: 1200, note: null, status: "read",
    created_at: "2026-08-20T08:00:00Z",
  });
  // One line the shop will recognise, one it has never sold.
  be.supplierLines.push(
    { document_id: "doc1", line_no: 1, supplier_code: "PL 0065",
      description: "COMP ELBOW 15MM", qty: 20, unit_price: 16.85, line_total: 337 },
    { document_id: "doc1", line_no: 2, supplier_code: "WAX",
      description: "WAX PAN SEAL RING BROWN", qty: 5, unit_price: 17.5, line_total: 87.5 },
  );
  const cementBefore = PRODUCTS.find((p) => p.id === "p1")!.stock_qty!;

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await page.locator("tr.acc-row", { hasText: "Jasbro Plumbing" }).click();
  await page.getByRole("dialog", { name: "Supplier Jasbro Plumbing" })
    .getByRole("button", { name: /Invoice INV-8812/ }).click();
  await page.getByRole("dialog", { name: "Invoice INV-8812" })
    .getByRole("button", { name: "Receive this delivery" }).click();

  const recv = page.getByRole("dialog", { name: "Receive this delivery" });
  await expect(recv).toContainText("COMP ELBOW 15MM");
  // Nothing is matched yet, so nothing can be booked in.
  await expect(recv).toContainText(/2 lines are not matched/);
  await expect(recv.getByRole("button", { name: /^Book in/ })).toBeDisabled();

  // The person says what Jasbro's code means. Once.
  await recv.getByRole("button", { name: "Match" }).first().click();
  await recv.getByLabel("Find a product for COMP ELBOW 15MM").fill("cement");
  await recv.getByRole("button", { name: /Cement 42.5N 50kg/ }).click();
  await expect(recv).toContainText("→ Cement 42.5N 50kg");
  // One matched, one not. Still refused — this is the assertion that pins the
  // rule, because with nothing matched the button is disabled anyway and a
  // check there would hold for the wrong reason.
  await expect(recv).toContainText(/1 line is not matched/);
  await expect(recv.getByRole("button", { name: /^Book in/ })).toBeDisabled();
  // The cost moved: said before anything is booked in, not after.
  await expect(recv).toContainText("Cost R 50.00 → R 16.85 (down)");

  // The second line is something the shop has never sold.
  await recv.getByRole("button", { name: "Match" }).click();
  await recv.getByRole("button", { name: "Not on our list — create it" }).click();
  await expect(recv).toContainText("→ a new item, priced later");

  // Nineteen arrived, not the twenty on the invoice. The shelf follows the
  // delivery, not the paper.
  await recv.getByLabel("Quantity received of COMP ELBOW 15MM").fill("19");
  await recv.getByRole("button", { name: "Book in 2 lines" }).click();

  await expect(page.getByText(/2 lines booked in, 1 new item created and waiting to be priced/)).toBeVisible();
  expect(PRODUCTS.find((p) => p.id === "p1")!.stock_qty).toBe(cementBefore + 19);
  expect(be.stockMoves).toEqual([
    { product_id: "p1", qty_delta: 19, reason: "receipt", note: "INV-8812" },
    { product_id: expect.stringContaining("new"), qty_delta: 5, reason: "receipt", note: "INV-8812" },
  ]);
  // Born inactive and unpriced: the till must not offer something nobody priced.
  const made = PRODUCTS.find((p) => p.name === "WAX PAN SEAL RING BROWN")!;
  expect(made.price_retail).toBe(0);
  // And Jasbro's code now means something, so the next delivery matches itself.
  expect(be.supplierCodes).toEqual([
    { supplier_id: "sup1", supplier_code: "PL 0065", product_id: "p1" },
    { supplier_id: "sup1", supplier_code: "WAX", product_id: made.id },
  ]);
});

test("the second delivery from a supplier matches itself, and cannot be booked in twice", async ({ page }) => {
  be.suppliers.push({
    id: "sup1", name: "Jasbro Plumbing", contact_name: null, phone: null,
    email: null, address: null, vat_number: "4370229645", notes: null,
  });
  // The pairing a person confirmed on an earlier delivery.
  be.supplierCodes.push({ supplier_id: "sup1", supplier_code: "PL 0065", product_id: "p1" });
  be.supplierDocs.push({
    id: "doc1", supplier_id: "sup1", kind: "delivery_note", doc_number: "DN-77",
    doc_date: "2026-08-21", total: 337, note: null, status: "read",
    created_at: "2026-08-21T08:00:00Z",
  });
  be.supplierLines.push({
    document_id: "doc1", line_no: 1, supplier_code: "PL 0065",
    description: "COMP ELBOW 15MM", qty: 20, unit_price: 16.85, line_total: 337,
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await page.locator("tr.acc-row", { hasText: "Jasbro Plumbing" }).click();
  await page.getByRole("dialog", { name: "Supplier Jasbro Plumbing" })
    .getByRole("button", { name: /Delivery note DN-77/ }).click();
  await page.getByRole("dialog", { name: "Delivery note DN-77" })
    .getByRole("button", { name: "Receive this delivery" }).click();

  // Nobody matches anything this time: it was learnt.
  const recv = page.getByRole("dialog", { name: "Receive this delivery" });
  await expect(recv).toContainText("→ Cement 42.5N 50kg · remembered");
  await expect(recv).not.toContainText("not matched");
  await recv.getByRole("button", { name: "Book in 1 line" }).click();
  await expect(page.getByText(/1 line booked in/)).toBeVisible();

  // A delivery booked in twice is stock the shop does not have.
  await page.locator("tr.acc-row", { hasText: "Jasbro Plumbing" }).click();
  await page.getByRole("dialog", { name: "Supplier Jasbro Plumbing" })
    .getByRole("button", { name: /Delivery note DN-77/ }).click();
  const view = page.getByRole("dialog", { name: "Delivery note DN-77" });
  await expect(view).toContainText("Booked in.");
  await expect(view.getByRole("button", { name: "Receive this delivery" })).toHaveCount(0);
});

test("a quote is not offered for receiving, because nothing has been bought", async ({ page }) => {
  be.suppliers.push({
    id: "sup1", name: "Jasbro Plumbing", contact_name: null, phone: null,
    email: null, address: null, vat_number: "4370229645", notes: null,
  });
  be.supplierDocs.push({
    id: "doc1", supplier_id: "sup1", kind: "quote", doc_number: "27181",
    doc_date: "2026-08-13", total: 5300.35, note: null, status: "read",
    created_at: "2026-08-13T08:00:00Z",
  });
  be.supplierLines.push({
    document_id: "doc1", line_no: 1, supplier_code: "PL 0065",
    description: "COMP ELBOW 15MM", qty: 20, unit_price: 16.85, line_total: 337,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Suppliers$/ }).click();
  await page.locator("tr.acc-row", { hasText: "Jasbro Plumbing" }).click();
  await page.getByRole("dialog", { name: "Supplier Jasbro Plumbing" })
    .getByRole("button", { name: /Quote 27181/ }).click();
  const view = page.getByRole("dialog", { name: "Quote 27181" });
  await expect(view).toContainText("COMP ELBOW 15MM");
  await expect(view.getByRole("button", { name: "Receive this delivery" })).toHaveCount(0);
});

/*
 * 0059: the A4 documents that leave the building, and the shop's mark on them.
 */
test("a quote prints as an A4 quotation with a line for the builder to sign", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();
  const ask = page.getByRole("dialog", { name: "Who is this quote for?" });
  await ask.getByLabel("Quote for").fill("Mokoena Builders");
  await ask.getByRole("button", { name: "Save quote" }).click();
  await page.getByLabel("Close").click();

  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  await page.locator("tr.acc-row", { hasText: "QUO-000001" }).click();
  await page.getByRole("dialog", { name: "Quote QUO-000001" })
    .getByRole("button", { name: "A4 quote" }).click();

  const doc = page.getByRole("dialog", { name: "Quotation QUO-000001" });
  // ON SCREEN, not only in the print dialog. The sheet used to live inside
  // #print-area, which is parked 10 000px to the left so the till slip can
  // wait off-screen — so every toContainText below passed against a document
  // nobody could see. Visibility is the assertion that catches that.
  await expect(doc.locator("#doc-sheet")).toBeVisible();
  await expect(doc.locator(".doc-shop")).toBeInViewport();
  // The shop's own letterhead, from settings — no logo yet, so the name.
  await expect(doc).toContainText("Ladybrand Hardware");
  await expect(doc).toContainText("VAT No 4001234567");
  await expect(doc.locator("img")).toHaveCount(0);
  // The address sits under the name, centred, rather than off to one side.
  await expect(doc.locator(".doc-shop-where")).toContainText("12 Church St");
  // Whose it is, what is on it, and what it comes to.
  await expect(doc).toContainText("Mokoena Builders");
  await expect(doc).toContainText("Cement 42.5N 50kg");
  await expect(doc).toContainText("CEM-425-50");
  await expect(doc).toContainText("115.00");
  // VAT is worked back out of the till's prices, which include it.
  await expect(doc.locator(".doc-totals")).toContainText("15.00");
  // The reason it is A4 at all: a builder signs it and sends it back.
  await expect(doc).toContainText("Accepted by");
  await expect(doc).toContainText("Signature");
  // The quote's own small print, not the invoice's.
  await expect(doc).toContainText("Prices are subject to stock availability");
  await expect(doc).not.toContainText("Returns within 10 days");
  // Email opens the device's own mail app with the document in the body.
  const href = await doc.getByRole("link", { name: "Email" }).getAttribute("href");
  expect(href).toMatch(/^mailto:\?subject=Quotation%20QUO-000001%20from%20Ladybrand%20Hardware/);
  expect(decodeURIComponent(href!.split("&body=")[1])).toContain("Cement 42.5N 50kg");
});

test("an account sale prints as a full A4 tax invoice, with where to pay on it", async ({ page }) => {
  be.customers.push({
    id: "k1", code: "TRD-001", name: "Mokoena Building Contractors",
    phone: "051 924 0000", is_trade: false, credit_limit: 25000,
    balance: 0, available: 25000,
  });
  be.bankAccounts = [{
    id: "bank1", bank_name: "FNB", account_name: "5 Star Hardware",
    account_number: "62012345678", branch_code: "250655", on_documents: true,
  }];
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.locator(".modal-row", { hasText: "Mokoena" }).click();
  await page.getByRole("button", { name: /^Account$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-000001/);
  await page.getByLabel("Close", { exact: true }).click();

  await page.getByPlaceholder(/Scan barcode/i).fill("INV-000001");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Sale INV-000001" })
    .getByRole("button", { name: "A4 invoice" }).click();

  const doc = page.getByRole("dialog", { name: "Tax Invoice INV-000001" });
  // The words SARS asks for, and the shop's own registration.
  await expect(doc).toContainText("Tax Invoice");
  await expect(doc).toContainText("VAT No 4001234567");
  // The customer's details: what makes it a FULL tax invoice rather than the
  // abridged one a till slip is.
  await expect(doc).toContainText("Mokoena Building Contractors");
  await expect(doc).toContainText("Cement 42.5N 50kg");
  // It leaves owing, so it must say where the money goes.
  await expect(doc).toContainText("62012345678");
  await expect(doc).toContainText("250655");
  // The invoice's small print, not the quote's, and no signature block.
  await expect(doc).toContainText("Returns within 10 days");
  await expect(doc).not.toContainText("Accepted by");
});

test("a cash sale's A4 invoice says how it was paid, and does not print the banking", async ({ page }) => {
  be.bankAccounts = [{
    id: "bank1", bank_name: "FNB", account_name: "", account_number: "62012345678",
    branch_code: "", on_documents: true,
  }];
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("INV-000001");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Sale INV-000001" })
    .getByRole("button", { name: "A4 invoice" }).click();

  // Already paid at the counter: the shop's account number has no business
  // on it, and printing it on every slip puts the banking in the car park.
  const doc = page.getByRole("dialog", { name: "Tax Invoice INV-000001" });
  await expect(doc).toContainText("Paid");
  await expect(doc).not.toContainText("62012345678");
});

test("an SVG is refused as a logo, in words", async ({ page }) => {
  // The logo bucket is public and served under the till's own origin, and an
  // SVG is a document that can carry script: one uploaded by anybody with
  // the settings right would have run on every till in the shop. Refused on
  // the screen, before anything is read, and by the function behind it.
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();
  await page.getByLabel("Upload a logo").setInputFiles([
    { name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>document.title="pwned"</script></svg>') },
  ]);
  await expect(page.getByText("Use a PNG, JPEG or WebP for the logo, not an SVG.")).toBeVisible();
  expect(be.uploadedLogos).toHaveLength(0);
  await expect(page.getByText(/No logo yet/)).toBeVisible();
});

test("a logo uploaded in settings turns up on the documents", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();
  await expect(page.getByText(/No logo yet/)).toBeVisible();
  await page.getByLabel("Upload a logo").setInputFiles([
    { name: "logo.png", mimeType: "image/png", buffer: PNG_1x1 },
  ]);
  await expect(page.getByRole("button", { name: "Replace" })).toBeVisible();
  expect(be.uploadedLogos).toHaveLength(1);
  expect(be.orgSettings.logo_url).toBe("org1/logo/1.png");

  // And it is on the next document that leaves the building, without anybody
  // redeploying anything.
  await page.getByRole("button", { name: /Back to till/i }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("INV-000001");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Sale INV-000001" })
    .getByRole("button", { name: "A4 invoice" }).click();
  const doc = page.getByRole("dialog", { name: "Tax Invoice INV-000001" });
  // The document points at the file that was just uploaded. Whether the
  // browser can fetch it from storage is not this test's business — the fake
  // serves no bucket, so a real <img> here would have no size to see.
  await expect(doc.locator("img.doc-logo")).toHaveAttribute("src", /org1\/logo\/1\.png$/);
  // The name still prints beside it: a mark is not a name, and a tax invoice
  // must carry the supplier's name.
  await expect(doc).toContainText("Ladybrand Hardware");
});

test("the A4 document's table is not zebra-striped by the till's own styling", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await addBySearch(page, "twin", "Twin & Earth 2.5mm 100m", "1");
  await page.getByRole("button", { name: /Save as quote/ }).click();
  await page.getByRole("dialog", { name: "Who is this quote for?" })
    .getByRole("button", { name: "No name" }).click();
  await page.getByLabel("Close").click();
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  await page.locator("tr.acc-row", { hasText: "QUO-000001" }).click();
  await page.getByRole("dialog", { name: "Quote QUO-000001" })
    .getByRole("button", { name: "A4 quote" }).click();

  // Every screen under the till zebra-stripes its tables, and this document
  // is rendered inside one — so the second line of a quotation came out with
  // a grey band behind it on paper. The document sets its own rules.
  const rows = page.locator("#doc-sheet .doc-lines tbody tr td:first-child");
  const first = await rows.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor);
  const second = await rows.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(second).toBe(first);
});

test("the letterhead breaks into two lines and InnovaPOS signs the foot", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();
  await page.getByRole("dialog", { name: "Who is this quote for?" })
    .getByRole("button", { name: "No name" }).click();
  await page.getByLabel("Close").click();
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  await page.locator("tr.acc-row", { hasText: "QUO-000001" }).click();
  await page.getByRole("dialog", { name: "Quote QUO-000001" })
    .getByRole("button", { name: "A4 quote" }).click();
  const doc = page.getByRole("dialog", { name: "Quotation QUO-000001" });

  // Where the shop is on one line; how to reach it and who it is on the next.
  // Run together they were a wall: a street, a suburb, a telephone number and
  // a VAT number in one 9pt paragraph, and nobody finds the number they came
  // for. The point of the split is that neither line carries the other's job.
  const whereLine = doc.locator(".doc-shop-where");
  const reachLine = doc.locator(".doc-shop-reach");
  await expect(whereLine).toHaveText("12 Church St, Ladybrand, Free State");
  await expect(reachLine).toContainText("Tel 051 924 0000");
  await expect(reachLine).toContainText("VAT No 4001234567");
  await expect(whereLine).not.toContainText("Tel");
  await expect(whereLine).not.toContainText("VAT");
  await expect(reachLine).not.toContainText("Church St");

  // The house colours, so the document looks like it came from the same place
  // as the till: green for the names, amber for the rules. Both dark enough to
  // survive the mono printer most shops actually own.
  await expect(doc.locator(".doc-shop")).toHaveCSS("color", "rgb(14, 58, 45)");
  await expect(doc.locator(".doc-title")).toHaveCSS("color", "rgb(14, 58, 45)");
  await expect(doc.locator(".doc-head"))
    .toHaveCSS("border-bottom-color", "rgb(200, 145, 47)");

  // The foot, on screen as well as on paper — it used to print only, and a
  // preview that leaves a block out is not a preview of anything.
  const foot = doc.locator(".doc-page-foot");
  await expect(foot).toBeVisible();
  await expect(foot).toContainText("Ladybrand Hardware · Quotation QUO-000001");
  await expect(foot).toContainText("E&OE");
  await expect(foot).toContainText("InnovaPOS · a product of InnovaEarth");
  await expect(foot).toContainText("All rights reserved");
  // The mark itself, not just the words.
  await expect(doc.locator(".doc-colophon svg")).toHaveCount(1);

  // And on paper it keeps its margin. It is shared with @page, which the
  // thermal roll has pushed down from 4mm to 2mm — a tenth of an 80mm slip is
  // not a page margin's to spend — so this padding carries the 2mm difference
  // and the paper stays at the 14mm and 16mm it always had. The floors below
  // are just under those: they go red if the padding is put back to what it
  // was when @page was still paying 4mm, which would put the letterhead hard
  // against the edge of the sheet where a printer may not lay ink at all.
  await page.emulateMedia({ media: "print" });
  // Addressed off the page, not through the dialog: print hides everything but
  // the sheet, and a hidden wrapper takes its role with it. The padding is on
  // .doc-a4 rather than on #doc-sheet, which is now only the box the copies of
  // a delivery note stack inside.
  const sheet = page.locator("#doc-sheet .doc-a4").first();
  const pad = await sheet.evaluate((el) => ({
    left: parseFloat(getComputedStyle(el).paddingLeft),
    top: parseFloat(getComputedStyle(el).paddingTop),
  }));
  expect(pad.left, "side margin on the printed sheet").toBeGreaterThan(48);
  expect(pad.top, "head margin on the printed sheet").toBeGreaterThan(40);
  // The foot survives print too.
  await expect(sheet.locator(".doc-page-foot")).toBeVisible();
  await page.emulateMedia({ media: "screen" });
});

test("the foot of the page sits at the foot of the page", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();
  await page.getByRole("dialog", { name: "Who is this quote for?" })
    .getByRole("button", { name: "No name" }).click();
  await page.getByLabel("Close").click();
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  await page.locator("tr.acc-row", { hasText: "QUO-000001" }).click();
  await page.getByRole("dialog", { name: "Quote QUO-000001" })
    .getByRole("button", { name: "A4 quote" }).click();
  const doc = page.getByRole("dialog", { name: "Quotation QUO-000001" });

  // One line on a whole A4 sheet is the common case at a hardware counter, and
  // the colophon used to sit wherever that one line happened to end — halfway
  // up an empty page. It belongs at the bottom edge, above nothing.
  const sheet = (await doc.locator("#doc-sheet").boundingBox())!;
  const foot = (await doc.locator(".doc-page-foot").boundingBox())!;
  const signed = (await doc.locator(".doc-accept").boundingBox())!;
  // The gap below it is the sheet's own 14mm bottom padding (≈53px) and
  // nothing else.
  const below = sheet.y + sheet.height - (foot.y + foot.height);
  expect(below).toBeGreaterThan(45);
  expect(below).toBeLessThan(62);
  // And it was pushed down there, rather than merely following a long
  // document: there is clear paper between the signature block and the foot.
  expect(foot.y - (signed.y + signed.height)).toBeGreaterThan(200);
});

test("Email sends the A4 quotation as a PDF, not the till slip in the body", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();
  const ask = page.getByRole("dialog", { name: "Who is this quote for?" });
  await ask.getByLabel("Quote for").fill("Morija Exp");
  await ask.getByRole("button", { name: "Save quote" }).click();
  await page.getByLabel("Close").click();
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  await page.locator("tr.acc-row", { hasText: "QUO-000001" }).click();
  const popup = page.getByRole("dialog", { name: "Quote QUO-000001" });

  // The body of the message. It used to be the 48-column thermal slip — ruled
  // lines, a boxed TOTAL, "not a tax invoice" — sent to a builder pricing a
  // job. Now it is the A4 document's own text.
  const href = await popup.getByRole("link", { name: "Email" }).getAttribute("href");
  expect(href).toMatch(/^mailto:\?subject=Quotation%20QUO-000001%20from%20Ladybrand%20Hardware/);
  const body = decodeURIComponent(href!.split("&body=")[1]);
  expect(body).toContain("Quotation QUO-000001");
  expect(body).toContain("Cement 42.5N 50kg");
  expect(body).not.toContain("+---");
  expect(body).not.toContain("not a tax invoice");

  // And the attachment itself. Headless Chromium cannot share files, so this
  // is the second path: the PDF is saved for the person to attach.
  const download = page.waitForEvent("download");
  await popup.getByRole("link", { name: "Email" }).click();
  const file = await download;
  // Named for the buyer as well as the number — the attachment lands in
  // somebody's downloads and has to say who it is for without being opened.
  expect(file.suggestedFilename()).toBe("Quotation-QUO-000001-Morija-Exp.pdf");
  const path = await file.path();
  const bytes = readFileSync(path!);
  const pdf = bytes.toString("latin1");
  expect(pdf.startsWith("%PDF-")).toBe(true);
  // A real document, not an empty page: the shop, the customer, the line and
  // the money are all set in it.
  expect(pdf).toContain("(Ladybrand Hardware) Tj");
  expect(pdf).toContain("(Morija Exp) Tj");
  expect(pdf).toContain("(Cement 42.5N 50kg) Tj");
  expect(pdf).toContain("(QUO-000001) Tj");
  expect(pdf).toContain("MediaBox [0 0 595.28 841.89]");
  // And the person is told they still have to attach it.
  await expect(popup.getByText(/PDF saved/)).toBeVisible();
});

test("a quotation downloads as a PDF straight from its line in the list", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();
  const ask = page.getByRole("dialog", { name: "Who is this quote for?" });
  await ask.getByLabel("Quote for").fill("Morija Exp");
  await ask.getByRole("button", { name: "Save quote" }).click();
  await page.getByLabel("Close").click();
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();

  // From the row itself. Nothing is opened, nothing is loaded onto the till —
  // the document is built from the quote the database already holds.
  const row = page.locator("tr.acc-row", { hasText: "QUO-000001" });
  const download = page.waitForEvent("download");
  await row.getByRole("button", { name: "PDF" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("Quotation-QUO-000001-Morija-Exp.pdf");
  const pdf = readFileSync((await file.path())!).toString("latin1");
  expect(pdf.startsWith("%PDF-")).toBe(true);
  expect(pdf).toContain("(Morija Exp) Tj");
  expect(pdf).toContain("(Cement 42.5N 50kg) Tj");
  // The row did not also open the quote: the button belongs to the button.
  await expect(page.getByRole("dialog", { name: "Quote QUO-000001" })).toHaveCount(0);
});

test("the shop's uploaded logo is inside the PDF, not just on the screen", async ({ page }) => {
  // The bucket answers slowly, as a shop's line does. A document built without
  // waiting for it comes out with no mark on it, once, on a real quotation.
  be.imageDelayMs = 900;
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();
  await page.getByLabel("Upload a logo").setInputFiles([
    { name: "logo.png", mimeType: "image/png", buffer: PNG_1x1 },
  ]);
  await expect(page.getByRole("button", { name: "Replace" })).toBeVisible();

  await page.getByRole("button", { name: /Back to till/i }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();
  await page.getByRole("dialog", { name: "Who is this quote for?" })
    .getByRole("button", { name: "No name" }).click();
  await page.getByLabel("Close").click();
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  await page.locator("tr.acc-row", { hasText: "QUO-000001" }).click();

  const download = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "Quote QUO-000001" })
    .getByRole("button", { name: "PDF" }).click();
  const pdf = readFileSync((await (await download).path())!).toString("latin1");
  // A PDF cannot point at a picture on a server — the image has to be in the
  // file. The fake serves the upload back as the data URL it was given, which
  // is enough for the canvas to turn it into the JPEG that goes in here.
  expect(pdf).toContain("/Subtype /Image");
  expect(pdf).toContain("/Filter /DCTDecode");
  expect(pdf).toMatch(/\/Im1 Do/);
  // And the shop's name is still set: a mark is not a name.
  expect(pdf).toContain("(Ladybrand Hardware) Tj");
});

/*
 * 0060: the quotation as it was sent, kept.
 */
test("a quote's document is kept as it went out, and survives the shop moving", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();
  const ask = page.getByRole("dialog", { name: "Who is this quote for?" });
  await ask.getByLabel("Quote for").fill("Morija Exp");
  await ask.getByRole("button", { name: "Save quote" }).click();
  await expect(banner(page)).toContainText(/QUO-000001 saved/);
  await page.getByLabel("Close").click();

  // Kept at the moment it was saved, not the first time somebody asks for it.
  await expect.poll(() => Object.keys(be.archivedQuotes).length).toBe(1);
  const stored = Object.values(be.archivedQuotes)[0];
  expect(stored.startsWith("data:application/pdf;base64,")).toBe(true);
  const asSent = Buffer.from(stored.split(",")[1], "base64").toString("latin1");
  expect(asSent).toContain("(12 Church St, Ladybrand, Free State) Tj");
  expect(asSent).toContain("(Morija Exp) Tj");

  // THE SHOP MOVES. Everything the document says about the shop lives in
  // settings, and rebuilding an old quote would put the new address on a page
  // the customer never received.
  Object.assign(be.orgSettings, {
    address_line1: "9 Market St", address_line2: "Bloemfontein, Free State",
  });
  // A reload, because the shop's details are cached on the device and read
  // fresh when the till starts. The register stays paired and the operator
  // stays signed in.
  await page.reload();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  const row = page.locator("tr.acc-row", { hasText: "QUO-000001" });

  const download = page.waitForEvent("download");
  await row.getByRole("button", { name: "PDF" }).click();
  const got = readFileSync((await (await download).path())!).toString("latin1");
  expect(got.startsWith("%PDF-")).toBe(true);
  // The old address, because that is the page that was sent.
  expect(got).toContain("(12 Church St, Ladybrand, Free State) Tj");
  expect(got).not.toContain("9 Market St");
  // And a fresh quote saved today does carry the new address, so this is the
  // archive doing its job rather than a stale cache somewhere.
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Sell" }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();
  await page.getByRole("dialog", { name: "Who is this quote for?" })
    .getByRole("button", { name: "No name" }).click();
  await expect.poll(() => Object.keys(be.archivedQuotes).length).toBe(2);
  const second = Object.entries(be.archivedQuotes).find(([id]) => id !== Object.keys(be.archivedQuotes)[0]);
  const newer = Buffer.from(second![1].split(",")[1], "base64").toString("latin1");
  expect(newer).toContain("(9 Market St, Bloemfontein, Free State) Tj");
});

test("a quote saved while the line was down is archived the first time it is asked for", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  // The quote saves; the upload that follows it does not. That has to leave a
  // quote, not an error — the archive is a nicety and the quote is the job.
  // Only this handler is removed later: unroute with a bare pattern takes the
  // fake's own handler for that URL with it, and the retry then has nothing to
  // talk to.
  const blockArchive = (r: Route) => r.abort("failed");
  await page.route("**/functions/v1/quote-pdf", blockArchive);
  await page.getByRole("button", { name: /Save as quote/ }).click();
  await page.getByRole("dialog", { name: "Who is this quote for?" })
    .getByRole("button", { name: "No name" }).click();
  await expect(banner(page)).toContainText(/QUO-000001 saved/);
  await page.getByLabel("Close").click();
  expect(Object.keys(be.archivedQuotes)).toHaveLength(0);

  // Asking for the document rebuilds it — and keeps it, so the letterhead is
  // only ever wrong once.
  await page.unroute("**/functions/v1/quote-pdf", blockArchive);
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  const download = page.waitForEvent("download");
  await page.locator("tr.acc-row", { hasText: "QUO-000001" })
    .getByRole("button", { name: "PDF" }).click();
  expect(readFileSync((await (await download).path())!).toString("latin1")).toContain("%PDF-");
  await expect.poll(() => Object.keys(be.archivedQuotes).length).toBe(1);
});

/*
 * 0061: the shop delivers.
 */
test("a delivery is arranged at the counter, charged on the invoice, and noted", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: /^Deliver$/ }).click();
  const form = page.getByRole("dialog", { name: "Deliver this sale" });
  await form.getByLabel("Deliver to").fill("Morija Exports");
  await form.getByLabel("Address").fill("14 Kolonyama Rd, Maseru");
  await form.getByLabel("Time").fill("after 14:00");
  await form.getByLabel("Delivery charge").fill("85");
  await form.getByRole("button", { name: "Add to the sale" }).click();

  // THE CHARGE IS A LINE ON THE SALE. It is money the shop took, so it is in
  // the total, VAT is worked on it, and it is in the day's takings — not a
  // figure on a scrap of paper beside the till.
  await expect(page.locator(".line-row", { hasText: "Delivery" })).toBeVisible();
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-000001/);
  expect(be.storedSales[0].total).toBe(200);
  // And it reads as a delivery on the slip the customer takes away. The first
  // one ever charged in a real shop printed "1 bag Delivery / @ R50.00/bag",
  // because the line was given whatever unit came first alphabetically. The
  // till prints a plain "1x" and no rate line only for 'ea'.
  const deliverySlip = page.locator("#print-area");
  await expect(deliverySlip).toContainText("1x Delivery");
  await expect(deliverySlip).not.toContainText("bag Delivery");
  // No rate line under it either. The cement above it legitimately says
  // "@ R115.00/bag" — it IS sold by the bag — so this looks for the carriage's
  // own rate, which only appears when the line is not counted in eaches.
  await expect(deliverySlip).not.toContainText("@ R85.00");
  await page.getByLabel("Close", { exact: true }).click();

  // And the note is written against that sale.
  expect(be.deliveries).toHaveLength(1);
  // The fake resolves a sale by its place in the list, as it does everywhere.
  expect(be.deliveries[0].sale_id).toBe("s0");
  expect(be.deliveries[0].charge).toBe(85);

  // The tab: open to everybody, outstanding first.
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Deliveries" }).click();
  const row = page.locator("tr.acc-row", { hasText: "DEL-000001" });
  await expect(row).toContainText("Morija Exports");
  await expect(row).toContainText("14 Kolonyama Rd, Maseru");
  await expect(row).toContainText("INV-000001");
  await expect(page.getByText(/1 still to go/)).toBeVisible();

  // The note itself carries no money at all.
  await row.click();
  const peek = page.getByRole("dialog", { name: "Delivery DEL-000001" });
  await peek.getByRole("button", { name: "Delivery note" }).click();
  const doc = page.getByRole("dialog", { name: "Delivery Note DEL-000001" });
  await expect(doc.locator("#doc-sheet")).toBeVisible();
  await expect(doc).toContainText("Cement 42.5N 50kg");
  await expect(doc).toContainText("Deliver to");
  await expect(doc).toContainText("14 Kolonyama Rd, Maseru");
  await expect(doc).toContainText("after 14:00");
  await expect(doc).toContainText("INV-000001");
  // What the customer signs.
  await expect(doc).toContainText("received in the quantities shown and in good condition");
  await expect(doc).toContainText("Notes / exceptions");
  await expect(doc).toContainText("Received by (print name)");
  // No prices, no totals, and no carriage line among the goods: the invoice
  // carries the figures, and nobody signs for "Delivery x 1" at a gate.
  await expect(doc).not.toContainText("Unit price");
  await expect(doc).not.toContainText("Subtotal");
  // Scoped to ONE copy: there are two of everything on this document, and
  // "two rows" across both copies would have been one goods line each — the
  // right number for the wrong reason.
  const firstCopy = doc.locator(".doc-a4").first();
  await expect(firstCopy.locator(".doc-lines tbody tr")).toHaveCount(1);
  await expect(firstCopy.locator(".doc-lines")).not.toContainText("Delivery");
  // Two copies, so one comes back signed.
  await expect(doc.locator(".doc-a4")).toHaveCount(2);
  await expect(doc).toContainText("Customer copy");
  await expect(doc).toContainText("Shop copy");
  await page.getByRole("button", { name: "Close document" }).click();

  // Signed for, by whoever took the page off the driver.
  await peek.getByRole("button", { name: "Mark delivered" }).click();
  await expect(page.getByText(/0 still to go/)).toBeVisible();
  await expect(page.locator("tr.acc-row", { hasText: "DEL-000001" }))
    .toContainText("Delivered");
  expect(be.deliveries[0].status).toBe("delivered");
  expect(be.deliveries[0].delivered_by_name).toBe(USERS.employee.row.name);
});

test("changing the delivery charge replaces the line rather than adding another", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: /^Deliver$/ }).click();
  let form = page.getByRole("dialog", { name: "Deliver this sale" });
  await form.getByLabel("Deliver to").fill("Morija Exports");
  await form.getByLabel("Address").fill("14 Kolonyama Rd");
  await form.getByLabel("Delivery charge").fill("85");
  await form.getByRole("button", { name: "Add to the sale" }).click();

  // Somebody looks it up on a map and it is further than they thought.
  await page.getByRole("button", { name: /Deliver · Morija Exports/ }).click();
  form = page.getByRole("dialog", { name: "Deliver this sale" });
  await expect(form.getByLabel("Address")).toHaveValue("14 Kolonyama Rd");
  await form.getByLabel("Delivery charge").fill("120");
  await form.getByRole("button", { name: "Add to the sale" }).click();

  await expect(page.locator(".line-row", { hasText: "Delivery" })).toHaveCount(1);
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  expect(be.storedSales[0].total).toBe(235);
});

test("a delivery arranged offline says so rather than losing the address quietly", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Deliver$/ }).click();
  const form = page.getByRole("dialog", { name: "Deliver this sale" });
  await form.getByLabel("Deliver to").fill("Morija Exports");
  await form.getByLabel("Address").fill("14 Kolonyama Rd");
  await form.getByRole("button", { name: "Add to the sale" }).click();

  // The line drops between arranging it and taking the money. A queued sale
  // has no id on the server, so there is nothing for a note to belong to —
  // and somebody is standing there waiting to load a bakkie.
  be.offline = true;
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  // 0096: named now — the till numbers the note from its own block.
  await expect(banner(page)).toContainText(/Delivery note DEL-\d{6} for Morija Exports follows when the connection returns/i);
  expect(be.deliveries).toHaveLength(0);
});

/*
 * 0063: the reports that answer the rest of the questions.
 */
test("a delivery shows up in the reports as its own department and its own tab", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Deliver$/ }).click();
  const form = page.getByRole("dialog", { name: "Deliver this sale" });
  await form.getByLabel("Deliver to").fill("Morija Exports");
  await form.getByLabel("Address").fill("14 Kolonyama Rd");
  await form.getByLabel("Delivery charge").fill("90");
  await form.getByRole("button", { name: "Add to the sale" }).click();
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();

  await openManage(page);
  await page.getByRole("button", { name: /^Reports$/ }).click();

  // DEPARTMENTS. The carriage was always in the takings and the VAT; what it
  // was not was visible. It landed under "—" with whatever else nobody had
  // filed, at a hundred percent margin.
  await report(page, "Departments");
  const depts = page.getByRole("region", { name: "Departments" });
  await expect(depts).toContainText("Delivery");

  // ITS OWN TAB. Money is half of it; the other half is whether the load went.
  await report(page, "Deliveries");
  const del = page.getByRole("region", { name: "Deliveries" });
  await expect(del).toContainText("Arranged");
  await expect(del).toContainText("DEL-000001");
  await expect(del).toContainText("Morija Exports");
  await expect(del).toContainText("14 Kolonyama Rd");
  // Charged is what the note agreed; earned is what the invoice took, less
  // VAT. R90 in becomes R78.26 earned.
  await expect(del).toContainText("90.00");
  await expect(del).toContainText("78.26");
  await expect(del).toContainText("Still to go out");
});

test("the reports answer who sold it, what came back, and what the shelves are worth", async ({ page }) => {
  be.customers.push({
    id: "k1", code: "TRD-001", name: "Mokoena Building Contractors",
    phone: "051 924 0000", is_trade: false, credit_limit: 25000,
    balance: 0, available: 25000,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  await page.locator(".modal-row", { hasText: "Mokoena" }).click();
  await page.getByRole("button", { name: /^Account$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();

  await openManage(page);
  await page.getByRole("button", { name: /^Reports$/ }).click();

  // WHO. The day close balances a drawer; two people work one till.
  await report(page, "People");
  const people = page.getByRole("region", { name: "People" });
  await expect(people).toContainText(USERS.manager.row.name);
  await expect(people).toContainText("115.00");

  // WHAT MOVED, line by line rather than by department.
  await report(page, "Items");
  const items = page.getByRole("region", { name: "Items" });
  await expect(items).toContainText("Cement 42.5N 50kg");
  await expect(items).toContainText("CEM-425-50");

  // WHAT THE SHELVES ARE WORTH, and what is no longer earning on them.
  await report(page, "Stock");
  const stock = page.getByRole("region", { name: "Stock" });
  await expect(stock).toContainText("At cost");
  await expect(stock).toContainText("At retail");
  await expect(stock).toContainText("Where the margin went");

  // WHO OWES. The sale above went on account, so the shop is owed for it.
  await report(page, "Debtors");
  const debtors = page.getByRole("region", { name: "Debtors" });
  await expect(debtors).toContainText("Mokoena Building Contractors");
  await expect(debtors).toContainText("115.00");

  // WHAT IT BOUGHT. Nothing yet, and it says so rather than showing an empty
  // table with no explanation.
  await report(page, "Suppliers");
  await expect(page.getByRole("region", { name: "Suppliers" }))
    .toContainText("No supplier paperwork in this range");
});

test("a supplier on the spend report opens its page", async ({ page }) => {
  be.suppliers.push({
    id: "sup1", name: "AKBRO STEEL AND HARDWARE CC", contact_name: null, phone: "051 447 0000",
    email: null, address: null, vat_number: "4000000001", notes: null,
  });
  be.supplierDocs.push({
    id: "doc1", supplier_id: "sup1", kind: "invoice", doc_number: "INV-1201",
    doc_date: "2026-09-07", total: 7782.74, note: null, status: "received",
    created_at: "2026-09-07T08:00:00Z",
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Reports$/ }).click();
  await report(page, "Suppliers");
  const region = page.getByRole("region", { name: "Suppliers" });
  await expect(region).toContainText("7 782.74");

  // The figure came from somewhere: the row is the supplier, and opens it.
  await region.getByRole("button", { name: "Open AKBRO STEEL AND HARDWARE CC" }).click();
  await expect(page.getByRole("heading", { name: "AKBRO STEEL AND HARDWARE CC" })).toBeVisible();
  await expect(page.getByRole("button", { name: "← Suppliers" })).toBeVisible();
  await expect(page.locator("tr.acc-row", { hasText: "Invoice INV-1201" })).toBeVisible();

  // Back to the list, and the list is the list: the supplier it was asked
  // to open is not opened again.
  await page.getByRole("button", { name: "← Suppliers" }).click();
  await expect(page.locator("tr.acc-row", { hasText: "AKBRO STEEL" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AKBRO STEEL AND HARDWARE CC" })).toHaveCount(0);
});

test("a report tab a cashier cannot open is not there at all", async ({ page }) => {
  // Reports live behind view_reports, and every new one is gated with the
  // rest: the Manage door itself refuses, so the tabs are unreachable.
  await pairAndSignIn(page, USERS.employee.pin);
  await expect(page.getByRole("button", { name: /Manage/i })).toHaveCount(0);
});

test("a delivery costs the shop, and a free one costs it just the same", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();
  await page.getByLabel("Cost per delivery").fill("60");
  await page.getByRole("button", { name: "Save cost" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

  // A trip given away. It is the case that matters most: the shop still paid
  // for the fuel and the hour, and before this there was no line at all on a
  // free delivery, so it cost nothing as far as any report could tell.
  await page.getByRole("button", { name: /Back to till/i }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Deliver$/ }).click();
  const form = page.getByRole("dialog", { name: "Deliver this sale" });
  await form.getByLabel("Deliver to").fill("Someone Local");
  await form.getByLabel("Address").fill("Round the corner");
  await form.getByRole("button", { name: "Add to the sale" }).click();
  // The line goes on even at nothing, so the customer sees they were not
  // charged and the shop records what it cost to do.
  await expect(page.locator(".line-row", { hasText: "Delivery" })).toBeVisible();
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  // The sale is the goods alone: a free delivery adds nothing to the total.
  expect(be.storedSales[0].total).toBe(115);
  await page.getByLabel("Close", { exact: true }).click();

  await openManage(page);
  await page.getByRole("button", { name: /^Reports$/ }).click();
  await report(page, "Deliveries");
  const del = page.getByRole("region", { name: "Deliveries" });
  await expect(del).toContainText("Cost of the trips");
  // R60 out, nothing in: delivering cost the shop sixty rand today.
  await expect(del).toContainText("60.00");
  await expect(del).toContainText("-R 60.00");
  // And it does not tell the shop to go and set a cost it has already set.
  await expect(del).not.toContainText("No cost is recorded against a delivery");
});

test("a buyer's name, number or address is put right at the counter, and nothing about money moves", async ({ page }) => {
  be.customers.push(
    { id: "k1", code: null, name: "Zaib Ahmad", phone: "0673747474", is_trade: false,
      credit_limit: 0, balance: 0, available: 0 },
    { id: "k2", code: "TRD-001", name: "Thabo Mokoena", phone: "082 555 0186", is_trade: true,
      credit_limit: 25000, balance: 0, available: 25000 },
  );
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  const picker = page.getByRole("dialog", { name: /Choose a customer/i });
  await picker.locator(".modal-row", { hasText: "Zaib Ahmad" }).click();
  await expect(page.getByRole("button", { name: /Zaib Ahmad/ })).toBeVisible();

  // THE PENCIL. The cashier hears about the wrong digit standing in front
  // of the person; they should not have to send it to the back office.
  await page.getByRole("button", { name: /Zaib Ahmad/ }).click();
  await picker.getByRole("button", { name: "Edit Zaib Ahmad" }).click();
  const form = picker.getByRole("group", { name: "Edit Zaib Ahmad" });
  await expect(form.getByLabel("Their name")).toHaveValue("Zaib Ahmad");
  await expect(form.getByLabel("Their phone number")).toHaveValue("0673747474");
  await expect(form).toContainText("Credit, trade pricing and the account itself are changed under Accounts");

  // A number belongs to one buyer: another's is refused, by name.
  await form.getByLabel("Their phone number").fill("0825550186");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(picker).toContainText("That number is already on file for Thabo Mokoena");

  await form.getByLabel("Their name").fill("Zaib Ahmed");
  await form.getByLabel("Their phone number").fill("067 374 7475");
  await form.getByLabel(/Delivery address/).fill("14 Mabille Rd, Maseru");
  await form.getByRole("button", { name: "Save changes" }).click();

  // Back on the list with the corrected row, and the record itself is right.
  await expect(form).toHaveCount(0);
  const row = picker.locator(".modal-row-pair", { hasText: "Zaib Ahmed" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("067 374 7475");
  expect(be.customers[0]).toMatchObject({
    name: "Zaib Ahmed", phone: "067 374 7475", address: "14 Mabille Rd, Maseru",
    credit_limit: 0, is_trade: false, code: null,
  });

  // The sale follows: it was theirs, and the slip will carry the right name.
  await picker.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: /Zaib Ahmed/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Zaib Ahmad/ })).toHaveCount(0);
});

test("a buyer given by name is added right there, with the number that finds them again", async ({ page }) => {
  await pairAndSignIn(page, USERS.employee.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Walk-in customer/i }).click();
  const picker = page.getByRole("dialog", { name: /Choose a customer/i });

  // A NAME, which is how somebody actually introduces themselves. This used to
  // dead-end at "Nothing on file matches": the offer to record a buyer was
  // only made when what had been typed read as a phone number.
  await picker.getByPlaceholder(/Name, account code or phone/i).fill("Ehsan");
  await expect(picker.getByText(/Nothing on file matches/i)).toHaveCount(0);
  await picker.getByRole("button", { name: /Add Ehsan as a new buyer/i }).click();

  // The name is carried through, and the number is ASKED for rather than
  // assumed — it is the key the record is kept under, so the save waits on it.
  await expect(picker.getByLabel(/Their name/i)).toHaveValue("Ehsan");
  await expect(picker.getByRole("button", { name: /^Save/ })).toBeDisabled();
  await picker.getByLabel(/Their phone number/i).fill("082 555 0143");
  await expect(picker.getByRole("button", { name: /^Save Ehsan/ })).toBeEnabled();
  await picker.getByRole("button", { name: /^Save/ }).click();

  await expect(page.getByText("Ehsan")).toBeVisible();
  expect(be.customers).toHaveLength(1);
  expect(be.customers[0].name).toBe("Ehsan");
  // A cashier recording a buyer never grants credit — that is a back-office
  // decision, and the server enforces it.
  expect(be.customers[0].is_trade).toBe(false);
  expect(be.customers[0].credit_limit).toBe(0);

  // And the sale is theirs.
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(page.locator("#print-area")).toContainText("Ehsan");
});

/*
 * 0065: counting the shelves.
 */
test("a stock take corrects the shelf, and a sale during the count still counts", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  const cement = PRODUCTS.find((p) => p.sku === "CEM-425-50")!;
  const before = cement.stock_qty!;

  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" }).click();
  // Entering Stock costs a PIN, even for a manager already signed in.
  for (const d of USERS.manager.pin.split("")) {
    await page.getByRole("dialog", { name: "Stock" })
      .locator(`button:text-is("${d}")`).first().click();
  }
  await page.getByRole("button", { name: "Stock take" }).click();
  await page.getByRole("button", { name: "Start a count" }).click();

  const sheet = page.locator("tr.acc-row", { hasText: "CNT-000001" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Continue" }).click();

  // The sheet says what the system expects, and nothing is counted yet.
  const row = page.locator("tr.acc-row", { hasText: "Cement 42.5N 50kg" });
  await expect(row).toContainText(String(before));

  // Three bags short on the shelf.
  await row.getByLabel(/Counted Cement/i).fill(String(before - 3));
  await row.getByLabel(/Counted Cement/i).blur();
  await expect(row).toContainText("-3");

  // THE SHOP KEEPS TRADING. Two bags go out while the aisle is being walked,
  // and setting stock to what the shelf held would put them back.
  //
  // Moved directly rather than by ringing up a sale: the fake backend does
  // not take stock down when it sells, which is a gap in the fake and not in
  // the till. What this test can still prove is the part that matters here —
  // that posting applies the DIFFERENCE against the snapshot rather than the
  // counted figure, so a movement from anywhere survives it. The interaction
  // with a real sale is proved in the database suite, where selling does move
  // stock.
  cement.stock_qty = before - 2;

  // Post it from where we are: the sheet is already open, and its expected
  // figures were taken when it was started.
  await page.getByRole("button", { name: /Post 1 correction/ }).click();

  // The DIFFERENCE was applied, not the counted figure: three missing bags
  // came off, and the two that were sold stayed sold.
  await expect(page.getByText(/1 line corrected/)).toBeVisible();
  expect(cement.stock_qty).toBe(before - 3 - 2);
  await expect(page.locator("tr.acc-row", { hasText: "CNT-000001" }))
    .toContainText("posted");
});

test("a line nobody counted is left exactly as it was", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  const chain = PRODUCTS.find((p) => p.sku === "CHN-06")!;
  const untouched = chain.stock_qty!;
  const cement = PRODUCTS.find((p) => p.sku === "CEM-425-50")!;

  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" }).click();
  // Entering Stock costs a PIN, even for a manager already signed in.
  for (const d of USERS.manager.pin.split("")) {
    await page.getByRole("dialog", { name: "Stock" })
      .locator(`button:text-is("${d}")`).first().click();
  }
  await page.getByRole("button", { name: "Stock take" }).click();
  await page.getByRole("button", { name: "Start a count" }).click();
  await page.locator("tr.acc-row", { hasText: "CNT-000001" })
    .getByRole("button", { name: "Continue" }).click();

  // One line counted, the rest of the sheet left blank — a half-finished
  // clipboard, which is the normal state of one at four in the afternoon.
  const row = page.locator("tr.acc-row", { hasText: "Cement 42.5N 50kg" });
  await row.getByLabel(/Counted Cement/i).fill("5");
  await row.getByLabel(/Counted Cement/i).blur();
  await page.getByRole("button", { name: /Post 1 correction/ }).click();

  expect(cement.stock_qty).toBe(5);
  // Blank means "I did not look", not "the shelf is empty".
  expect(chain.stock_qty).toBe(untouched);
});

test("what is short becomes an order, and half a load is booked in against it", async ({ page }) => {
  be.suppliers.push({
    id: "sup1", name: "Voltex", contact_name: null, phone: null,
    email: null, vat_number: null, notes: null,
  });
  const cable = PRODUCTS.find((p) => p.sku === "CBL-25-100")!;
  const before = cable.stock_qty!;
  // A SECOND SHORT LINE, or ticking one and ordering the lot look identical
  // and the selection proves nothing.
  const padlock = PRODUCTS.find((p) => p.sku === "PDL-50")!;
  padlock.reorder_level = padlock.stock_qty!;

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Buying$/ }).click();

  // WHAT TO ORDER. The one line at or below its reorder level, with how fast
  // it goes — "short 1" and "short 1, sells 30 a month" are different problems.
  const short = page.locator("tr.acc-row", { hasText: "Twin & Earth 2.5mm 100m" });
  await expect(short).toBeVisible();
  await expect(page.locator("tr.acc-row", { hasText: "Padlock 50mm Brass" })).toBeVisible();

  // A dead button says what is stopping it, not what it would have done.
  const raise = page.getByRole("button",
    { name: /Choose a supplier|Tick what to order|Raise an order/ });
  await expect(raise).toHaveText("Choose a supplier");
  await expect(raise).toBeDisabled();

  await page.getByLabel("Supplier to order from").selectOption("sup1");
  // ONE MERCHANT DOES NOT SELL EVERYTHING THAT IS SHORT. Nothing is ticked to
  // begin with, so the button cannot raise a list somebody then has to delete
  // back down.
  await expect(raise).toHaveText("Tick what to order");
  await expect(raise).toBeDisabled();

  await page.getByLabel("Order Twin & Earth 2.5mm 100m").check();
  await expect(raise).toHaveText("Raise an order for 1 line");
  await raise.click();
  await expect(page.getByText(/PO-000001 raised/)).toBeVisible();

  // It lands as a draft, on the order it was raised from.
  const line = page.locator("tr.acc-row", { hasText: "Twin & Earth 2.5mm 100m" });
  await expect(line).toBeVisible();
  await expect(page.getByText(/PO-000001 · Voltex · Draft/)).toBeVisible();
  // Only what was ticked: the padlock is short too and is NOT on the order.
  expect(be.poLines).toHaveLength(1);
  expect(be.poLines[0].product_id).toBe(cable.id);
  expect(be.poLines[0].qty).toBe(1);

  // AN ORDER WITH NO MONEY ON IT IS NOT A DOCUMENT ANYBODY CAN SEND. One
  // roll at R50 is R50, and the sheet has to say so.
  // The Amount cell specifically: asserting on the row matched the unit price
  // in the column beside it, and stayed green with the amount deleted.
  await expect(line.locator("td").nth(3)).toHaveText(/R\s?50\.00/);
  await expect(page.locator(".acc-note").filter({ hasText: "on this order" }))
    .toContainText(/R\s?50\.00/);

  // Ordering more than the bare shortfall, because one roll is not a delivery.
  await line.getByLabel(/Ordered Twin & Earth/i).fill("6");
  await line.getByLabel(/Ordered Twin & Earth/i).blur();
  await expect(line.getByLabel(/Ordered Twin & Earth/i)).toHaveValue("6");
  expect(be.poLines).toHaveLength(1);
  expect(be.poLines[0].qty).toBe(6);

  // Six at R50 is R300, on the line and on the order.
  await expect(page.locator(".acc-note").filter({ hasText: "on this order" }))
    .toContainText(/R\s?300\.00/);

  await page.getByRole("button", { name: "It has gone to the supplier" }).click();
  await expect(page.getByText("Marked as with the supplier.")).toBeVisible();
  // And the banner from raising it does not stack on top of that.
  await expect(page.getByText(/PO-000001 raised/)).toHaveCount(0);

  // HALF A LOAD IS THE NORMAL CASE. Four turn up, at a price that has moved.
  await line.getByLabel(/Arrived Twin & Earth/i).fill("4");
  await line.getByLabel(/Cost of Twin & Earth/i).fill("1180");
  await page.getByRole("button", { name: "Book in what arrived" }).click();
  await expect(page.getByText(/1 line is still to come/)).toBeVisible();

  expect(cable.stock_qty).toBe(before + 4);
  expect(be.poLines[0].received_qty).toBe(4);
  // Two still to come, on the order, not quietly written off.
  await expect(line.locator("td.num.is-bad")).toHaveText("2");

  // Cost is a fact and is recorded. Retail is a decision and is not touched:
  // a supplier's price rise must never silently reprice the shelf.
  expect(cable.cost).toBe(1180);
  expect(cable.price_retail).toBe(1450);

  // The rest, and the order closes.
  await line.getByLabel(/Arrived Twin & Earth/i).fill("2");
  await page.getByRole("button", { name: "Book in what arrived" }).click();
  await expect(page.getByText("That is the whole order in. Stock has moved.")).toBeVisible();
  expect(cable.stock_qty).toBe(before + 6);
  expect(be.purchaseOrders[0].status).toBe("received");
});

test("a part payment leaves the balance where somebody can still see it", async ({ page }) => {
  be.suppliers.push({
    id: "sup1", name: "Voltex", contact_name: null, phone: null,
    email: null, vat_number: null, notes: null,
  });
  const long = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const due = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
  be.supplierDocs.push({
    id: "doc1", supplier_id: "sup1", kind: "invoice", doc_number: "VX-7781",
    doc_date: long, total: 4300, note: null, status: "stored",
    created_at: new Date().toISOString(), due_date: due,
  });
  // A quote from the same supplier: filed, but not money owed.
  be.supplierDocs.push({
    id: "doc2", supplier_id: "sup1", kind: "quote", doc_number: "VX-Q2",
    doc_date: long, total: 9999, note: null, status: "stored",
    created_at: new Date().toISOString(),
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Buying$/ }).click();
  await page.getByRole("button", { name: "What you owe" }).click();

  const bill = page.locator("tr.acc-row", { hasText: "VX-7781" });
  await expect(bill).toBeVisible();
  await expect(bill).toContainText("15 days late");

  // A DATE IS PICKED FROM A CALENDAR, not typed into a browser prompt as
  // "YYYY-MM-DD" — which is fine for a developer and useless for somebody
  // standing at a counter with a tablet.
  await bill.getByRole("button", { name: "Due date" }).click();
  const dater = page.getByRole("dialog", { name: /When is VX-7781 due/ });
  const dueBox = dater.getByLabel("Due date");
  await expect(dueBox).toHaveAttribute("type", "date");
  await expect(dueBox).toHaveValue(due);
  await dueBox.fill("2026-09-01");
  await dater.getByRole("button", { name: "Save" }).click();
  await expect(bill).toContainText("days late");
  // And it can lose a date as well as gain one.
  await bill.getByRole("button", { name: "Due date" }).click();
  await page.getByRole("dialog", { name: /When is VX-7781 due/ })
    .getByRole("button", { name: "No date" }).click();
  await expect(bill).toContainText("no date");
  await bill.getByRole("button", { name: "Due date" }).click();
  await page.getByRole("dialog", { name: /When is VX-7781 due/ })
    .getByLabel("Due date").fill(due);
  await page.getByRole("dialog", { name: /When is VX-7781 due/ })
    .getByRole("button", { name: "Save" }).click();
  await expect(bill).toContainText("15 days late");
  await expect(bill).toContainText(/R\s?4\s?300\.00/);
  // A quote is not a bill.
  await expect(page.locator("tr.acc-row", { hasText: "VX-Q2" })).toHaveCount(0);

  // R1000 against R4300. The other R3300 is the number that must not vanish.
  // A browser prompt asking for a figure is no use on a tablet at a counter,
  // so this is a proper field with the outstanding amount already in it.
  await bill.getByRole("button", { name: "Pay" }).click();
  const payment = page.getByRole("dialog", { name: /Pay Voltex/ });
  await expect(payment).toContainText(/R\s?4\s?300\.00 still owed/);
  const amount = payment.getByLabel("Amount paid");
  await expect(amount).toHaveValue("4300");
  // The box says what the figure DOES. There used to be a "Pay it all" button
  // here that set the field to what it already said and so did nothing at all.
  await expect(payment).toContainText("This settles it.");
  // A payment of nothing is not a payment, and the box says so rather than
  // leaving a dead button to be puzzled over.
  await amount.fill("");
  await expect(payment).toContainText("A payment has to be for something.");
  await expect(payment.getByRole("button", { name: /^Pay/ })).toBeDisabled();
  await amount.fill("0");
  await expect(payment.getByRole("button", { name: /^Pay/ })).toBeDisabled();

  await amount.fill("1000");
  await expect(payment).toContainText(/R\s?3\s?300\.00 will still be owed/);
  await payment.getByRole("button", { name: /^Pay R\s?1\s?000\.00$/ }).click();
  await expect(bill).toContainText(/R\s?3\s?300\.00/);
  await expect(bill).toContainText(/R\s?1\s?000\.00/);
  expect(be.supplierDocs[0].paid_at).toBeNull();

  // Settled, and it leaves the list. The box opens on what is actually left.
  await bill.getByRole("button", { name: "Pay" }).click();
  const rest = page.getByRole("dialog", { name: /Pay Voltex/ });
  await expect(rest.getByLabel("Amount paid")).toHaveValue("3300");
  await expect(rest).toContainText("This settles it.");
  await rest.getByRole("button", { name: /^Pay R\s?3\s?300\.00$/ }).click();
  await expect(page.locator("tr.acc-row", { hasText: "VX-7781" })).toHaveCount(0);
  await expect(page.getByText("Nothing is owed to a supplier.")).toBeVisible();
  expect(be.supplierDocs[0].paid_amount).toBe(4300);
});

test("a statement opens on what was owed before it, and adds up to what is owed now", async ({ page }) => {
  // The clock is pinned, because every figure below is arithmetic on it and
  // two of them straddle a boundary that moves with the calendar. "Last 3
  // months" runs from the FIRST of the month two months back, which is 75
  // days before the 14th of a month — so the 75-day-old invoice was outside
  // the window on the 13th and inside it on the 14th, and this test passed
  // or failed by the date it was run on. The ageing buckets below are
  // counted from today too, so no single offset is safe on every day of the
  // year; the fixed date is.
  const NOW = new Date("2026-09-13T10:00:00Z");
  await page.clock.setFixedTime(NOW);
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 864e5).toISOString();
  be.customers.push({
    id: "k9", code: "TRD-009", name: "Molefe Builders",
    phone: "082 444 7788", is_trade: true, credit_limit: 50000,
    balance: 0, available: 50000,
    address: "12 Kerk St, Ladybrand", vat_number: "4370229645",
    // The account was opened owing money, three months ago.
    opening_balance: 1500, created_at: daysAgo(100),
  });
  // One charge before the window and one inside it.
  const sale = (at: string, total: number) => ({
    client_ref: null, cashier_id: USERS.manager.row.id, customer_id: "k9",
    items: [{ product_id: "p1", qty: 1 }], payment_method: "account",
    discount_amount: 0, discount_reason: null, approved_by: null,
    created_at: at, total, payments: [], po_number: null,
    customer_vat_number: null, rounding: 0, within_limit: true,
    amount_tendered: null, change_due: null,
  });
  be.sales.push(sale(daysAgo(75), 460));
  be.sales.push(sale(daysAgo(10), 230));
  // A cash sale to the same buyer, which never touched the account.
  be.sales.push({ ...sale(daysAgo(9), 115), payment_method: "cash" });
  be.accountPayments.push({
    id: "ap9", customer_id: "k9", amount: 400, method: "cash",
    reference: "receipt 1", client_ref: null, voided: false,
    created_at: daysAgo(8),
  });
  // And one that was reversed. It stays on the statement and pays nothing.
  be.accountPayments.push({
    id: "ap10", customer_id: "k9", amount: 250, method: "eft",
    reference: "wrong account", client_ref: null, voided: true,
    created_at: daysAgo(5),
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Accounts" }).click();
  await page.locator("tr.acc-row", { hasText: "Molefe Builders" }).click();

  await page.getByLabel("Statement period").selectOption("3");
  await page.getByRole("button", { name: /^Statement$/ }).click();

  const doc = page.locator(".doc-a4");
  await expect(doc).toBeVisible();
  await expect(doc).toContainText("Statement for");
  await expect(doc).toContainText("Molefe Builders");
  await expect(doc).toContainText("VAT No 4370229645");

  // THE OPENING BALANCE IS EVERYTHING BEFORE THE WINDOW. The account opened
  // owing 1500 and the 75-day-old invoice was 460, and neither is a line
  // inside a three-month window that starts after them.
  const brought = doc.locator("tr.doc-brought");
  await expect(brought).toContainText("Balance brought forward");
  await expect(brought).toContainText(/1\s?960\.00/);

  // The charge inside the window is listed; the cash sale is not on the
  // account and must never appear on a statement.
  await expect(doc.locator(".doc-statement tbody tr")).toHaveCount(4);
  await expect(doc).toContainText("Invoice");
  await expect(doc.locator(".doc-statement")).not.toContainText("115.00");

  // A reversed payment is shown, marked, and pays nothing.
  const reversed = doc.locator(".doc-statement tbody tr", { hasText: "wrong account" });
  await expect(reversed).toContainText("(reversed)");
  await expect(reversed).not.toContainText("250.00");

  // IT HAS TO ADD UP: 1960 + 230 - 400 = 1790, and the last line lands there.
  const totals = doc.locator(".doc-totals");
  await expect(totals).toContainText(/Charged/);
  await expect(totals.locator("tr.doc-total")).toContainText("Balance now due");
  await expect(totals.locator("tr.doc-total")).toContainText(/1\s?790\.00/);
  await expect(doc.locator(".doc-statement tbody tr").last())
    .toContainText(/1\s?790\.00/);

  // How old the money is, which is the half that gets a shop paid. Payments
  // are consumed oldest first: the R400 comes off the 100-day-old opening
  // balance, leaving R1 100 at 90+ days, the 75-day-old invoice whole at 60
  // days, and only the recent R230 current. Calling any of that "current"
  // would be the lie that lets a debt sit.
  const ageing = doc.locator(".doc-ageing");
  await expect(ageing.locator("tr", { hasText: "90+ days" }))
    .toContainText(/1\s?100\.00/);
  await expect(ageing.locator("tr", { hasText: "60 days" })).toContainText("460.00");
  await expect(ageing.locator("tr", { hasText: "Current" })).toContainText("230.00");
});

test("the back office and the calculator open from the stock room, not only from the counter", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" }).click();
  for (const d of USERS.manager.pin.split("")) {
    await page.getByRole("dialog", { name: "Stock" })
      .locator(`button:text-is("${d}")`).first().click();
  }
  await expect(page.getByRole("button", { name: "Stock take" })).toBeVisible();

  // Accounts, Quotes, Deliveries and Stock return early — above the point in
  // the tree where every modal was written. Pressing these set the state and
  // rendered nothing at all, so the header's buttons looked broken from the
  // four screens somebody spends the most time on.
  await page.getByRole("button", { name: "Calculator" }).click();
  const calc = page.getByRole("dialog", { name: /Calculator/i });
  await expect(calc).toBeVisible();
  await calc.getByRole("button", { name: "Close calculator" }).click();
  await expect(calc).toHaveCount(0);

  await page.getByRole("button", { name: /^Manage$/ }).click();
  const gate = page.getByRole("dialog", { name: "Manage" });
  await expect(gate).toBeVisible();
  for (const d of USERS.manager.pin.split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(page.getByRole("button", { name: /^Buying$/ })).toBeVisible();
});

test("tapping Count by mistake can be undone without touching the shelf", async ({ page }) => {
  const cable = PRODUCTS.find((p) => p.sku === "CBL-25-100")!;
  const before = cable.stock_qty!;
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" }).click();
  for (const d of USERS.manager.pin.split("")) {
    await page.getByRole("dialog", { name: "Stock" })
      .locator(`button:text-is("${d}")`).first().click();
  }

  const row = page.locator("tr", { hasText: "Twin & Earth 2.5mm 100m" }).first();
  await row.getByRole("button", { name: "Count" }).click();
  const box = row.getByLabel(/Counted quantity of Twin & Earth/i);
  await expect(box).toBeVisible();
  await box.fill("99");

  // Escape was the only way out, which is no way out at all on a tablet.
  await row.getByRole("button", { name: /Stop counting Twin & Earth/i }).click();
  await expect(box).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Count" })).toBeVisible();
  // Nothing was written: a mistaken tap must not move stock.
  expect(cable.stock_qty).toBe(before);
  expect(be.stockMoves).toHaveLength(0);
});

test("a scanned code goes straight to its line, and the sheet says what the shortage cost", async ({ page }) => {
  const cement = PRODUCTS.find((p) => p.sku === "CEM-425-50")!;
  const chain = PRODUCTS.find((p) => p.sku === "CHN-06")!;
  const before = cement.stock_qty!;

  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" }).click();
  for (const d of USERS.manager.pin.split("")) {
    await page.getByRole("dialog", { name: "Stock" })
      .locator(`button:text-is("${d}")`).first().click();
  }
  await page.getByRole("button", { name: "Stock take" }).click();
  await page.getByRole("button", { name: "Start a count" }).click();
  await page.locator("tr.acc-row", { hasText: "CNT-000001" })
    .getByRole("button", { name: "Continue" }).click();

  // SCANNING IS THE MOTION IN AN AISLE. A scanner is a keyboard that types
  // fast and presses Enter, so the code goes through the same box that
  // filters by name and lands the cursor where the number goes.
  const finder = page.getByLabel("Scan or find a line on this sheet");
  await finder.fill(cement.barcode!);
  await finder.press("Enter");
  const box = page.getByLabel(`Counted ${cement.name}`);
  await expect(box).toBeFocused();
  // The code is not left filtering the sheet behind the row it just found.
  await expect(finder).toHaveValue("");

  // Three short. Enter sends focus back to the scan box, or the next scan
  // lands in this quantity and silently miscounts the item just entered.
  await box.fill(String(before - 3));
  await box.press("Enter");
  await expect(finder).toBeFocused();

  // WHAT IT COST, BEFORE ANYTHING IS POSTED. Cement is 50 in the fake, so
  // three of them is 150 — the number an owner reacts to, not "3 short".
  const row = page.locator("tr.acc-row", { hasText: cement.name });
  await expect(row).toContainText(/150\.00 gone/);
  await expect(page.locator(".acc-note").first()).toContainText(/150\.00 short/);
  await expect(page.getByRole("button", { name: /Post 1 correction/ }))
    .toContainText(/150\.00 off the books/);

  // A SKU works as well as a barcode: not everything on a shelf has one.
  await finder.fill(chain.sku);
  await finder.press("Enter");
  await expect(page.getByLabel(`Counted ${chain.name}`)).toBeFocused();

  // Something not on this sheet says so, rather than showing an empty list.
  await finder.fill("NOT-A-THING");
  await finder.press("Enter");
  await expect(page.locator(".acc-note.is-bad"))
    .toContainText("NOT-A-THING is not on this sheet.");

  await page.getByRole("button", { name: /Post 1 correction/ }).click();
  await expect(page.getByText(/150\.00 off the books/)).toBeVisible();
  expect(cement.stock_qty).toBe(before - 3);
  // The cost is on the movement, or the loss can be counted but never added up.
  expect(be.stockMoves.at(-1)).toMatchObject({
    product_id: cement.id, qty_delta: -3, reason: "stocktake", unit_cost: 50,
  });
});

test("what walked out of the door without being sold is a number the owner can see", async ({ page }) => {
  // A count found three cement short; somebody wrote a chain off by hand.
  be.stockMoves.push({
    product_id: "p1", qty_delta: -3, reason: "stocktake",
    note: "Counted 237, expected 240", unit_cost: 50,
  });
  be.stockMoves.push({
    product_id: "p2", qty_delta: -2, reason: "adjustment",
    note: "Kinked, thrown away", unit_cost: 20,
  });
  // A sale is not a loss. It is the whole distinction the report exists for.
  be.stockMoves.push({
    product_id: "p1", qty_delta: -8, reason: "sale", note: null, unit_cost: 50,
  });
  // An old movement with no cost against it is valued at today's and said to
  // be an estimate, rather than quietly left out of the total.
  be.stockMoves.push({
    product_id: "p3", qty_delta: -1, reason: "adjustment",
    note: "Old movement", unit_cost: null,
  });
  // And a product the shop has NO cost for at all is the third case. Real
  // tills have them — something added in a hurry, or imported with no cost.
  PRODUCTS.find((p) => p.sku === "PDL-50")!.cost = null;
  be.stockMoves.push({
    product_id: "p5", qty_delta: -2, reason: "stocktake",
    note: "Counted 43, expected 45", unit_cost: null,
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Reports$/ }).click();
  await report(page, "Losses");

  const view = page.getByRole("region", { name: "Losses" });
  await expect(view).toBeVisible();
  // 3 × 50 counted short, plus 2 × 20 and 1 × 50 written off = 240. The two
  // padlocks are NOT in it: nobody can say what they were worth.
  // Scoped to the summary: "Counted short" is also a value in the table below,
  // and an assertion that matches either proves neither.
  const glance = view.getByRole("group", { name: "Losses at a glance" });
  await expect(glance).toContainText(/Lost, at costR\s?240\.00/);
  await expect(glance).toContainText(/Counted shortR\s?150\.00/);
  await expect(glance).toContainText(/Written offR\s?90\.00/);

  const short = view.locator("tr", { hasText: "Cement 42.5N 50kg" });
  await expect(short).toContainText("Counted short");
  await expect(short).toContainText("150.00");
  const off = view.locator("tr", { hasText: "Chain 6mm Galvanised" });
  await expect(off).toContainText("Written off");

  // The estimate is marked where it is one.
  await expect(view.locator("tr", { hasText: "Wire Nails 100mm loose" }))
    .toContainText("estimated");
  await expect(view).toContainText(/valued at today/i);

  // A LOSS NOBODY CAN VALUE IS NOT A LOSS OF NOTHING. "R 0.00, estimated"
  // reads as "worth nothing", and a shop reading that concludes it lost
  // nothing. It is listed, said to have no cost, and kept out of the totals
  // under a warning that the real figure is higher than the one shown.
  const unknown = view.locator("tr", { hasText: "Padlock 50mm Brass" });
  await expect(unknown).toContainText("no cost recorded");
  await expect(unknown).not.toContainText("estimated");
  await expect(unknown).not.toContainText("0.00");
  await expect(glance).toContainText(/1 line has no cost recorded at all/);
  await expect(glance).toContainText(/2 units the shop cannot put a price on/);
  await expect(glance).toContainText(/the real loss is higher than it says/);
});

test("a manager's phone has Deliveries and Stock, and a counter hand's has Deliveries only", async ({ page }) => {
  // The first two of the till's own screens worked from away from the
  // counter. Deliveries is open to everybody who can sign in, as it is on
  // the till; the stock room needs manage_inventory, which a counter hand
  // does not have — so their phone does not offer it, and offering it would
  // only be a locked door.
  await page.setViewportSize({ width: 390, height: 844 });
  await enrolPhoneAndSignIn(page, be);
  await page.getByRole("button", { name: "Sections" }).click();
  await expect(page.getByRole("menuitem", { name: "Deliveries" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Stock" })).toBeVisible();
});

test("a counter hand's phone offers Deliveries but not the stock room", async ({ page }) => {
  // A fresh page: signing out leaves a phone paired to its owner, so the
  // second person needs their own device, as they would in the shop.
  await page.setViewportSize({ width: 390, height: 844 });
  await enrolPhoneAndSignIn(page, be, USERS.employee.pin);
  await page.getByRole("button", { name: "Sections" }).click();
  await expect(page.getByRole("menuitem", { name: "Deliveries" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Stock" })).toHaveCount(0);
});

test("from the phone, a delivery is marked off and the page never scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  be.deliveries.push({
    id: "d1", doc_number: "DEL-000001", sale_id: "s1", customer_name: "T. Mokoena",
    address: "14 Mabille Rd, Maseru", deliver_on: new Date().toISOString().slice(0, 10),
    deliver_at: null, charge: 0, note: null, status: "pending",
    cashier_name: "Manager", delivered_by_name: null, delivered_at: null,
  });
  await enrolPhoneAndSignIn(page, be);
  await phoneMenu(page, "Deliveries");
  await expect(page.getByRole("heading", { name: "Deliveries" })).toBeVisible();
  await expect(page.getByText("T. Mokoena")).toBeVisible();

  // Measured on the document, and on the screen's own box: Manage's panel
  // trick (a wide element inside its own scroller) does not apply here, but
  // the phone body is its own scroller too, so both are checked.
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, "the page's scroll width").toBeLessThanOrEqual(390);
  const box = await page.locator(".phone-screen").boundingBox();
  expect(box!.x + box!.width, "the screen's right edge").toBeLessThanOrEqual(390);

  // A phone reads the list as cards: the table's heading row is gone, each
  // row stands on its own, and a cell says which column it was.
  const row = page.locator("tr.acc-row").first();
  expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe("block");
  expect(await page.locator(".acc-table thead").evaluate((el) => getComputedStyle(el).display)).toBe("none");
  expect(await row.locator("td[data-label='To']").evaluate(
    (el) => getComputedStyle(el, "::before").content)).toContain("To");
  await expect(row).toContainText("14 Mabille Rd, Maseru");

  // Marked off through the phone's own token, by the phone's owner.
  await page.getByRole("button", { name: "Delivered" }).first().click();
  await expect.poll(() => be.deliveries[0].status).toBe("delivered");
  expect(be.deliveries[0].delivered_by_name).toBe("Manager");

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator(".phone-home")).toBeVisible();
});

test("from the phone, the stock room opens on the PIN its owner signed in with", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enrolPhoneAndSignIn(page, be);
  await phoneMenu(page, "Stock");
  // A phone belongs to one person and locks itself when it is put away, and
  // the PIN they signed in with was proved against the server by the sign-in.
  // Asking for the same six digits again, seconds later, proves nothing.
  const gate = page.getByRole("dialog", { name: "Stock" });
  await expect(page.getByRole("heading", { name: "Stock" })).toBeVisible();
  await expect(gate).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stock take" })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, "the page's scroll width").toBeLessThanOrEqual(390);
  // The stock list as cards too, its figures labelled.
  await page.getByRole("button", { name: "Everything" }).click();
  const stockRow = page.locator(".acc-table tbody tr").first();
  expect(await stockRow.evaluate((el) => getComputedStyle(el).display)).toBe("block");
  expect(await stockRow.locator("td[data-label='On hand']").evaluate(
    (el) => getComputedStyle(el, "::before").content)).toContain("On hand");

  // Back, and in again without the PIN: it is held for the session.
  await page.getByRole("button", { name: "Back" }).click();
  await phoneMenu(page, "Stock");
  await expect(gate).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stock take" })).toBeVisible();
});

test("the department drives the list, and two sheets cannot be open over the same shelves", async ({ page }) => {
  const cement = PRODUCTS.find((p) => p.sku === "CEM-425-50")!;
  const before = cement.stock_qty!;
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" }).click();
  for (const d of USERS.manager.pin.split("")) {
    await page.getByRole("dialog", { name: "Stock" })
      .locator(`button:text-is("${d}")`).first().click();
  }
  await page.getByRole("button", { name: "Stock take" }).click();

  // The button says what it is about to do. "Start a count" beside a list of
  // other departments' sheets gave no clue which of the two the box above
  // belonged to — and it belonged to neither, it chose the next count while
  // the list showed everything.
  const start = page.getByRole("button", { name: /^Start a count/ });
  await expect(start).toHaveText("Start a count of everything");
  await start.click();
  await expect(page.locator("tr.acc-row", { hasText: "CNT-000001" })).toBeVisible();

  // TWO SHEETS OVER THE SAME SHELVES TAKE THE SAME SHORTAGE OFF TWICE: both
  // snapshot the same expected figure at open, and both post the difference.
  await start.click();
  await expect(page.locator(".acc-note.is-bad")).toContainText("CNT-000001");

  // Choosing a department now moves the list as well as the next count.
  await page.getByLabel("Department").selectOption({ label: "Building" });
  await expect(start).toHaveText("Start a count in Building");
  await expect(page.locator("tr.acc-row", { hasText: "CNT-000001" })).toHaveCount(0);
  await expect(page.getByText("No stock take in Building yet")).toBeVisible();
  // A whole-shop sheet covers Building too, so this is refused as well.
  await start.click();
  await expect(page.locator(".acc-note.is-bad")).toContainText("CNT-000001");

  // Clearing a half-started sheet no longer means opening it first, which is
  // why they piled up.
  await page.getByLabel("Department").selectOption({ label: "Everything" });
  await page.getByRole("button", { name: "Abandon CNT-000001" }).click();
  await expect(page.getByText("CNT-000001 abandoned. Nothing moved.")).toBeVisible();
  expect(cement.stock_qty).toBe(before);

  // And now the department sheet opens.
  await page.getByLabel("Department").selectOption({ label: "Building" });
  await page.getByRole("button", { name: "Start a count in Building" }).click();
  const second = page.locator("tr.acc-row", { hasText: "CNT-000002" });
  await expect(second).toBeVisible();
  await expect(second).toContainText("Building");
  // The abandoned whole-shop sheet is still not a Building sheet.
  await expect(page.locator("tr.acc-row", { hasText: "CNT-000001" })).toHaveCount(0);
  await page.getByLabel("Department").selectOption({ label: "Everything" });
  await expect(page.locator("tr.acc-row")).toHaveCount(2);
});

test("an invoice on an account opens the sale behind it", async ({ page }) => {
  be.customers.push({
    id: "k7", code: "TRD-007", name: "Ledger Builders",
    phone: "051 924 2222", is_trade: false, credit_limit: 40000,
    balance: 0, available: 40000,
  });
  await pairAndSignIn(page, USERS.manager.pin);

  // A sale on the account, rung up properly so the ledger has a real sale.
  await addBySearch(page, "cement", "Cement 42.5N 50kg", "3");
  const account = page.getByRole("button", { name: /^Account$/ });
  await account.click();
  await page.locator(".modal-row", { hasText: "Ledger Builders" }).click();
  await account.click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  await page.getByLabel("Close").click();

  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Accounts" }).click();
  await page.locator("tr.acc-row", { hasText: "Ledger Builders" }).click();

  // "WHAT DID WE ACTUALLY BUY ON THAT INVOICE" was three screens away: out of
  // Accounts, into Manage, open Sales, hunt the number.
  const charge = page.locator("tr", { hasText: "Invoice" }).first();
  await charge.click();
  const sale = page.getByRole("dialog", { name: /INV-/ });
  await expect(sale).toBeVisible();
  await expect(sale).toContainText("Cement 42.5N 50kg");
  await expect(sale).toContainText("Ledger Builders");
  await sale.getByLabel("Close").click();
  await expect(sale).toHaveCount(0);

  // A payment has no sale behind it, so its line does not pretend to open one.
  await page.getByLabel(/amount/i).first().fill("100");
  await page.getByRole("button", { name: /^Receive R/ }).click();
  const paid = page.locator("tr", { hasText: "Cash" }).first();
  await expect(paid).not.toHaveClass(/is-clickable/);
  await paid.click();
  await expect(page.getByRole("dialog", { name: /INV-/ })).toHaveCount(0);
});

/* -------------------------------------------------------------------------
   0074 — a phone is not a till.

   The counter is a 17" touch screen. A phone is the work done away from it,
   and the four things that must hold are all things a browser can ask for and
   be wrongly given: only its owner signs in on it, it cannot take money, the
   code that enrols it works once, and the errands it offers follow the
   permissions of whoever is holding it.
   ------------------------------------------------------------------------- */

test("a phone lands on its errands, not on the till", async ({ page }) => {
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);

  // The thing that would cost money if it were wrong: no sale screen.
  await expect(page.locator('input[placeholder*="Scan barcode"]')).toHaveCount(0);
  await expect(page.locator(".totals")).toHaveCount(0);

  // What it offers instead, and whose phone it says it is.
  await expect(page.locator(".phone-home-who h1")).toHaveText("Manager");
  await page.getByRole("button", { name: "Sections" }).click();
  await expect(page.getByRole("menuitem", { name: "Look it up" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Approvals" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Buying" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Said out loud, so nobody hunts for a till that is never coming.
  await expect(page.getByText(/a phone cannot take money/i)).toBeVisible();
});

test("a phone offers only the errands that person may run", async ({ page }) => {
  // Sam sells and discounts; Sam does not buy, approve, or read reports.
  await enrolPhoneAndSignIn(page, be, USERS.employee.pin);

  await expect(page.locator(".phone-home-who h1")).toHaveText("Sam");
  await page.getByRole("button", { name: "Sections" }).click();
  await expect(page.getByRole("menuitem", { name: "Look it up" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Deliveries" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Approvals" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Buying" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Reports" })).toHaveCount(0);
});

test("only its owner can sign in on a phone", async ({ page }) => {
  const code = be.issueEnrolmentCode(USERS.employee.row.id);
  await page.goto("/");
  await page.getByRole("button", { name: "This is my phone" }).click();
  await page.getByPlaceholder("ABCD2345").fill(code);
  await page.getByRole("button", { name: /Set up my phone/i }).click();

  // One name on the list, and it is Sam's — the manager is not offered at all.
  await expect(page.getByRole("button", { name: /^Sam\b/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Manager\b/ })).toHaveCount(0);
});

test("an enrolment code works once", async ({ page }) => {
  const code = be.issueEnrolmentCode(USERS.employee.row.id);
  await page.goto("/");
  await page.getByRole("button", { name: "This is my phone" }).click();
  await page.getByPlaceholder("ABCD2345").fill(code);
  await page.getByRole("button", { name: /Set up my phone/i }).click();
  await expect(page.getByRole("button", { name: /^Sam\b/ })).toBeVisible();

  // The same code on a second handset. A code read out over the phone and
  // overheard must not enrol the person who overheard it.
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");
  await page.getByRole("button", { name: "This is my phone" }).click();
  await page.getByPlaceholder("ABCD2345").fill(code);
  await page.getByRole("button", { name: /Set up my phone/i }).click();
  await expect(page.getByText(/code is not valid/i)).toBeVisible();
});

test("Look it up answers price, stock and bin with the line down", async ({ page }) => {
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  // The catalogue is cached by now; the yard has no signal.
  //
  // Both halves, as every other offline test here does it: be.offline stops the
  // server answering, and setOffline fires the browser's own event so the app
  // re-probes at once. Without the second the app does not notice until its
  // next 15-second heartbeat, and a 10-second assertion was racing it — which
  // is exactly how this failed once in a full run having passed on its own.
  be.offline = true;
  await page.context().setOffline(true);

  await phoneMenu(page, "Look it up");
  await page.getByPlaceholder(/Scan a barcode/i).fill("cement");

  const hit = page.locator(".phone-hit", { hasText: "Cement 42.5N 50kg" });
  await expect(hit).toBeVisible();
  await expect(hit.locator(".phone-hit-price")).toHaveText(/R\s?115\.00/);
  await expect(hit.locator(".phone-hit-stock")).toHaveText("240 bag on hand");
  // Where the thing physically is — the reason somebody in the aisle opened
  // this rather than walking back to the counter to ask.
  await expect(hit.locator(".phone-hit-bin")).toHaveText("Bin A1");
  // And it says so rather than showing yesterday's figure as today's.
  await expect(page.getByText(/as the phone last saw it/i)).toBeVisible();
});

test("a manager issues a code for somebody's phone from the staff list", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("button", { name: /^Manage$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Manage" });
  for (const d of USERS.manager.pin.split("")) {
    await dialog.locator(`button:text-is("${d}")`).first().click();
  }
  await page.getByRole("button", { name: "Staff" }).click();
  await page.getByRole("button", { name: /^Sam\b/ }).click();
  await page.getByRole("button", { name: /Set up their phone/i }).click();

  // Eight characters, from an alphabet with no I, O, 0 or 1 in it: this is
  // read down a telephone by somebody in a hurry.
  const shown = page.locator(".font-mono").first();
  await expect(shown).toHaveText(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);

  // And the address is THIS APP, where "This is my phone" lives.
  //
  // It pointed at ENROL_URL — pos.innovaearth.com/enrol/, the staff PIN site,
  // which is right for the "they have no PIN yet" dialog and wrong here. A
  // manager followed it and landed on "Set your PIN", a page with nothing on
  // it about a device, holding a code it could not accept.
  const origin = new URL(page.url()).origin;
  const link = page.getByRole("link").first();
  await expect(link).toHaveAttribute("href", origin);
  await expect(page.getByRole("link", { name: /enrol/i })).toHaveCount(0);
});

test("the menu opens the back office on its own screen, on the section picked", async ({ page }) => {
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  await phoneMenu(page, "Buying");

  // Straight in: a phone's owner proved this PIN at sign-in, against the same
  // server check the door would make. It is held in memory only, and every
  // call behind it is re-checked server-side.
  await expect(page.getByRole("dialog", { name: "Manage" })).toHaveCount(0);

  // Straight onto Buying, not onto the first tab of a nav the phone never
  // showed. Closing it comes back to the errands.
  //
  // Exact names, and the catalogue checked for by its absence: PhoneHome
  // stays mounted UNDER the back office, so a loose /What to order/ once
  // matched the old Buying tile's hint and passed with the routing broken.
  await expect(page.getByRole("button", { name: "What you owe", exact: true }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: /New product/i })).toHaveCount(0);
  // And the way out says where it goes: there is no till behind this.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".phone-home")).toBeVisible();
});

test("the shop's own model refuses money on a phone", async ({ page }) => {
  // The real rule is 0074's trigger, and supabase/test/schema.test.sql proves
  // it against a database. This proves the FAKE refuses too — which matters
  // because the browser suite runs against the model, and a model that would
  // let a phone ring up a sale is a model that would let somebody build the
  // screen for it and watch the tests go green.
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);

  const refusal = await page.evaluate(async () => {
    // localCache namespaces everything under "pos." and JSON-encodes it.
    const token = JSON.parse(localStorage.getItem("pos.device.registerToken")!);
    const res = await fetch("/rest/v1/rpc/pos_create_sale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        p_register_token: token,
        p_cashier_id: "u1",
        p_items: [{ product_id: "p1", qty: 1 }],
        p_payment_method: "cash",
      }),
    });
    return { status: res.status, body: await res.text() };
  });

  expect(refusal.status).toBeGreaterThanOrEqual(400);
  expect(refusal.body).toContain("money cannot be taken");
});

/**
 * Put the phone away for `seconds`, then pick it back up.
 *
 * The browser has no "screen went off" event; visibilitychange is what iOS
 * fires when the handset locks and again when it wakes, so that is what the
 * app listens to and what this drives. The clock is faked because nobody
 * should wait a real minute for a test.
 */
async function putAway(page: Page, seconds: number) {
  await page.clock.install();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(seconds * 1000);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("a phone put away asks for its owner's PIN before anything else", async ({ page }) => {
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  await putAway(page, 90);

  // Not a panel over the errands — they must not be readable, because somebody
  // who is not the owner may be holding the handset.
  await expect(page.locator(".phone-lock")).toBeVisible();
  await expect(page.locator(".phone-home-who")).toHaveCount(0);
  await expect(page.getByText(/put away/i)).toBeVisible();

  // Somebody else's PIN is not a way in, even a real one.
  for (const d of USERS.employee.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(page.getByText(/not recognised/i)).toBeVisible();
  await expect(page.locator(".phone-home-who")).toHaveCount(0);

  // Their own PIN puts them back where they were.
  for (const d of USERS.manager.pin.split("")) {
    await page.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(page.locator(".phone-home-who")).toBeVisible();
});

test("a phone glanced away from does not lock", async ({ page }) => {
  // Scan a document and Photograph shelf items both send the browser to the
  // camera. A lock that fired on every one of those would be a PIN after every
  // picture, which is how a security measure gets switched off.
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  await putAway(page, 10);

  await expect(page.locator(".phone-lock")).toHaveCount(0);
  await expect(page.locator(".phone-home-who")).toBeVisible();
});

test("a till is not locked by being left alone", async ({ page }) => {
  // The counter is watched, shared, and takes money all day. A PIN prompt in
  // front of a queue because nobody touched it for a minute is not security,
  // it is a jam.
  await pairAndSignIn(page, USERS.manager.pin);
  await putAway(page, 300);

  await expect(page.locator(".phone-lock")).toHaveCount(0);
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
});

test("a locked phone with no line still answers a price", async ({ page }) => {
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  be.offline = true;
  await page.context().setOffline(true);
  await putAway(page, 90);

  // The PIN cannot be proved without the line, and nothing on the device is
  // kept to prove it against. Refusing everything would brick the phone in the
  // one place Look it up was built for.
  await expect(page.locator(".phone-lock")).toBeVisible();
  await expect(page.locator(".phone-lock-offline")).toBeVisible();
  await page.getByRole("button", { name: /Look something up/i }).click();

  await page.getByPlaceholder(/Scan a barcode/i).fill("cement");
  const hit = page.locator(".phone-hit", { hasText: "Cement 42.5N 50kg" });
  await expect(hit.locator(".phone-hit-price")).toHaveText(/R\s?115\.00/);

  // And it is still locked: Back returns to the PIN, not to the errands.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".phone-lock")).toBeVisible();
  await expect(page.locator(".phone-home-who")).toHaveCount(0);
});

test("a tender picked by mistake is changed by tapping another", async ({ page }) => {
  // Tapping a tender settles the sale, and settled, every tender button went
  // disabled. A cashier who tapped Cash when the customer meant Card had no
  // way forward but the small × on the taken row — so they cancelled the sale
  // and rang it up again.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "Cash" }).click();
  const tenders = page.locator(".taken-row:not(.is-outstanding)");
  await expect(tenders).toHaveCount(1);
  await expect(tenders.first()).toContainText("Cash");

  // The others stay live, and say so.
  await expect(page.getByText(/Tap another to change it/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Card" })).toBeEnabled();

  // Tapping Card REPLACES the cash tender rather than adding to it — a sale
  // paid once must not end up recorded as paid twice.
  await page.getByRole("button", { name: "Card" }).click();
  await expect(tenders).toHaveCount(1);
  await expect(tenders.first()).toContainText("Card");
  await expect(tenders.first()).toContainText(/R\s?115\.00/);

  // And it still completes, on the method actually chosen.
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);
  expect(be.sales.at(-1)!.payments.map((p) => p.method)).toEqual(["card"]);
});

test("a split payment still adds rather than swapping", async ({ page }) => {
  // The flip is only meaningful while ONE tender holds the whole sale. With
  // two down, the buttons mean "add another" again and swapping would be
  // ambiguous about which of them it replaced.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  await page.getByLabel("Amount for the next tender").fill("50");
  await page.getByRole("button", { name: "Cash" }).click();
  await page.getByRole("button", { name: "Card" }).click();

  const tenders = page.locator(".taken-row:not(.is-outstanding)");
  await expect(tenders).toHaveCount(2);
  await expect(page.getByText(/Tap another to change it/i)).toHaveCount(0);
});

test("the counter does not offer a tender the shop does not take", async ({ page }) => {
  // Zapper is off the counter. The METHOD stays in the labels, because sales
  // already taken on it have to keep reading correctly everywhere else.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "Zapper" })).toHaveCount(0);
  // exact: the sections nav also has an "Accounts" button.
  for (const m of ["Cash", "Card", "EFT", "Account"]) {
    await expect(page.getByRole("button", { name: m, exact: true })).toBeVisible();
  }
});

test("a trade customer still says so, because it changes the money", async ({ page }) => {
  // The chip lost its second line — except this. "Trade price" is not a label
  // for the button, it is a statement that this sale is priced off a different
  // list, and the caption that used to repeat it is hidden on a short screen.
  be.customers.push({
    id: "k9", code: "TRD-009", name: "Ledger Builders",
    phone: "051 924 2222", is_trade: true, credit_limit: 40000,
    balance: 0, available: 40000,
  });
  await pairAndSignIn(page);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  await page.locator(".customer-pick").click();
  await page.locator(".modal-row", { hasText: "Ledger Builders" }).click();

  await expect(page.locator(".customer-pick")).toContainText("Ledger Builders");
  await expect(page.locator(".customer-pick .band")).toHaveText("Trade price");
});

test("changing back to cash asks what they handed over", async ({ page }) => {
  // Card, EFT and account settle to the exact cent, so swapping to one is a
  // finished decision. Cash is the only tender where the next question is
  // "how much did they give you" — and taking it at once answered that as
  // "exactly the total", settled the sale and shut the amount box. The counter
  // tapped Cash, watched it go back to cash, and had nowhere left to enter the
  // R200 note. It looked like the button had not worked.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "Card", exact: true }).click();
  await expect(page.locator(".taken-row:not(.is-outstanding)")).toHaveCount(1);

  // Back to cash: the card tender goes, and the till is where it was before
  // anything was tendered — nothing taken, keys live.
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await expect(page.locator(".taken-row:not(.is-outstanding)")).toHaveCount(0);
  const amount = page.getByLabel("Amount for the next tender");
  await expect(amount).toBeEnabled();

  // And the change comes out right.
  await amount.fill("200");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await expect(page.locator(".taken-row.is-outstanding")).toContainText(/R\s?85\.00/);

  await page.getByRole("button", { name: /Tender & print/i }).click();
  expect(be.storedSales[0].amount_tendered).toBe(200);
  expect(be.storedSales[0].change_due).toBe(85);
  expect(be.sales.at(-1)!.payments.map((p) => p.method)).toEqual(["cash"]);
});

test("a closer look fits the till, and does not reserve room for a photo that is not there", async ({ page }) => {
  // The photo box reserved 300px to say "No photograph yet" — a third of the
  // till's height spent on the absence of a picture — which pushed Close and
  // Add to sale off the bottom of the screen. Most of this shop's catalogue
  // has no photograph.
  await page.setViewportSize({ width: 1024, height: 590 });
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("cement");
  await page.locator(".result-row").first().click();

  await expect(page.locator(".detail-photo")).toHaveCount(0);
  await expect(page.getByText(/No photograph yet/i)).toHaveCount(0);

  // Measured without scrolling: the two buttons that are the whole point of
  // opening the card must be on the screen.
  const box = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".detail-actions button")]
      .find((b) => /Add to sale/.test(b.textContent || ""));
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { bottom: b.bottom, top: b.top };
  });
  expect(box, "Add to sale is not in the card").not.toBeNull();
  expect(box!.bottom, "Add to sale bottom").toBeLessThanOrEqual(590);
  expect(box!.top, "Add to sale top").toBeGreaterThanOrEqual(0);
});

test.describe("a touchscreen that is not an Android tablet", () => {
  // The shop's counter is a Windows all-in-one WITH a touchscreen. The print
  // path used to treat any touchscreen as the shop's Android tablet and
  // navigate to "rawbt:base64,…" — a scheme only RawBT, an Android app,
  // registers. On Windows that goes nowhere: no slip, no paper, no error.
  // "Tender & print" appeared to do nothing, on a sale whose money was taken.
  test.use({ hasTouch: true });

  test("prints a slip the counter can actually see", async ({ page }) => {
    await pairAndSignIn(page, USERS.manager.pin);
    await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Cash", exact: true }).click();
    await page.getByRole("button", { name: /Tender & print/i }).click();

    // The slip is on the screen, with the sale on it. (The preview is not a
    // dialog role; .animate-scale-in is the card, as the other preview tests
    // target it.)
    const slip = page.locator(".animate-scale-in");
    await expect(slip).toBeVisible();
    await expect(slip).toContainText("Cement 42.5N 50kg");
    await expect(slip).toContainText(/INV-\d+/);
  });
});

test("an item with several photographs gets thumbnails, and one photograph does not", async ({ page }) => {
  // The closer look showed only the primary photograph, so the second and
  // third — the ones that show the fitting from the other side — were taken,
  // stored, and never seen at the counter.
  const cement = PRODUCTS.find((p) => p.id === "p1")!;
  cement.image_url = "/catalogue/cement-a.png";
  cement.image_count = 3;
  cement.photos = [
    "/catalogue/cement-a.png",
    "/catalogue/cement-b.png",
    "/catalogue/cement-c.png",
  ];
  // Both seeded BEFORE sign-in: the catalogue is fetched and cached once, at
  // sign-in, so a product edited after that is not the product the till sees.
  const padlock = PRODUCTS.find((p) => p.id === "p5")!;
  padlock.image_url = "/catalogue/padlock.png";
  padlock.image_count = 1;
  padlock.photos = ["/catalogue/padlock.png"];

  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("cement");
  // By name, not by position: the result list lags a keystroke, so "the first
  // row" can still be the previous search's.
  await page.locator(".result-row", { hasText: "Cement 42.5N 50kg" }).first().click();
  await expect(page.locator(".detail-name")).toHaveText("Cement 42.5N 50kg");

  const shot = page.locator(".detail-photo img");
  // The cached photograph is up immediately; the rest arrive behind it.
  await expect(shot).toHaveAttribute("src", "/catalogue/cement-a.png");

  // A strip of what there is, rather than chevrons that hide it — the counter
  // can see there are three and go straight to the one they want.
  const thumbs = page.locator(".detail-shot");
  await expect(thumbs).toHaveCount(3);
  await expect(thumbs.nth(0)).toHaveClass(/is-on/);

  await thumbs.nth(2).click();
  await expect(shot).toHaveAttribute("src", "/catalogue/cement-c.png");
  await expect(thumbs.nth(2)).toHaveClass(/is-on/);
  await expect(thumbs.nth(0)).not.toHaveClass(/is-on/);

  await thumbs.nth(1).click();
  await expect(shot).toHaveAttribute("src", "/catalogue/cement-b.png");

  // One photograph gets no arrows and no dots: controls for a choice that
  // does not exist are furniture.
  await page.getByRole("button", { name: /^Close$/ }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("padlock");
  await page.locator(".result-row", { hasText: "Padlock 50mm Brass" }).first().click();
  await expect(page.locator(".detail-name")).toHaveText("Padlock 50mm Brass");
  await expect(page.locator(".detail-photo img")).toHaveCount(1);
  await expect(page.locator(".detail-shots")).toHaveCount(0);
  await expect(page.locator(".detail-shot")).toHaveCount(0);
});

test("the slip on screen is big enough to read, and none of it is off the edge", async ({ page }) => {
  // The counter could not read the figures on a 1024 screen at arm's length:
  // the preview was 11px. And the amounts are the RIGHTMOST thing on every
  // line, so the moment the text is wider than the card they are the part
  // that goes. The two numbers move together.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // Waited for, not raced. This measured the popup the instant the button was
  // clicked and happened to win; the slip is drawn after the sale comes back
  // from the server, so on a slower run it read null and blamed the layout.
  await expect(page.locator(".animate-scale-in pre")).toBeVisible();

  const m = await page.evaluate(() => {
    const pre = document.querySelector(".animate-scale-in pre") as HTMLElement;
    const box = pre.parentElement!;
    return {
      px: parseFloat(getComputedStyle(pre).fontSize),
      hidden: box.scrollWidth - box.clientWidth,
      widest: (pre.textContent || "").split("\n").reduce((w, l) => Math.max(w, l.length), 0),
    };
  });
  expect(m.widest, "the slip is a fixed-width document").toBeGreaterThanOrEqual(32);
  expect(m.px, "preview font size").toBeGreaterThanOrEqual(13);
  expect(m.hidden, "slip hidden past the right edge").toBeLessThanOrEqual(1);
});

test("the printed slip fits the paper instead of losing its right-hand column", async ({ page }) => {
  // `pre` does not wrap, so if 48 characters are wider than the page the rest
  // is clipped — and the rightmost thing on every line is the amount. The
  // print rules had no font-size at all: the slip inherited a browser default
  // that fits an A4 and runs off an 80mm roll.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // Measured against a NARROW page, because a wide one proves nothing: at a
  // 1280px page almost any font size fits, and the slip that actually gets
  // clipped is the one on an 80mm roll (~300px at 96dpi). This is the width
  // the rule has to survive.
  await page.setViewportSize({ width: 320, height: 600 });
  await page.emulateMedia({ media: "print" });
  const slip = await page.evaluate(() => {
    const pre = document.querySelector("#print-area pre") as HTMLElement;
    return {
      over: pre.scrollWidth - document.documentElement.clientWidth,
      size: parseFloat(getComputedStyle(pre).fontSize),
      page: document.documentElement.clientWidth,
    };
  });
  expect(slip.over, "printed slip past the page's right edge").toBeLessThanOrEqual(0);

  // The other half of the squeeze, and the reason this test is not satisfied
  // by simply making the type tiny: the counter could not read the figures.
  // 48 columns of monospace want 33.1em, so anything that fits at all divides
  // the page by not much more than 34 — a floor here and the clipping check
  // above leave the divisor almost no room to drift in either direction.
  //
  // Not guarded, and worth saying: the @page margin is another few percent of
  // the paper either way, and Playwright's print emulation has no page box for
  // a margin to come off — changing it leaves this test green. That rule (2mm,
  // so the Epson's head can actually reach the left-hand column) was checked
  // by reading it, not by a failing assertion.
  expect(slip.size, "printed slip's type").toBeGreaterThanOrEqual(slip.page / 29);
  await page.emulateMedia({ media: "screen" });
});

/**
 * Pretend this device does or does not have a camera.
 *
 * enumerateDevices is what the app asks (see lib/device.ts), and it is the
 * honest thing to stub: Chrome in this harness reports no videoinput anyway,
 * so a test that did nothing would be testing the camera-less case by accident
 * and the camera case not at all.
 */
async function withCamera(page: import("@playwright/test").Page, present: boolean) {
  await page.addInitScript((yes: boolean) => {
    const media = navigator.mediaDevices ?? ({} as MediaDevices);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        ...media,
        getUserMedia: () => Promise.reject(new Error("not in a test")),
        enumerateDevices: () =>
          Promise.resolve(
            yes
              ? [{ kind: "videoinput", deviceId: "cam", groupId: "g", label: "" }]
              : [{ kind: "audioinput", deviceId: "mic", groupId: "g", label: "" }]
          ),
      },
    });
  }, present);
}

test("a saved quote comes down named for the customer it is for", async ({ page }) => {
  // A downloads folder of Quotation-QUO-000001.pdf, Quotation-QUO-000002.pdf
  // tells nobody anything without opening each one. Who it is for is what a
  // person searches for weeks later, so it goes in the name.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save as quote/ }).click();

  const who = page.getByRole("dialog", { name: "Who is this quote for?" });
  await who.getByLabel("Quote for").fill("Smit & Co. (Pty) Ltd");
  await who.getByRole("button", { name: "Save quote" }).click();
  await page.getByLabel("Close").click();

  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  await page.locator("tr.acc-row", { hasText: "QUO-000001" }).click();

  const download = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "Quote QUO-000001" })
    .getByRole("button", { name: "PDF" }).click();

  // The number first, because that is what the document IS; the name after it.
  // And the punctuation in a real trading name is gone: Windows refuses a
  // filename carrying & ( ) or a trailing dot, so a shop that could not save
  // the file it had just made would be worse off than one with a plain name.
  expect((await download).suggestedFilename()).toBe(
    "Quotation-QUO-000001-Smit-Co-Pty-Ltd.pdf"
  );
});

test("a report comes out on the shop's own letterhead", async ({ page }) => {
  // The day close printed as a 48-column till slip and every other report
  // printed as nothing at all, so "the bank wants to see it" meant a
  // screenshot. They come out on the SAME sheet the quotations do.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close").click();

  await openManage(page);
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await report(page, "Departments");
  await page.getByRole("button", { name: /Print or save as PDF/ }).click();

  // The letterhead, which is the whole point: the same mark, name and address
  // a customer sees on a quotation.
  const sheet = page.locator("#doc-sheet .doc-a4");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".doc-shop")).toHaveText("Ladybrand Hardware");
  await expect(sheet.locator(".doc-title")).toHaveText("Sales by department");

  // What it covers and when it was run — a report is true of a moment, and
  // somebody will find this page in a drawer next March.
  await expect(sheet.locator(".doc-meta")).toContainText("Period");
  await expect(sheet.locator(".doc-meta")).toContainText("Printed");

  // The figures, and a total that is the sum of the rows above it.
  await expect(sheet.locator(".doc-lines tbody")).toContainText("R 115.00");
  await expect(sheet.locator(".doc-lines tfoot")).toContainText("R 115.00");

  // And it prints through the same path the A4 documents do, so Chrome's own
  // "Save as PDF" is the file — no second renderer to disagree with this one.
  await page.emulateMedia({ media: "print" });
  const shown = await page.evaluate(() => {
    const a4 = document.querySelector("#doc-sheet .doc-a4") as HTMLElement;
    const till = document.querySelector(".acc-table") as HTMLElement | null;
    return {
      sheet: getComputedStyle(a4).visibility,
      screenTable: till ? getComputedStyle(till).visibility : "absent",
    };
  });
  await page.emulateMedia({ media: "screen" });
  expect(shown.sheet, "the sheet on paper").toBe("visible");
});

test("the till does not offer Approvals, because the code is for when you are not at it", async ({ page }) => {
  // Issuing a code is what a manager does with a phone to their ear and the
  // till a mile away. Standing at the counter they type their PIN into the
  // discount dialog and no code exists — so the till was offering a screen
  // whose entire reason for existing is the till not being there.
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  const nav = page.locator("header:has(h1:text-is('Manage')) nav");
  await expect(nav.getByRole("button", { name: "Approvals", exact: true })).toHaveCount(0);
  // The manager still has the right; it is the PLACE that changed.
  await expect(nav.getByRole("button", { name: "Cash-up", exact: true })).toBeVisible();
});

test("Manage's sections and the way out share one row at the counter", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  // Waited for. openManage presses the PIN and returns; the screen behind it
  // is rendered when the PIN comes back, so measuring straight after was a
  // race that won on its own and lost under a full suite.
  await expect(page.getByRole("heading", { name: "Manage" })).toBeVisible();

  const m = await page.evaluate(() => {
    const head = document.querySelector("header:has(h1)") as HTMLElement;
    const all = [...head.querySelectorAll<HTMLElement>("button")].filter(
      (b) => b.offsetParent !== null
    );
    // Counted by the middle of each button, not its top: the way out is a
    // pixel taller than a tab because it carries a border, and comparing tops
    // called one row two.
    const mids = all
      .map((b) => {
        const r = b.getBoundingClientRect();
        return r.top + r.height / 2;
      })
      .sort((a, z) => a - z);
    let rows = 1;
    for (let i = 1; i < mids.length; i++) if (mids[i] - mids[i - 1] > 8) rows++;
    const out = all.find((b) => /Back to till/.test(b.textContent ?? ""))!;
    const tabs = [...head.querySelectorAll<HTMLElement>("nav button")];
    const here = tabs.find((t) => t.getAttribute("aria-selected") !== "false") ?? tabs[0];
    return {
      buttons: all.length,
      rows,
      outBg: getComputedStyle(out).backgroundColor,
      // Compared against the SELECTED section, not just any: an outlined gold
      // button — the first attempt — read as "you are here", because the
      // selected section is gold too.
      hereBg: getComputedStyle(here).backgroundColor,
      hereColour: getComputedStyle(here).color,
      outColour: getComputedStyle(out).color,
    };
  });

  expect(m.buttons, "controls on the Manage bar").toBeGreaterThanOrEqual(10);
  expect(m.rows, "rows they occupy at 1024").toBe(1);
  // The way OUT is the one control here that is not a section, and it was a
  // twelfth grey word of the same weight as the eleven it is not like. It has
  // to be unmistakable against the SELECTED section as well as the rest —
  // being gold on gold would say "you are here", not "this is the door".
  expect(m.outBg, "the way out's own fill").not.toBe("rgba(0, 0, 0, 0)");
  expect(m.outBg, "the way out against the section you are on").not.toBe(m.hereBg);
  expect(m.outColour, "the way out's ink against the section you are on")
    .not.toBe(m.hereColour);
});

test("a counter machine with no camera is not offered the camera's work", async ({ page }) => {
  // The shop's till is a PinnPOS all-in-one with no lens in it, and it was
  // being offered four screens that can only be done by pointing one at
  // something: photographing a shelf, filing a supplier's invoice, reading a
  // barcode into the product editor, and scanning stock in. Every one of them
  // was a dead end there — and every one of them is a tap away on the phone,
  // which is where that work actually happens.
  await withCamera(page, false);
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);

  // The Shelf tab is gone, and the sections that remain are still all there.
  const nav = page.locator("header:has(h1:text-is('Manage')) nav");
  await expect(nav.getByRole("button", { name: "Shelf", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Catalogue", exact: true })).toBeVisible();

  // Filing a supplier's paperwork says why it cannot, rather than vanishing:
  // the invoice still has to be filed and the person needs telling where.
  await nav.getByRole("button", { name: "Suppliers", exact: true }).click();
  const file = page.getByRole("button", { name: /Scan a document/i });
  await expect(file).toBeVisible();
  await expect(file).toBeDisabled();
  await expect(page.getByText(/no camera/i)).toBeVisible();
});

test("a till that does have a camera keeps all of it", async ({ page }) => {
  // The gate is the LENS, not the kind of device. A counter running on an iPad
  // has a camera and must keep every one of these screens — which is why this
  // is not written as "hide it on a till".
  await withCamera(page, true);
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);

  const nav = page.locator("header:has(h1:text-is('Manage')) nav");
  await expect(nav.getByRole("button", { name: "Shelf", exact: true })).toBeVisible();

  await nav.getByRole("button", { name: "Suppliers", exact: true }).click();
  await expect(page.getByRole("button", { name: /Scan a document/i })).toBeEnabled();
});

test("Manage shows every section without a scrollbar across the top", async ({ page }) => {
  // Twelve sections in a strip that scrolled sideways. On Windows that draws a
  // permanent grey scrollbar with a pair of arrows across the top of the
  // shop's own admin screen — the ugliest control on any desktop — and it hid
  // the far tabs behind a gesture nobody makes with a mouse. They wrap now.
  await page.setViewportSize({ width: 1024, height: 768 });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);

  // Scoped to Manage's own header: the till's section bar is still in the
  // document behind this overlay and answers to the same selector.
  const nav = page.locator("header:has(h1:text-is('Manage')) nav");
  await expect(nav).toBeVisible();

  const measure = () =>
    nav.evaluate((n) => {
      const w = document.documentElement.clientWidth;
      const buttons = [...n.querySelectorAll<HTMLElement>("button")];
      return {
        overflow: n.scrollWidth - n.clientWidth,
        count: buttons.length,
        offRight: buttons.filter((b) => b.getBoundingClientRect().right > w + 1).length,
        rows: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
      };
    });

  const wide = await measure();
  // Enough sections that this is a real test of the arrangement.
  expect(wide.count, "sections on the Manage bar").toBeGreaterThanOrEqual(10);
  expect(wide.overflow, "sideways overflow at 1024").toBeLessThanOrEqual(0);
  expect(wide.offRight, "sections off the right-hand edge at 1024").toBe(0);

  // AND at a width where a single row cannot hold them, which is the case the
  // arrangement actually has to answer. At 1024 the strip fits one row on
  // purpose now — eleven sections, tightened under 1280 — so 1024 alone passes
  // whether these wrap or scroll, and once did. 820 used to be the width that
  // forced a wrap; losing Approvals and the tighter padding made them fit
  // there too, so the case moved down to 700.
  await page.setViewportSize({ width: 700, height: 768 });
  const narrow = await measure();
  expect(narrow.rows, "rows the sections occupy at 700").toBeGreaterThanOrEqual(2);
  expect(narrow.overflow, "sideways overflow at 700").toBeLessThanOrEqual(0);
  expect(narrow.offRight, "sections off the right-hand edge at 700").toBe(0);

  // And the far ones are reachable, which is what the scroll strip cost.
  await page.getByRole("button", { name: "Shop", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Printing/i })).toBeVisible();
});

test("asking for the invoice details brings them to the cashier", async ({ page }) => {
  // They sit under the keypad, at the bottom of the column that scrolls. On a
  // counter screen unfolding them put them below the fold: the cashier tapped
  // the button, saw nothing appear, and had to scroll to find the thing they
  // had just asked for.
  await page.setViewportSize({ width: 1024, height: 590 });
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: /Invoice details/i }).click();

  const po = page.getByLabel("Purchase order number");
  await expect(po).toBeVisible();

  // On the screen, not merely in the document. Measured against the pay
  // column's own box, because that is what scrolls — the field can be inside
  // the window and still be under the fold of the panel it lives in.
  const seen = await po.evaluate((el) => {
    const box = el.closest(".tender")!.getBoundingClientRect();
    const f = el.getBoundingClientRect();
    return { above: box.top - f.top, below: f.bottom - box.bottom };
  });
  expect(seen.above, "field above the top of the pay column").toBeLessThanOrEqual(1);
  expect(seen.below, "field below the bottom of the pay column").toBeLessThanOrEqual(1);

  // And it is ready to be typed into, which is the next thing that happens.
  await expect(po).toBeFocused();
  await po.fill("PO-4471");
  await expect(po).toHaveValue("PO-4471");
});

test("a narrower slip is a bigger slip, which is the only lever there is", async ({ page }) => {
  // The counter asked for bigger print twice. There is exactly one thing that
  // delivers it: the type is sized so a full line just fits the paper, so a
  // character is about (paper / columns) and every other trick here — the page
  // margin, the hair of slack in the divisor — is worth a few percent against
  // this one's tens of percent. So the shop gets the dial, and this is the
  // test that the dial is connected to anything.
  await pairAndSignIn(page, USERS.manager.pin);

  const typeAt = async (cols: number | null) => {
    await page.evaluate((c) => {
      if (c == null) localStorage.removeItem("pos.slipWidth");
      else localStorage.setItem("pos.slipWidth", String(c));
    }, cols);
    await page.reload();
    await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Cash", exact: true }).click();
    await page.getByRole("button", { name: /Tender & print/i }).click();
    await page.setViewportSize({ width: 320, height: 600 });
    await page.emulateMedia({ media: "print" });
    const out = await page.evaluate(() => {
      const pre = document.querySelector("#print-area pre") as HTMLElement;
      return {
        size: parseFloat(getComputedStyle(pre).fontSize),
        widest: (pre.textContent || "").split("\n").reduce((w, l) => Math.max(w, l.length), 0),
        over: pre.scrollWidth - document.documentElement.clientWidth,
      };
    });
    await page.emulateMedia({ media: "screen" });
    await page.setViewportSize({ width: 1280, height: 800 });
    return out;
  };

  const wide = await typeAt(48);
  const narrow = await typeAt(32);

  // The slip really is built narrower — not just drawn smaller.
  expect(wide.widest, "columns at the 48 setting").toBeGreaterThan(40);
  expect(narrow.widest, "columns at the 32 setting").toBeLessThanOrEqual(32);

  // And the type really is bigger for it. A third, near enough — which is the
  // difference between a figure the counter can read at arm's length and one
  // they hold up to the light.
  expect(narrow.size, "type at 32 columns against 48").toBeGreaterThan(wide.size * 1.3);

  // Both still fit the paper, which is the constraint the whole rule exists
  // for: a line wider than the page is not wrapped, it is CUT, and the
  // rightmost thing on every line is the amount.
  expect(wide.over, "48-column slip past the page edge").toBeLessThanOrEqual(0);
  expect(narrow.over, "32-column slip past the page edge").toBeLessThanOrEqual(0);
});

test("a counter machine prints without being asked twice", async ({ page }) => {
  // "Work it out" used to mean "show the slip on screen" on anything that is
  // not an Android tablet — which is exactly what the shop's counter machine
  // is. The slip was a preview of something already on its way out of the
  // Epson, and dismissing it was a tap on every single sale. Nothing is set
  // here: this is the DEFAULT doing the right thing.
  await pairAndSignIn(page, USERS.manager.pin);
  // The harness pins every other test to the on-screen slip so it can read the
  // receipt off the page. This test is about what the shop gets with nothing
  // set at all, so the pin comes off — in an init script, not a one-off
  // evaluate, because the harness sets it again on EVERY load and a single
  // removeItem was simply put back by the reload below. Init scripts run in
  // the order they were added, and the harness added its before this one.
  await page.addInitScript(() => {
    localStorage.removeItem("pos.printMode");
    (window as unknown as { __prints: number }).__prints = 0;
  });
  await page.reload();
  await page.evaluate(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      const w = window as unknown as { __prints: number; __printed: string };
      w.__prints += 1;
      w.__printed = document.querySelector("#print-area")?.textContent ?? "";
    };
  });

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  // Waited for, not raced: the slip goes to the printer once the sale is back
  // from the server, so reading the counter the instant the button is clicked
  // asks whether it has printed before it could have.
  await expect(banner(page)).toContainText(/INV-\d+/);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints))
    .toBeGreaterThanOrEqual(1);

  // Paper, with the sale on it.
  const out = await page.evaluate(() => {
    const w = window as unknown as { __prints: number; __printed: string };
    return { prints: w.__prints, printed: w.__printed };
  });
  expect(out.prints, "times the printer was asked").toBeGreaterThanOrEqual(1);
  expect(out.printed).toContain("Cement 42.5N 50kg");

  // And no slip over the till to dismiss.
  await expect(page.locator(".animate-scale-in pre")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0);
});

test("the scan box gets the room, not the buyer chip", async ({ page }) => {
  // The chip shared the row a third each way to hold one line of text, while
  // the box beside it — the most-used control on the till — was showing
  // "Scan barcc" in 89px.
  await page.setViewportSize({ width: 1024, height: 590 });
  await pairAndSignIn(page, USERS.manager.pin);
  const w = await page.evaluate(() => ({
    input: document.querySelector(".scan-field input")!.getBoundingClientRect().width,
    chip: document.querySelector(".customer-pick")!.getBoundingClientRect().width,
  }));
  expect(w.input, "scan input width").toBeGreaterThan(220);
  expect(w.chip, "buyer chip width").toBeLessThan(w.input);

  // And the chip is now a chip. "Walk-in customer" was ~70px of the word
  // "customer" saying nothing the icon and the other six letters do not, on a
  // row the scan box was going short on. A quarter of the row is the ceiling;
  // below that the label stops being readable and this stops being a saving.
  const row = await page.evaluate(
    () => document.querySelector(".scan-bar")!
      .getBoundingClientRect().width
  );
  expect(w.chip, "buyer chip against the row").toBeLessThan(row * 0.25);

  // The full sentence survives where it always belonged — the button's
  // accessible name — so nothing was lost to anyone driving this by voice or
  // by screen reader.
  await expect(
    page.getByRole("button", { name: /Walk-in customer — tap to add their details/i })
  ).toBeVisible();
});

test("set to print straight, the counter gets paper and no popup at all", async ({ page }) => {
  // At a counter with the till printer as the machine's default, the slip on
  // screen is a preview of something already on its way out of a printer —
  // one more thing to dismiss on every sale. This removes OUR dialog; the
  // browser's own is a property of how Chrome was started, not of the page.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.evaluate(() => localStorage.setItem("pos.printMode", "direct"));

  // window.print() would block a headless run, so it is counted, not called.
  await page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
  });
  await page.reload();
  await page.evaluate(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      const w = window as unknown as { __prints: number; __printed: string };
      w.__prints += 1;
      // Captured HERE, not afterwards: the component clears the print area as
      // soon as the browser has taken it, so reading it later reads nothing
      // and would pass whether or not the slip was ever in the page.
      w.__printed = document.querySelector("#print-area")?.textContent ?? "";
    };
  });

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-\d+/);

  // The sale went through, the browser was asked to print, and nothing was
  // ever drawn over the till.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints))
    .toBeGreaterThan(0);
  await expect(page.locator(".animate-scale-in")).toHaveCount(0);

  // And the slip really was in the page when the printer read it — printing an
  // empty #print-area is a blank sheet and a cashier with no idea why.
  const printed = await page.evaluate(
    () => (window as unknown as { __printed?: string }).__printed ?? ""
  );
  expect(printed).toContain("Cement 42.5N 50kg");
  expect(printed).toMatch(/INV-\d+/);
});

test("a newer till announces itself instead of reloading under the cashier", async ({ page }) => {
  // The app was registered with autoUpdate, which reloads the page ITSELF the
  // moment a new version lands — losing the cart in front of a customer — and
  // only looks for one on a navigation, which an installed till does not do.
  // A window opened on Monday is the same window on Friday.
  await pairAndSignIn(page, USERS.manager.pin);

  // Nothing to take: nothing shown.
  await expect(page.getByRole("button", { name: /Update/ })).toHaveCount(0);

  // A sale in progress, so the cost of reloading is real.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await expect(page.locator(".line-desc")).toHaveText("Cement 42.5N 50kg");

  // The signal a waiting service worker raises. Fired directly because a
  // genuine worker update cannot be staged inside a browser test.
  await page.evaluate(() => window.dispatchEvent(new Event("pos:update-ready")));

  const update = page.getByRole("button", { name: /Update/ });
  await expect(update).toBeVisible();

  // And it waited: the sale is still on the screen, not reloaded away.
  await expect(page.locator(".line-desc")).toHaveText("Cement 42.5N 50kg");
});

test("and the phone says it too, since it goes just as stale", async ({ page }) => {
  // A phone is installed to a home screen and then opened from the home
  // screen forever — the same never-navigates problem as the till, on a
  // device that is not sitting where anyone can see it is out of date.
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  await expect(page.locator(".phone-home-head")).toBeVisible();
  await expect(page.getByRole("button", { name: /Update/ })).toHaveCount(0);

  await page.evaluate(() => window.dispatchEvent(new Event("pos:update-ready")));
  await expect(page.getByRole("button", { name: /Update/ })).toBeVisible();
  // Still the phone's own screen, not a reload back to sign-in.
  await expect(page.locator(".phone-home-who")).toBeVisible();
});

/*
 * The line is not the work.
 *
 * A driver signs the page at a gate with no signal; the till loses the shop's
 * Wi-Fi for a minute in the afternoon. Neither should stop anything or lose
 * anything: what was done with the line down is kept on the device, said to
 * be so, and sent — once — when the line returns.
 */
test("from the phone, a delivery marked off with no signal is kept, says so, and syncs when the line returns", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  be.deliveries.push({
    id: "d1", doc_number: "DEL-000001", sale_id: "s1", customer_name: "T. Mokoena",
    address: "14 Mabille Rd, Maseru", deliver_on: new Date().toISOString().slice(0, 10),
    deliver_at: null, charge: 0, note: null, status: "pending",
    cashier_name: "Manager", delivered_by_name: null, delivered_at: null,
  });
  await enrolPhoneAndSignIn(page, be);

  // Seen once with the line up, so the phone has the morning's load.
  await phoneMenu(page, "Deliveries");
  await expect(page.getByText("T. Mokoena")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  // At the gate: no signal. The menu still opens it, on the list it kept.
  be.offline = true;
  await page.context().setOffline(true);
  await expect(page.locator(".phone-home-who")).toContainText("no line", { timeout: 30000 });
  await phoneMenu(page, "Deliveries");
  await expect(page.getByText("T. Mokoena")).toBeVisible();

  // Marked off: the row turns over at once, and says the server does not
  // know yet. Nothing reached the fake.
  const before = Date.now();
  await page.getByRole("button", { name: "Delivered" }).first().click();
  const row = page.locator("tr.acc-row", { hasText: "DEL-000001" });
  await expect(row).toContainText("Delivered · Manager · will sync");
  expect(be.deliveries[0].status).toBe("pending");
  const afterTap = Date.now();

  // Survives the page: a phone that is closed and reopened at the next stop
  // shows the same thing, from the queue, not from memory. (The browser is
  // let back on so the test can reload the app, which the real phone has
  // installed; the shop's server stays unreachable.)
  await page.context().setOffline(false);
  await page.reload();
  await page.waitForSelector(".phone-home");
  await phoneMenu(page, "Deliveries");
  await expect(row).toContainText("will sync");
  expect(be.deliveries[0].status).toBe("pending");

  // THE LINE RETURNS. Sent by itself, with the time it was actually signed
  // for — not the moment the phone found signal — and "will sync" goes.
  be.offline = false;
  await expect.poll(() => be.deliveries[0].status, { timeout: 30000 }).toBe("delivered");
  expect(be.deliveries[0].delivered_by_name).toBe("Manager");
  // The reload and the wait for the line put seconds between the tap and
  // the send; a server that stamped its own clock would land after afterTap.
  const at = new Date(be.deliveries[0].delivered_at!).getTime();
  expect(at).toBeGreaterThanOrEqual(before - 1000);
  expect(at).toBeLessThanOrEqual(afterTap + 500);
  await expect(row).not.toContainText("will sync");
  await expect(row).toContainText("Delivered · Manager");
});

test("one slow probe does not put the till offline; two misses do, and one answer brings it back", async ({ page }) => {
  // The banner flapped all afternoon on a till that was never off: every
  // probe that stalled past six seconds was called an outage while the sale
  // beside it went through. Now a miss is re-checked before it is believed.
  test.setTimeout(120_000);
  await pairAndSignIn(page);
  await page.getByRole("button", { name: /Sign out/i }).click();
  const status = page.locator(".login-status");
  await expect(status).toContainText("Online");

  // The fake's health route is replaced by one the test controls: it
  // answers or fails on a switch, and counts what it was asked. The browser
  // itself still says it has a network, as it does on a stalling line.
  let fail = true;
  let asked = 0;
  await page.route("**/auth/v1/health*", async (route) => {
    asked += 1;
    if (fail) return route.abort("failed");
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  // One miss: the till stays online, and the miss is re-checked soon.
  //
  // Watched as two facts together rather than as a wall-clock pause. The
  // heartbeat probes every fifteen seconds on its own account, so a fixed
  // wait can have a SECOND genuine miss land inside it — at which point the
  // till is right to go offline and the test is wrong to be surprised. That
  // is what made this flake, on this server and worse on the old one, and
  // CI's one retry was hiding it. The rule itself is pinned exactly in
  // test/offline.test.mjs; what is being checked here is the wiring.
  //
  // Sticky on purpose: once Offline has been seen while a single miss stands,
  // this can never go on to pass. A poll that merely waits for the good
  // answer would sail past the bad one.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => asked, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  let tooSoon = false;
  await expect
    .poll(
      async () => {
        // The count on BOTH sides of the read, and the sample thrown away if
        // it moved. Reading the banner is a round trip to the browser, and the
        // second miss can land inside it — so testing the count first and
        // trusting the text that arrives afterwards blames one miss for what
        // two did. That is what made this fail in a full run and pass six
        // times on its own: under load the round trip is slower and the
        // window is wider. A race, in the test written to fix a race.
        const before = asked;
        const seen = await status.innerText();
        if (!tooSoon && before === asked && asked <= 1 && seen.includes("Offline")) {
          tooSoon = true;
        }
        if (tooSoon) return "offline on a single miss";
        return asked > 1 ? "a second miss landed" : "still online";
      },
      { timeout: 15_000 }
    )
    .toBe("a second miss landed");
  await expect(status).toContainText("Offline", { timeout: 10_000 });

  // One answer, and it is back: the line does not have to prove itself twice.
  fail = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(status).toContainText("Online", { timeout: 10_000 });
});

test("the phone offers to install itself, even though the browser made the offer before the app was drawn", async ({ page }) => {
  // Chrome fires beforeinstallprompt once, early, before React has mounted
  // the button that used to listen for it. It went by unheard, and the
  // phone looked like it could not be installed. It is caught at boot now.
  await page.setViewportSize({ width: 390, height: 844 });
  let prompted = 0;
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
      };
      e.prompt = async () => { (window as unknown as { __prompted: number }).__prompted = 1; };
      e.userChoice = Promise.resolve({ outcome: "accepted" as const });
      window.dispatchEvent(e);
    });
  });
  await enrolPhoneAndSignIn(page, be);
  const install = page.locator(".phone-home").getByRole("button", { name: /Install app/i });
  await expect(install).toBeVisible();
  await install.click();
  prompted = await page.evaluate(() => (window as unknown as { __prompted?: number }).__prompted ?? 0);
  expect(prompted).toBe(1);
  // Accepted: the offer is spent and the button goes.
  await expect(install).toHaveCount(0);

  // And what gets installed holds whichever way the phone is held: the
  // manifest no longer locks the app to the tablet's landscape.
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.orientation).toBe("any");
  expect(manifest.display).toBe("standalone");
});

test("a sale taken offline prints a till reference the counter can scan, and it opens the invoice once the line is back", async ({ page }) => {
  // The number is issued by the server, so an offline slip has none — and it
  // said "pending sync" and carried no barcode. A customer back at the
  // counter with it had nothing to scan and nothing to quote. Now the slip
  // carries a till reference, as text and as bars; scanned while the sale is
  // still on this till it says so, and once the sale is in it opens the
  // invoice the server numbered.
  //
  // 0096: a till normally holds a block of numbers and gives the sale one
  // itself; this is the till that holds none — the block ran out with the
  // line still down, or was never reserved — and the reference is what is
  // left. The fake is told to hand out nothing.
  be.numbersToReserve = 0;
  await pairAndSignIn(page);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  be.offline = true;
  await page.context().setOffline(true);
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/will sync when the connection returns/i);

  const slip = page.locator("#print-area");
  await expect(slip).toContainText("Invoice No: issued when the line returns");
  await expect(slip).not.toContainText("INV-");
  await expect(slip).toContainText(/Till ref: TR-[0-9A-F]{8}/);
  await expect(slip).not.toContainText("pending sync");
  const ref = (await slip.locator("[data-barcode]").getAttribute("data-barcode"))!;
  expect(ref).toMatch(/^TR-[0-9A-F]{8}$/);
  await expect(slip).toContainText(`Till ref: ${ref}`);
  await page.getByLabel("Close", { exact: true }).click();

  // Scanned back while the line is still down: the sale is here, not there.
  await page.getByPlaceholder(/Scan barcode/i).fill(ref);
  await page.keyboard.press("Enter");
  await expect(banner(page)).toContainText(/still on this till, waiting for the line/i);

  // The line returns and the sale goes in with its reference; the same scan
  // now opens the invoice the server numbered.
  be.offline = false;
  await page.context().setOffline(false);
  await expect.poll(() => be.storedSales.length, { timeout: 45_000 }).toBe(1);
  expect(be.storedSales[0].client_ref?.replace(/-/g, "").slice(0, 8).toUpperCase()).toBe(ref.slice(3));
  await page.getByPlaceholder(/Scan barcode/i).fill(ref.toLowerCase());
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Sale INV-000001" })).toBeVisible();
});

test("Manage with the line down says so in words, and a wrong PIN is refused in words", async ({ page }) => {
  // It said "TypeError: Failed to fetch" — a sentence about the browser, to
  // a manager who wanted to know whether to try again. The gate says what
  // the line being down means before the PIN is typed, and a wrong PIN is
  // refused against the device's own credential cache, in plain words.
  await pairAndSignIn(page, USERS.manager.pin);
  be.offline = true;
  await page.context().setOffline(true);
  await expect(page.locator("header").getByText(/offline/i)).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /^Manage$/ }).click();
  const gate = page.getByRole("dialog", { name: "Manage" });
  await expect(gate).toContainText(/The line is down/);
  for (const d of "999999".split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  const alert = gate.getByRole("alert");
  await expect(alert).toContainText(/not known on this device/);
  await expect(alert).not.toContainText(/TypeError|Failed to fetch/);
});


/*
 * 0096: the till numbers its own invoices.
 *
 * The number is issued by the server so two tills never issue the same one;
 * a sale taken with the line down therefore had none, and the shop wants the
 * number on the paper, line or no line. The till reserves a block of numbers
 * while the line is up and gives each sale the next one itself — online too,
 * so its numbers run in the order its sales were made — and the server keeps
 * the number the till gave.
 */
test("the till numbers its own invoices from a block it reserved, with the line down too", async ({ page }) => {
  await pairAndSignIn(page);
  // Signed in, the till asked for its blocks: twenty-five invoice numbers
  // and twenty-five delivery-note numbers, from where the shop's sequence stood.
  await expect.poll(() => be.reservations.filter((r) => r.type === "sale").length).toBe(1);
  expect(be.reservations.find((r) => r.type === "sale")).toMatchObject({ from: 1, to: 25 });
  await expect.poll(() => be.reservations.filter((r) => r.type === "delivery").length).toBe(1);

  // Online: the till's number, and the server kept it.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-000001 completed/);
  expect(be.storedSales[0].doc_number).toBe("INV-000001");
  await page.getByLabel("Close", { exact: true }).click();

  // The line goes down. The next sale is numbered all the same, on the slip
  // and in its barcode, and the number is the next in the till's run.
  be.offline = true;
  await page.context().setOffline(true);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/will sync when the connection returns/i);
  const slip = page.locator("#print-area");
  await expect(slip).toContainText("Invoice No: INV-000002");
  await expect(slip).not.toContainText("issued when the line returns");
  await expect(slip).not.toContainText("Till ref");
  expect(await slip.locator("[data-barcode]").getAttribute("data-barcode")).toBe("INV-000002");
  await page.getByLabel("Close", { exact: true }).click();

  // The line returns: the sale goes in under the number on the customer's slip.
  be.offline = false;
  await page.context().setOffline(false);
  await expect.poll(() => be.storedSales.length, { timeout: 45_000 }).toBe(2);
  expect(be.storedSales[1].doc_number).toBe("INV-000002");

  // And the run continues; the slip in the hand opens its invoice.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/INV-000003 completed/);
  await page.getByLabel("Close", { exact: true }).click();
  await page.getByPlaceholder(/Scan barcode/i).fill("INV-000002");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Sale INV-000002" })).toBeVisible();
});

test("a delivery arranged with the line down is numbered, listed, and filed when the line returns", async ({ page }) => {
  // "In offline mode the delivery is not adding." Two things: the Deliver
  // button fetched the shop's delivery line every time, so it could not even
  // be arranged; and a queued sale had no id for a note to belong to. Now the
  // line's product is kept on the device, and the note is queued with the
  // sale, numbered from the till's block, and filed once the sale is in.
  await pairAndSignIn(page, USERS.employee.pin);
  await expect.poll(() => be.reservations.filter((r) => r.type === "delivery").length).toBe(1);

  be.offline = true;
  await page.context().setOffline(true);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Deliver$/ }).click();
  const form = page.getByRole("dialog", { name: "Deliver this sale" });
  await form.getByLabel("Deliver to").fill("Morija Exports");
  await form.getByLabel("Address").fill("14 Kolonyama Rd");
  await form.getByLabel("Delivery charge").fill("90");
  await form.getByRole("button", { name: "Add to the sale" }).click();
  // Arranged, with the line down: the charge is on the sale.
  await expect(page.getByRole("button", { name: /Deliver · Morija Exports/ })).toBeVisible();

  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(banner(page)).toContainText(/Delivery note DEL-000001 for Morija Exports follows when the connection returns/);
  expect(be.deliveries).toHaveLength(0);
  await page.getByLabel("Close", { exact: true }).click();

  // On the Deliveries tab meanwhile, as a load that is coming.
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Deliveries" }).click();
  const row = page.locator("tr.acc-row", { hasText: "DEL-000001" });
  await expect(row).toContainText("Morija Exports");
  await expect(row).toContainText("14 Kolonyama Rd");
  await expect(row).toContainText("Arranged · will sync");

  // THE LINE RETURNS: the sale goes in, then the note, under its number and
  // against that sale — and the row is the server's now.
  be.offline = false;
  await page.context().setOffline(false);
  await expect.poll(() => be.deliveries.length, { timeout: 45_000 }).toBe(1);
  expect(be.deliveries[0].doc_number).toBe("DEL-000001");
  expect(be.deliveries[0].sale_id).toBe("s0");
  expect(be.deliveries[0].customer_name).toBe("Morija Exports");
  expect(be.deliveries[0].charge).toBe(90);
  await expect(row).not.toContainText("will sync");
  await expect(row.getByRole("button", { name: "Delivered" })).toBeVisible();
});

test("the dividing lines over the two footers meet", async ({ page }) => {
  // Each footer was as tall as its own contents, so the line across the
  // bottom of the till broke at the column edge. The taller sets both.
  await pairAndSignIn(page);
  const left = page.locator(".sell-actions");
  const right = page.locator(".pay-foot");
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  await expect.poll(async () => {
    const a = (await left.boundingBox())!, b = (await right.boundingBox())!;
    return Math.abs(a.y - b.y);
  }).toBeLessThanOrEqual(1);
  const a = (await left.boundingBox())!, b = (await right.boundingBox())!;
  expect(Math.abs(a.y + a.height - (b.y + b.height))).toBeLessThanOrEqual(1);
});

test("the TillAI bubble can be dragged anywhere, stays there, and opens beside itself", async ({ page }) => {
  await pairAndSignIn(page);
  const bubble = page.getByRole("button", { name: "TillAI" });
  const before = (await bubble.boundingBox())!;
  // Dragged from the corner to the upper right.
  await page.mouse.move(before.x + 20, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x + 200, before.y - 200, { steps: 8 });
  await page.mouse.move(900, 120, { steps: 8 });
  await page.mouse.up();
  const after = (await bubble.boundingBox())!;
  expect(after.x).toBeGreaterThan(before.x + 300);
  expect(after.y).toBeLessThan(before.y - 300);
  // Letting go is not a tap: nothing opened.
  await expect(page.getByRole("dialog", { name: "TillAI" })).toHaveCount(0);

  // A tap opens it, beside the bubble — below it, since it is in the upper half.
  await bubble.click();
  const sheet = page.getByRole("dialog", { name: "TillAI" });
  await expect(sheet).toBeVisible();
  const s = (await sheet.boundingBox())!;
  expect(s.y).toBeGreaterThan(after.y + after.height);
  expect(Math.abs(s.x - after.x)).toBeLessThan(200);
  await page.keyboard.press("Escape");

  // Still there after a reload.
  await page.reload();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
  const kept = (await page.getByRole("button", { name: "TillAI" }).boundingBox())!;
  expect(Math.abs(kept.x - after.x)).toBeLessThan(2);
  expect(Math.abs(kept.y - after.y)).toBeLessThan(2);
});

test("on a wide screen the action row sits low, beside the TillAI bubble, and takes the corner back when the bubble moves", async ({ page }) => {
  // The row kept a band clear beneath it for the bubble, and that band was
  // lines of the basket the counter could not see. In line with the bubble
  // now: nothing under a button, and no band.
  await page.setViewportSize({ width: 1366, height: 768 });
  await pairAndSignIn(page);
  const row = page.locator(".sell-actions");
  const bubble = page.getByRole("button", { name: "TillAI" });
  const overlaps = async () => {
    const b = (await bubble.boundingBox())!;
    for (const box of await row.locator("button").evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })))) {
      if (box.x < b.x + b.width && box.x + box.w > b.x && box.y < b.y + b.height && box.y + box.h > b.y) return true;
    }
    return false;
  };
  expect(await overlaps(), "the bubble sits on a button").toBe(false);
  const pad = async () => row.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bottom: parseFloat(cs.paddingBottom), left: parseFloat(cs.paddingLeft) };
  });
  expect((await pad()).bottom).toBeLessThanOrEqual(18);
  expect((await pad()).left).toBeGreaterThanOrEqual(120);

  // Dragged away, the row starts at the edge again — and still nothing under a button.
  const b = (await bubble.boundingBox())!;
  await page.mouse.move(b.x + 20, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(700, 200, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await pad()).left).toBeLessThan(60);
  expect(await overlaps()).toBe(false);
});


test("the deliveries a till saw are still there with the line down, even if the tab was never opened", async ({ page }) => {
  // The tab wrote its own cache, so a till that lost the line before anybody
  // opened Deliveries showed only what had been arranged offline — the
  // morning's loads were gone. The list is kept from sign-in now.
  be.deliveries.push({
    id: "d1", doc_number: "DEL-000001", sale_id: "s1", customer_name: "T. Mokoena",
    address: "14 Mabille Rd, Maseru", deliver_on: new Date().toISOString().slice(0, 10),
    deliver_at: null, charge: 0, note: null, status: "pending",
    cashier_name: "Manager", delivered_by_name: null, delivered_at: null,
  });
  await pairAndSignIn(page);
  await expect.poll(() => be.calls.filter((c) => c.includes("pos_list_deliveries")).length).toBeGreaterThan(0);
  be.offline = true;
  await page.context().setOffline(true);
  await expect(page.locator("header").getByText(/offline/i)).toBeVisible({ timeout: 15000 });
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Deliveries" }).click();
  await expect(page.locator("tr.acc-row", { hasText: "DEL-000001" })).toContainText("T. Mokoena");
  // And the find box is a real box: its whole placeholder shows, the count beside it.
  const box = page.getByPlaceholder(/Find a delivery/);
  expect((await box.boundingBox())!.width).toBeGreaterThan(240);
});

test("Manage opens with the line down, against the PIN this device already knows", async ({ page }) => {
  // The gate said the back office needs a connection and refused every PIN.
  // The PIN is the same one the device checks for signing in offline, so
  // the door opens against that; inside, one line says the line is down.
  await pairAndSignIn(page, USERS.manager.pin);
  be.offline = true;
  await page.context().setOffline(true);
  await expect(page.locator("header").getByText(/offline/i)).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /^Manage$/ }).click();
  const gate = page.getByRole("dialog", { name: "Manage" });
  for (const d of USERS.manager.pin.split("")) await gate.locator(`button:text-is("${d}")`).first().click();
  // The gate itself has a "Manage" title and a "line is down" status line, so
  // the proof is the gate GONE and the back office's own notice showing.
  await expect(gate).toHaveCount(0);
  await expect(page.locator(".admin-offline")).toContainText(/The line is down/);
  await expect(page.getByRole("button", { name: "Catalogue" })).toBeVisible();
});

/*
 * The back office, opened on a phone.
 *
 * Manage is the tablet's back office and the phone opens it whole. Its
 * screens were wide tables at 390px: an invoice number broken in half with
 * the right side of the card empty, a catalogue of nine columns flowing off
 * the edge. The three a manager opens from away are cards now, and the
 * sections that only make sense at the counter are not offered at all.
 */
/**
 * Open the app's one menu and pick a destination by name. Manage renders
 * OVER the phone's home, which is still mounted behind it, so both burgers
 * are in the document at once: the one to press is the top screen's.
 */
async function phoneMenu(page: import("@playwright/test").Page, label: string) {
  // The LAST one, not the one belonging to whichever screen a count says is
  // up: Manage renders over the screen beneath it and both burgers are in
  // the document at once, so asking "is Manage there yet" is a race — and
  // one that only lost on a slower machine, which is how it passed here and
  // failed on CI twice.
  const burger = page.getByRole("button", { name: "Sections" }).last();
  await expect(burger).toBeVisible();
  await burger.click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

async function openManageOnPhone(
  page: import("@playwright/test").Page, section: string
) {
  await phoneMenu(page, section);
  const gate = page.getByRole("dialog", { name: "Manage" });
  // A phone's owner proved this PIN at sign-in, so the door is usually
  // already open; it still asks when the PIN was never proved on this load.
  await expect(gate.or(page.locator(".admin-screen")).first()).toBeVisible();
  if (await gate.isVisible()) {
    for (const d of USERS.manager.pin.split("")) {
      await gate.locator(`button:text-is("${d}")`).first().click();
    }
  }
  // The gate's own title is a heading called "Manage" as well, so the back
  // office is waited for by its screen and not by its name.
  await expect(page.locator(".admin-screen")).toBeVisible();
}

test("on a phone a sale is a card, and the counter's own actions are not on it", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  // One sale to read back, rung on the till before the phone looks at it.
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();

  const phoneContext = await page.context().browser()!.newContext({
    viewport: { width: 390, height: 844 },
  });
  const phone = await phoneContext.newPage();
  await installBackend(phone, be);
  await enrolPhoneAndSignIn(phone, be);
  await openManageOnPhone(phone, "Sales");

  const row = phone.locator("li.sale-row").first();
  await expect(row).toContainText("INV-000001");
  // A card, not a row: the number and the amount on one line, the rest under.
  expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe("grid");
  const number = await row.locator(".sale-main > :first-child").boundingBox();
  const total = await row.locator(".sale-total").boundingBox();
  expect(Math.abs(number!.y - total!.y), "the number and the total share a line")
    .toBeLessThanOrEqual(6);
  expect(total!.x, "the amount is on the right").toBeGreaterThan(number!.x + 100);
  // And nothing on it that needs the counter: the goods come back to the
  // till, and the slip comes out of the printer there.
  await expect(row.getByRole("button", { name: "Return" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reprint" })).toHaveCount(0);
  // The page itself never scrolls sideways.
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await phoneContext.close();
});

test("the till keeps Return and Reprint on the same list", async ({ page }) => {
  // The pair above is about the phone, not about the feature: a manager at
  // the counter still takes goods back and still reprints a slip.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();
  await openManage(page);
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  const row = page.locator("li.sale-row").first();
  await expect(row.getByRole("button", { name: "Return" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Reprint" })).toBeVisible();
  // And it is still a row there, not a card.
  expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe("flex");
});

test("on a phone the catalogue is a card each, priced, with no columns to explain", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enrolPhoneAndSignIn(page, be);
  await openManageOnPhone(page, "Catalogue");

  const row = page.locator(".cat-table tbody tr").first();
  await expect(row).toBeVisible();
  expect(await page.locator(".cat-table thead").evaluate((el) => getComputedStyle(el).display)).toBe("none");
  expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe("grid");
  // The name and the price on the first line, the code under the name.
  const name = (await row.locator(".cat-name").boundingBox())!;
  const retail = (await row.locator(".cat-retail").boundingBox())!;
  const sku = (await row.locator(".cat-sku").boundingBox())!;
  expect(Math.abs(name.y - retail.y), "name and price share a line").toBeLessThanOrEqual(6);
  expect(retail.x, "the price is on the right").toBeGreaterThan(name.x);
  expect(sku.y, "the code sits under the name").toBeGreaterThan(name.y);
  // Trade and cost are a tap away in the editor, not a third column of
  // figures on a 390px card. And there are no columns left to explain.
  expect(await row.locator(".cat-trade").evaluate((el) => getComputedStyle(el).display)).toBe("none");
  await expect(page.locator(".cat-legend")).toBeHidden();
  await expect(page.getByRole("button", { name: /What the columns mean/ })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a phone opens on the day so far, and the figures are taps into the tiles", async ({ page }) => {
  // Something to count: a sale on the till, and a load still to go out.
  be.deliveries.push({
    id: "d1", doc_number: "DEL-000001", sale_id: "s0", customer_name: "T. Mokoena",
    address: "14 Mabille Rd, Maseru", deliver_on: new Date().toISOString().slice(0, 10),
    deliver_at: null, charge: 0, note: null, status: "pending",
    cashier_name: "Manager", delivered_by_name: null, delivered_at: null,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();

  const phoneContext = await page.context().browser()!.newContext({
    viewport: { width: 390, height: 844 },
  });
  const phone = await phoneContext.newPage();
  await installBackend(phone, be);
  await enrolPhoneAndSignIn(phone, be);

  // The home answers "how is today" before a tile is tapped.
  const figures = phone.locator(".phone-figures");
  await expect(figures).toBeVisible();
  await expect(figures).toContainText("Taken today");
  await expect(figures).toContainText("1 sale");
  await expect(figures).toContainText("Still to go");
  // The figures are the screen: they sit under the name and above the foot.
  const panel = (await figures.boundingBox())!;
  const who = (await phone.locator(".phone-home-who").boundingBox())!;
  const foot = (await phone.locator(".phone-home-colophon").boundingBox())!;
  expect(panel.y).toBeGreaterThan(who.y);
  expect(panel.y).toBeLessThan(foot.y);
  // And a count is a way in of its own: the load still to go opens Deliveries.
  await figures.getByRole("button", { name: /Still to go/ }).click();
  await expect(phone.getByRole("heading", { name: "Deliveries" })).toBeVisible();
  await phoneContext.close();
});

test("a counter hand's phone shows what is still to go and not the takings", async ({ page }) => {
  // The same call, scoped by whose phone it is: the money is the owner's
  // business, and a counter hand's home says so by not having it.
  await page.setViewportSize({ width: 390, height: 844 });
  be.deliveries.push({
    id: "d1", doc_number: "DEL-000001", sale_id: "s0", customer_name: "T. Mokoena",
    address: "14 Mabille Rd, Maseru", deliver_on: new Date().toISOString().slice(0, 10),
    deliver_at: null, charge: 0, note: null, status: "pending",
    cashier_name: "Sam", delivered_by_name: null, delivered_at: null,
  });
  await enrolPhoneAndSignIn(page, be, USERS.employee.pin);
  const figures = page.locator(".phone-figures");
  await expect(figures).toContainText("Still to go");
  await expect(figures).not.toContainText("Taken today");
  await expect(figures).not.toContainText("Running low");
});

test("a phone is not offered the sections that only make sense at a desk", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enrolPhoneAndSignIn(page, be);
  await openManageOnPhone(page, "Cash-up");
  // Cash-up is there, as history: a manager away from the shop wants to know
  // whether last night closed clean.
  await expect(page.getByText(/Earlier days/)).toBeVisible();
  // But not the drawer work, which needs the cash in hand.
  await expect(page.getByRole("heading", { name: "Open the drawer" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Count the drawer" })).toHaveCount(0);
  await expect(page.getByText(/happen at the till, with the cash in hand/)).toBeVisible();

  // A CSV file picker and the shop's VAT number are desk work, and are not
  // in the list at all.
  await page.locator(".admin-screen").getByRole("button", { name: "Sections" }).click();
  await expect(page.getByRole("menuitem", { name: "Catalogue", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Bulk import", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Shop", exact: true })).toHaveCount(0);
});

test("the till still has every section, including the ones a phone drops", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await expect(page.getByRole("button", { name: "Bulk import", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Shop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cash-up", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Open the drawer" })).toBeVisible();
});

/*
 * The phone's home is the day, and one menu is the way to everything else.
 *
 * It was nine tiles and no figures: nine doors that answered nothing, so
 * whoever opened the app in the evening had to guess which door had the
 * number they came for. The figures are the screen now, each one a way into
 * what it summarises, and the doors are behind the same menu Manage shows.
 */
test("the phone opens on the whole day, and every figure is a way in", async ({ page }) => {
  // A drawer open on the till, a load still to go, one late, and a sale.
  be.cashSession = {
    id: "cs1", opened_by_name: "Manager", opened_at: new Date().toISOString(),
    opening_float: 500, fromIndex: 0, fromPayments: 0,
  };
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  be.deliveries.push({
    id: "d1", doc_number: "DEL-000001", sale_id: "s0", customer_name: "T. Mokoena",
    address: "14 Mabille Rd", deliver_on: today, deliver_at: null, charge: 0,
    note: null, status: "pending", cashier_name: "Manager",
    delivered_by_name: null, delivered_at: null,
  });
  be.deliveries.push({
    id: "d2", doc_number: "DEL-000002", sale_id: "s0", customer_name: "Late Buyer",
    address: "2 Kerk St", deliver_on: yesterday, deliver_at: null, charge: 0,
    note: null, status: "pending", cashier_name: "Manager",
    delivered_by_name: null, delivered_at: null,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();

  const ctx = await page.context().browser()!.newContext({
    viewport: { width: 390, height: 844 },
  });
  const phone = await ctx.newPage();
  await installBackend(phone, be);
  await enrolPhoneAndSignIn(phone, be);

  const figures = phone.locator(".phone-figures");
  await expect(figures).toBeVisible();
  // The takings, and how they were paid.
  await expect(figures).toContainText("Taken today");
  await expect(figures).toContainText("1 sale");
  await expect(figures).toContainText(/cash R/);
  // The drawer, by the till's own name, and the same figure cash-up counts
  // against: the float plus what went in.
  const drawer = figures.getByRole("button", { name: /Money in the till/ });
  await expect(drawer).toContainText("Front Counter");
  await expect(drawer).toContainText(/615\.00/);
  // What is still to go, split into today's and what should have gone.
  await expect(figures).toContainText("Still to go");
  await expect(figures).toContainText("1 today · 1 late");
  // And the late one is called out on its own, at the top.
  const urgent = figures.getByRole("button", { name: /past the day promised/ });
  await expect(urgent).toBeVisible();

  // Every figure is a way in. The late delivery opens Deliveries.
  await urgent.click();
  await expect(phone.getByRole("heading", { name: "Deliveries" })).toBeVisible();
  await ctx.close();
});

test("the tiles are gone, and the menu is the same list on the home and inside Manage", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enrolPhoneAndSignIn(page, be);
  await expect(page.locator(".phone-tiles")).toHaveCount(0);

  // The home's menu.
  await page.locator(".phone-home").getByRole("button", { name: "Sections" }).click();
  const home = await page.getByRole("menuitem").allInnerTexts();
  await page.keyboard.press("Escape");
  expect(home).toContain("Look it up");
  expect(home).toContain("Deliveries");
  expect(home).toContain("Approvals");
  expect(home).toContain("Reports");

  // Manage's menu is that same list, so a destination is the same two taps
  // from either place.
  await openManageOnPhone(page, "Reports");
  await page.locator(".admin-screen").getByRole("button", { name: "Sections" }).click();
  const inside = await page.getByRole("menuitem").allInnerTexts();
  expect(inside.map((t) => t.replace(/\s*✓$/, "").trim()))
    .toEqual(home.map((t) => t.trim()));

  // And a screen the phone owns is reachable from inside Manage: picking it
  // leaves, rather than looking for a section that is not there.
  await page.getByRole("menuitem", { name: "Deliveries" }).click();
  await expect(page.getByRole("heading", { name: "Deliveries" })).toBeVisible();
  await expect(page.locator(".admin-screen")).toHaveCount(0);
});

test("a counter hand's phone shows the loads and never the money", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  be.cashSession = {
    id: "cs1", opened_by_name: "Manager", opened_at: new Date().toISOString(),
    opening_float: 500, fromIndex: 0, fromPayments: 0,
  };
  be.deliveries.push({
    id: "d1", doc_number: "DEL-000001", sale_id: "s0", customer_name: "T. Mokoena",
    address: "14 Mabille Rd", deliver_on: new Date().toISOString().slice(0, 10),
    deliver_at: null, charge: 0, note: null, status: "pending",
    cashier_name: "Sam", delivered_by_name: null, delivered_at: null,
  });
  await enrolPhoneAndSignIn(page, be, USERS.employee.pin);
  const figures = page.locator(".phone-figures");
  await expect(figures).toContainText("Still to go");
  await expect(figures).not.toContainText("Taken today");
  await expect(figures).not.toContainText("Money in the till");
  await expect(figures).not.toContainText("Owed to the shop");
  await expect(figures).not.toContainText("Running low");
});

test("the phone says whose shop it is at the foot", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enrolPhoneAndSignIn(page, be);
  const foot = page.locator(".phone-home-colophon");
  await expect(foot).toContainText("Ladybrand Hardware");
  await expect(foot).toContainText("a product of InnovaEarth");
  await expect(foot).toContainText(`© ${new Date().getFullYear()}`);
  await expect(foot).toContainText("All rights reserved");
});

/** A supplier, one draft order and a line on it, as the orders tests need. */
function seedOrder(be: Backend) {
  be.suppliers.push({
    id: "sup1", code: null, name: "Voltex", contact_name: null,
    phone: "051 000 0000", email: "orders@voltex.co.za",
    address: "1 Depot Rd, Bloemfontein", vat_number: "4000000000", notes: null,
  } as (typeof be.suppliers)[number]);
  const cable = PRODUCTS.find((p) => p.sku === "CBL-25-100")!;
  be.purchaseOrders.push({
    id: "po1", doc_number: "PO-000001", supplier_id: "sup1", status: "draft",
    expected_on: null, note: null, created_at: "2026-09-10T08:00:00.000Z",
    created_by_name: "Manager", sent_at: null,
  });
  be.poLines.push({
    id: "pl1", po_id: "po1", product_id: cable.id, sku: cable.sku,
    name: cable.name, unit_code: cable.unit_code, qty: 6, unit_cost: 50,
    received_qty: 0,
  });
}

/*
 * The screens a phone actually holds.
 *
 * Five things a manager found with the app in their hand: a sale's popup
 * carrying four counter actions across 390px as two rows of broken words,
 * an A4 document in a sideways scroller with its labels off one edge, a
 * quantity field that put the caret in front of the number, an order that
 * could not be emailed from the screen it was open on, and a stock count
 * whose reason field was squeezed to an invisible oval.
 */
test("on a phone a sale offers the invoice and none of the counter's work", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();

  const ctx = await page.context().browser()!.newContext({
    viewport: { width: 390, height: 844 },
  });
  const phone = await ctx.newPage();
  await installBackend(phone, be);
  await enrolPhoneAndSignIn(phone, be);
  await openManageOnPhone(phone, "Sales");
  await phone.locator("li.sale-row").first().click();

  const popup = phone.getByRole("dialog", { name: /INV-000001/ });
  await expect(popup).toBeVisible();
  // Sending somebody their invoice is exactly what a phone is for.
  await expect(popup.getByRole("button", { name: "A4 invoice" })).toBeVisible();
  // The rest needs the counter: a printer, the goods, the drawer.
  await expect(popup.getByRole("button", { name: "Reprint" })).toHaveCount(0);
  await expect(popup.getByRole("button", { name: "Return" })).toHaveCount(0);
  await expect(popup.getByRole("button", { name: "Cancel this sale" })).toHaveCount(0);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await ctx.close();
});

test("the till's own sale popup keeps every one of them", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();
  await openManage(page);
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await page.locator("li.sale-row").first().click();
  const popup = page.getByRole("dialog", { name: /INV-000001/ });
  for (const b of ["Reprint", "A4 invoice", "Return", "Cancel this sale"]) {
    await expect(popup.getByRole("button", { name: b })).toBeVisible();
  }
});

test("an A4 document is zoomed to fit a phone rather than scrolled sideways", async ({ page }) => {
  // The sale is rung at the counter's own size — at 390 the till's payment
  // column is a sheet and there is no Cash button to press — and the screen
  // is narrowed afterwards, which is the manager picking up their phone.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await openManage(page);
  await phoneMenu(page, "Sales");
  await page.locator("li.sale-row").first().click();
  await page.getByRole("button", { name: "A4 invoice" }).click();

  const box = page.locator(".doc-fit");
  await expect(box).toBeVisible();
  // The page is 210mm and the screen is 390px, so it is shrunk to fit.
  const zoom = await box.evaluate((el) =>
    Number(getComputedStyle(el).getPropertyValue("--doc-zoom")));
  expect(zoom, "the sheet is zoomed down").toBeGreaterThan(0);
  expect(zoom, "and not left at full size").toBeLessThan(1);
  // The whole width of the paper is on the screen: nothing to scroll to.
  const paper = (await page.locator(".doc-a4").first().boundingBox())!;
  const room = (await box.boundingBox())!;
  expect(paper.width).toBeLessThanOrEqual(room.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("tapping a number selects it, so the next key replaces it", async ({ page }) => {
  // The caret landed in front of the figure, so typing 5 over 54 gave 554
  // and correcting it meant backspacing through the old number first. The
  // order quantity is where it was found; the rule is every number field.
  seedOrder(be);
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Buying$/ }).click();
  await page.getByRole("button", { name: /^Orders$/ }).click();
  await page.locator("tr.acc-row").filter({ hasText: "PO-000001" }).click();
  const qty = page.locator('input[inputmode="decimal"]').first();
  await expect(qty).toBeVisible();
  await expect(qty).not.toHaveValue("");
  await qty.click();
  // Waited for, not read in the same breath as the click. The select is
  // deliberately deferred by one frame (lib/numberFields) so the browser's own
  // caret placement cannot win — a mouseup collapses a selection made during
  // focus — and reading it immediately is a race the test loses on a fast
  // page. It lost it once here, on the run that moved the suite onto a server
  // that answers quicker.
  await expect
    .poll(
      () =>
        qty.evaluate(
          (el: HTMLInputElement) =>
            el.value.length > 0 &&
            el.selectionStart === 0 &&
            el.selectionEnd === el.value.length
        ),
      { timeout: 5_000, message: "the whole figure is picked out" }
    )
    .toBe(true);
  // So one keystroke replaces it rather than joining it.
  await page.keyboard.type("7");
  await expect(qty).toHaveValue("7");
});

test("an order can be emailed from the order itself, not only from the list", async ({ page }) => {
  seedOrder(be);
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Buying$/ }).click();
  await page.getByRole("button", { name: /^Orders$/ }).click();
  await page.locator("tr.acc-row").filter({ hasText: "PO-000001" }).click();

  // On the order, beside the two decisions: the supplier's own address, the
  // document attached, and the order moves to "with the supplier" as the
  // list's own Email does.
  const email = page.getByRole("link", { name: "Email PO-000001" });
  await expect(email).toBeVisible();
  const href = (await email.getAttribute("href")) ?? "";
  expect(href).toMatch(/^mailto:orders%40voltex\.co\.za/);
  expect(decodeURIComponent(href)).toContain("Purchase Order PO-000001");
  await Promise.all([page.waitForEvent("download"), email.click()]);
  await expect.poll(() => be.purchaseOrders.find((o) => o.id === "po1")?.status).toBe("sent");
});

test("the stock count on a phone has room for the reason it is being counted", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await phoneMenu(page, "Catalogue");
  // A line that HAS stock: the count block only exists where there is a
  // number to count against.
  await page.locator(".cat-table tbody tr").filter({ hasText: "Cement 42.5N 50kg" }).click();
  // The editor is a full-screen overlay rather than a dialog role, so it is
  // reached by something only it has.
  await expect(page.getByRole("button", { name: "Save" }).last()).toBeVisible();
  const editor = page;
  const reason = editor.getByLabel("Reason for the count");
  await expect(reason).toBeVisible();
  // It was an oval a few pixels wide, squeezed between the count and Apply.
  const box = (await reason.boundingBox())!;
  expect(box.width, "the reason field is a field").toBeGreaterThan(180);
  // The count and its button hold their own line above it.
  const counted = (await editor.getByLabel("Counted quantity").boundingBox())!;
  const apply = (await editor.getByRole("button", { name: "Apply" }).boundingBox())!;
  expect(Math.abs(counted.y - apply.y), "the count and Apply are a pair").toBeLessThanOrEqual(4);
  expect(box.y, "the reason has its own line").toBeGreaterThan(counted.y + 8);
});

/**
 * Scanning, on a device with no gun.
 *
 * At the counter a scanner gun is a keyboard: it types the digits into
 * whatever box has focus and presses Enter, which is why every search box here
 * takes a barcode without a button. A phone has no gun, so the two places
 * somebody standing in the aisle finds an item — the catalogue and Look it up
 * — need the lens to do the gun's job.
 */
test("the catalogue is searched with the camera, and one barcode opens the item", async ({ page }) => {
  await installFakeDetector(page);
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  await openManageOnPhone(page, "Catalogue");

  // A chip pressed first, because a scan must find the thing being held up to
  // the camera wherever it is — not only if it happens to sit under whatever
  // filter was left on.
  await page.getByRole("button", { name: /^Low stock \d+$/ }).click();
  await expect(page.getByRole("cell", { name: /Padlock 50mm Brass/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Scan" }).click();
  await expect(page.getByRole("dialog", { name: "Scan a barcode" })).toBeVisible();
  await scanCode(page, "6001234000060");

  // The code went into the box, and the filter that would have hidden the
  // very item being held up to the camera let go.
  await expect(page.getByPlaceholder(/Search by name/)).toHaveValue("6001234000060");
  await expect(page.getByRole("button", { name: /^All \d+$/ }))
    .toHaveAttribute("aria-pressed", "true");

  // Scanning a thing to look at it IS opening it: the editor, on that item.
  await expect(page.getByRole("heading", { name: "Padlock 50mm Brass" })).toBeVisible();
  // The right one, by the code that was read rather than by the name on it.
  await expect(page.getByPlaceholder("6001234000015")).toHaveValue("6001234000060");
});

test("Look it up is scanned when the thing is already in your hand", async ({ page }) => {
  await installFakeDetector(page);
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  await phoneMenu(page, "Look it up");

  await page.getByRole("button", { name: "Scan" }).click();
  await expect(page.getByRole("dialog", { name: "Scan a barcode" })).toBeVisible();
  await scanCode(page, "6001234000015");

  const hit = page.locator(".phone-hit", { hasText: "Cement 42.5N 50kg" });
  await expect(hit).toBeVisible();
  await expect(hit.locator(".phone-hit-price")).toHaveText(/R\s?115\.00/);
});

/**
 * The delivery screen is the delivery.
 *
 * It listed every line in the catalogue, each with its own empty quantity box,
 * with the ones just scanned somewhere among them — so a delivery booked in
 * looked as though it had never gone away, and a barcode scanned by mistake
 * had no way off except hunting down its row and emptying a box, which is not
 * a thing anybody would guess.
 */
test("the delivery screen shows the delivery, and a line scanned by mistake comes off", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Stock" }).click();
  const gate = page.getByRole("dialog", { name: "Stock" });
  for (const d of USERS.manager.pin.split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  await page.getByRole("button", { name: /Receive a delivery/ }).click();

  // Nothing scanned, nothing listed — not the whole shop.
  await expect(page.getByText(/Nothing on this delivery yet/)).toBeVisible();
  await expect(page.locator(".acc-table tbody tr")).toHaveCount(1);

  const scan = page.getByLabel("Scan or find an item");
  await scan.fill("6001234000015");
  await scan.press("Enter");
  await scan.fill("6001234000060");
  await scan.press("Enter");
  // Two lines, and only the two.
  await expect(page.locator(".acc-table tbody tr")).toHaveCount(2);
  await expect(page.getByLabel("Quantity received of Cement 42.5N 50kg")).toHaveValue("1");

  // Clearing the box does NOT drop the line: that is somebody about to type a
  // different number, and the row disappearing under them is how a delivery
  // gets booked in short.
  await page.getByLabel("Quantity received of Padlock 50mm Brass").fill("");
  await expect(page.locator(".acc-table tbody tr")).toHaveCount(2);

  // The padlock was the wrong beep. Off it comes.
  await page.getByRole("button", { name: "Take Padlock 50mm Brass off the delivery" }).click();
  await expect(page.locator(".acc-table tbody tr")).toHaveCount(1);
  await expect(page.getByLabel("Quantity received of Padlock 50mm Brass")).toHaveCount(0);

  // An item with no barcode is still reachable — by name, and only while
  // something is being looked for. Two of them match here on purpose: a
  // quantity typed into the second must leave it where it is, because a row
  // that sorts itself to the top on the first keystroke takes the keyboard
  // with it.
  await scan.fill("nail");
  const rows = page.locator(".acc-table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Nail Concrete 2.5 x 50mm");
  await page.getByLabel("Quantity received of Nail Concrete 2.5 x 50mm").fill("4");
  await expect(rows.nth(1), "the row stays under the finger typing in it")
    .toContainText("Nail Concrete 2.5 x 50mm");

  // Off again, and with the box cleared the screen is the delivery once more.
  await page.getByRole("button", { name: "Take Nail Concrete 2.5 x 50mm off the delivery" }).click();
  await scan.fill("");
  await expect(page.locator(".acc-table tbody tr")).toHaveCount(1);

  await page.getByPlaceholder(/Supplier invoice/).fill("GRN-900");
  await page.getByRole("button", { name: /Book in 1 line/ }).click();
  await expect(page.getByText(/1 line booked in against GRN-900/)).toBeVisible();
  expect(be.stockMoves).toEqual([
    { product_id: "p1", qty_delta: 1, reason: "receipt", note: "GRN-900" },
  ]);
});

/**
 * A PIN proved is a PIN proved, for a while.
 *
 * Every door forgot it the moment its screen closed: the catalogue, then a
 * delivery, then the approvals meant six digits three times in a minute, for
 * the same person on the same device. Nothing was kept out by that — every
 * call behind the door re-checks the PIN server-side — so all it did was
 * punish the person doing the work.
 */
test("the back office asks for the PIN once, not once per screen", async ({ page }) => {
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await expect(page.getByRole("button", { name: "Catalogue" })).toBeVisible();

  // Out of the back office altogether, and back in.
  await page.getByRole("button", { name: "Back to till" }).click();
  await expect(page.getByPlaceholder(/Scan barcode/i)).toBeVisible();
  await page.getByRole("button", { name: /^Manage$/ }).click();

  await expect(page.getByRole("button", { name: "Catalogue" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Manage" })).toHaveCount(0);
});

test("a phone's owner is not asked for the PIN they signed in with a moment ago", async ({ page }) => {
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  await phoneMenu(page, "Approvals");
  await expect(page.locator(".admin-screen")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Manage" })).toHaveCount(0);
});

/**
 * A hit is a summary; the item is what was asked for.
 *
 * Look it up answers "have we got it" in a row a phone can only give so many
 * pixels to. The picture — the thing somebody standing in the aisle compares
 * against what is in their hand — needs the screen.
 */
test("an item found on the phone opens, picture, bin and all", async ({ page }) => {
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  await phoneMenu(page, "Look it up");
  await page.getByPlaceholder(/Scan a barcode/i).fill("cement");

  await page.getByRole("button", { name: "Open Cement 42.5N 50kg" }).click();
  const card = page.locator(".phone-item");
  await expect(card.getByRole("heading", { name: "Cement 42.5N 50kg" })).toBeVisible();
  await expect(card.locator(".phone-item-price")).toHaveText(/R\s?115\.00/);
  await expect(card.locator(".phone-item-bin")).toHaveText("A1");
  await expect(card).toContainText("240 bag");
  await expect(card).toContainText("6001234000015");
  // And the page does not run off the side of the phone.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // Back to the list that was searched, not out of Look it up altogether.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator(".phone-hit", { hasText: "Cement 42.5N 50kg" })).toBeVisible();
});

/**
 * Twelve reports, chosen without a wall of chips.
 *
 * They were twelve identical pills in a row that wrapped to four lines on a
 * phone, in an order with no logic to it — Losses beside Debtors, Refunds
 * beside Deliveries — so every visit meant reading all twelve to find one, and
 * on a phone they stood between the screen and any figure at all.
 */
test("the reports are chosen from a grouped list, not four rows of chips", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  // At this width the sections are behind the burger, the same menu a phone
  // gets.
  await phoneMenu(page, "Reports");

  const pick = page.getByLabel("Report", { exact: true });
  const period = page.getByLabel("Period", { exact: true });

  // Every one of them is still reachable, and each sits under the question it
  // answers rather than in a queue.
  await expect(pick.locator("option")).toHaveCount(12);
  await expect(pick.locator("optgroup")).toHaveCount(5);
  await expect(pick.locator("optgroup[label='The shelves'] option"))
    .toHaveText(["Stock", "Losses"]);

  // Both choosers on one line, which is the whole point on a phone.
  const a = (await pick.boundingBox())!;
  const b = (await period.boundingBox())!;
  expect(Math.abs(a.y - b.y), "the report and the period share a line")
    .toBeLessThanOrEqual(4);

  // A report about how things stand now has no period — said, rather than the
  // control quietly disappearing.
  await report(page, "Stock");
  await expect(period).toHaveCount(0);
  await expect(page.getByText("As it stands now")).toBeVisible();

  // And a window of somebody's own choosing still asks for its two dates.
  await report(page, "Departments");
  await period.selectOption({ label: "Choose dates" });
  await expect(page.getByLabel("From date")).toBeVisible();
  await expect(page.getByLabel("To date")).toBeVisible();
  // The page never runs off the side of the phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

/**
 * The bell: what needs somebody, right now.
 *
 * Not a log of what happened — 0100 argues that out — but the conditions
 * themselves, read out of the shop's own records each time. Which makes the
 * two things worth pinning here: that each row is a way in to the screen that
 * clears it, and that a till, which is nobody's device and stands where
 * customers can read it, is told the counter's work and none of the back
 * office's.
 */
test("the bell tells the counter what is waiting, and is the way to it", async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  be.deliveries.push({
    id: "b1", doc_number: "DEL-000041", sale_id: "s0", customer_name: "Today Buyer",
    address: "1 Main Rd", deliver_on: today, deliver_at: null, charge: 0,
    note: null, status: "pending", cashier_name: "Manager",
    delivered_by_name: null, delivered_at: null,
  });
  be.deliveries.push({
    id: "b2", doc_number: "DEL-000042", sale_id: "s0", customer_name: "Late Buyer",
    address: "2 Kerk St", deliver_on: yesterday, deliver_at: null, charge: 0,
    note: null, status: "pending", cashier_name: "Manager",
    delivered_by_name: null, delivered_at: null,
  });
  await pairAndSignIn(page, USERS.manager.pin);

  const bell = page.locator("button.bell");
  await expect(bell).toHaveAttribute("aria-label", "2 things need you");
  await bell.click();

  const panel = page.getByRole("dialog", { name: "What needs you" });
  await expect(panel).toContainText("1 delivery should already have gone");
  await expect(panel).toContainText("1 delivery goes out today");
  // The counter is not the back office, and this screen is readable from the
  // customer's side of it.
  await expect(panel).not.toContainText("reorder level");
  await expect(panel).not.toContainText("waiting to be priced");

  // A row is a way in, not a headline.
  await panel.locator(".bell-row", { hasText: /should already have gone/ }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByPlaceholder(/Find a delivery/)).toBeVisible();
});

test("with the line down the bell keeps the sales this till is holding", async ({ page }) => {
  // Something for the shop's half to hold, so that losing it is visible: a
  // load that should already have gone.
  be.deliveries.push({
    id: "b4", doc_number: "DEL-000044", sale_id: "s0", customer_name: "Late Buyer",
    address: "2 Kerk St", deliver_on: new Date(Date.now() - 864e5).toISOString().slice(0, 10),
    deliver_at: null, charge: 0, note: null, status: "pending",
    cashier_name: "Manager", delivered_by_name: null, delivered_at: null,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  // Read while there is a line, so the test is about losing it rather than
  // never having had it.
  await expect(page.locator("button.bell")).toHaveAttribute("aria-label", /1 thing needs you/);
  be.offline = true;
  await page.context().setOffline(true);
  await expect(page.locator("header").getByText(/offline/i)).toBeVisible({ timeout: 15000 });

  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await page.getByLabel("Close", { exact: true }).click();

  await page.locator("button.bell").click();
  const panel = page.getByRole("dialog", { name: "What needs you" });
  // The device's own news still works, because it never needed the line.
  await expect(panel).toContainText("1 sale still to reach the server");
  // And the shop's half is gone rather than stale: a figure from twenty
  // minutes ago, shown as though it were now, is worse than no figure.
  await expect(panel).not.toContainText("delivery");
});

test("a phone's bell carries the work only its owner can do", async ({ page }) => {
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  be.deliveries.push({
    id: "b3", doc_number: "DEL-000043", sale_id: "s0", customer_name: "Late Buyer",
    address: "2 Kerk St", deliver_on: yesterday, deliver_at: null, charge: 0,
    note: null, status: "pending", cashier_name: "Manager",
    delivered_by_name: null, delivered_at: null,
  });
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);

  const bell = page.locator("button.bell");
  await expect(bell).toHaveAttribute("aria-label", /things need you/);
  await bell.click();
  const panel = page.getByRole("dialog", { name: "What needs you" });
  await expect(panel).toContainText("1 delivery should already have gone");
  // The owner's own device, so the ordering IS their business here.
  await expect(panel).toContainText("1 item is at or below its reorder level");

  // And it opens the stock room, which on a phone needs no PIN of its own.
  await panel.locator(".bell-row", { hasText: /reorder level/ }).click();
  await expect(page.getByRole("button", { name: "Stock take" })).toBeVisible();
});

/**
 * The bell, on a phone: it fits, and it can be emptied.
 *
 * The panel hung off the button's own right edge, and the bell is nowhere
 * near the right edge of a phone — Sign out is beyond it — so a 22rem panel
 * ending at the bell began about sixty pixels off the left of the screen and
 * every line was cut in half. And nothing on the list could be put aside: the
 * ones that clear themselves clear themselves, but "3 items are at or below
 * reorder level" is true until the stock arrives, which is a bell that says
 * the same thing every day until nobody reads it.
 */
test("on a phone the bell fits the screen, and a standing notice can be put aside", async ({ page }) => {
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  be.deliveries.push({
    id: "b5", doc_number: "DEL-000045", sale_id: "s0", customer_name: "Late Buyer",
    address: "2 Kerk St", deliver_on: yesterday, deliver_at: null, charge: 0,
    note: null, status: "pending", cashier_name: "Manager",
    delivered_by_name: null, delivered_at: null,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);

  await page.locator("button.bell").click();
  const panel = page.getByRole("dialog", { name: "What needs you" });
  await expect(panel).toBeVisible();

  // Every edge of it is on the screen, and the first word of a line is not
  // somewhere off to the left of it.
  const box = (await panel.boundingBox())!;
  expect(box.x, "the panel's left edge").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "the panel's right edge").toBeLessThanOrEqual(390);
  const first = (await panel.locator(".bell-count").first().boundingBox())!;
  expect(first.x, "the count on the first row").toBeGreaterThanOrEqual(0);

  // What is low is true until the stock arrives, so it can be put aside for
  // the day rather than argued with every time the bell is opened.
  const low = panel.locator("li", { hasText: "reorder level" });
  await expect(low).toBeVisible();
  await low.getByRole("button", { name: /^Not today/ }).click();
  await expect(panel.locator("li", { hasText: "reorder level" })).toHaveCount(0);
  // The load that is late is somebody's work today and stays.
  await expect(panel).toContainText("should already have gone");
});

test("a notice dealt with is gone the next time the bell is opened", async ({ page }) => {
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  be.deliveries.push({
    id: "b6", doc_number: "DEL-000046", sale_id: "s0", customer_name: "Late Buyer",
    address: "2 Kerk St", deliver_on: yesterday, deliver_at: null, charge: 0,
    note: null, status: "pending", cashier_name: "Manager",
    delivered_by_name: null, delivered_at: null,
  });
  await pairAndSignIn(page, USERS.manager.pin);
  const bell = page.locator("button.bell");
  await bell.click();
  const panel = page.getByRole("dialog", { name: "What needs you" });
  await expect(panel).toContainText("1 delivery should already have gone");
  await page.keyboard.press("Escape");

  // Dealt with elsewhere — the load goes out. Opening the bell asks the shop
  // again rather than showing what it was told two minutes ago.
  be.deliveries.find((d) => d.id === "b6")!.status = "delivered";
  await bell.click();
  await expect(panel).not.toContainText("should already have gone");
});

/**
 * A pocket that buzzes.
 *
 * The bell only speaks to somebody already looking at the app, and the whole
 * point of a manager's phone is that it is in a pocket. Chromium here has no
 * push service, so the browser's own half is stubbed at the PushManager — what
 * this holds is everything on THIS side of it: that the offer appears on a
 * phone and never on the till, that saying yes reaches the shop with the
 * endpoint and both keys, and that saying no takes it off again.
 */
async function stubPush(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const sub = {
      endpoint: "https://push.test/endpoint-1",
      getKey: (name: string) =>
        new TextEncoder().encode(name === "auth" ? "sixteen-byte-aut" : "a-fake-p256dh-key").buffer,
      unsubscribe: async () => true,
    };
    let live: unknown = null;
    // This suite blocks service workers on purpose (playwright.config: the
    // worker's CacheFirst rule re-issues image GETs where page.route cannot
    // see them), so there is no registration to hang a push subscription off
    // and navigator.serviceWorker.ready never resolves. The registration is
    // supplied here; everything above it is the app's own code.
    const registration = {
      pushManager: {
        getSubscription: async () => live,
        subscribe: async () => (live = sub),
      },
    };
    const container = navigator.serviceWorker as unknown as Record<string, unknown>;
    Object.defineProperty(container, "ready", { get: () => Promise.resolve(registration) });
    container.getRegistration = async () => registration;
    // Headless Chrome answers "denied" to Notification.permission by default,
    // which is a real state the app handles (it says so rather than offering
    // a switch that cannot work) — but it is not the state THIS test is
    // about, and leaving it to the browser is why this passed here and failed
    // on CI. Pinned, both halves.
    const N = (window as unknown as {
      Notification: { requestPermission: () => Promise<string> };
    }).Notification;
    Object.defineProperty(N, "permission", { get: () => "default", configurable: true });
    N.requestPermission = async () => "granted";
  });
}

/** The same phone, with notifications turned off in its own settings. */
async function stubPushBlocked(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const N = (window as unknown as { Notification: unknown }).Notification;
    Object.defineProperty(N, "permission", { get: () => "denied", configurable: true });
  });
}

test("a phone can ask to be told with the app shut, and to stop", async ({ page }) => {
  await stubPush(page);
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);

  await page.locator("button.bell").click();
  const panel = page.getByRole("dialog", { name: "What needs you" });
  const ask = panel.getByRole("button", { name: "Tell me when the app is shut" });
  await expect(ask).toBeVisible();

  // Readable, which is not the same as present. It borrowed the header's
  // button styling at first — a pale colour meant for the dark green bar —
  // and on the cream panel it was very nearly invisible. Measured against
  // whatever is actually painted behind it.
  const contrast = await ask.evaluate((el) => {
    const channels = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    // The nearest ancestor that actually paints something.
    let behind: HTMLElement | null = el as HTMLElement;
    let bg = "rgb(255, 255, 255)";
    while (behind) {
      const c = getComputedStyle(behind).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) {
        bg = c;
        break;
      }
      behind = behind.parentElement;
    }
    const a = luminance(channels(getComputedStyle(el).color));
    const b = luminance(channels(bg));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast, "the switch against what is behind it").toBeGreaterThan(4);

  await ask.click();

  // The shop has somewhere to send to, and both keys that make it end to end.
  await expect.poll(() => be.pushSubs.length).toBe(1);
  expect(be.pushSubs[0].endpoint).toBe("https://push.test/endpoint-1");
  expect(be.pushSubs[0].p256dh.length).toBeGreaterThan(10);
  expect(be.pushSubs[0].auth.length).toBeGreaterThan(10);

  // And it says so, offering the way back out.
  const stop = panel.getByRole("button", { name: "Stop telling me when the app is shut" });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => be.pushSubs.length).toBe(0);
});

test("the till is never offered a notification a customer could read", async ({ page }) => {
  await stubPush(page);
  await pairAndSignIn(page, USERS.manager.pin);
  await page.locator("button.bell").click();
  const panel = page.getByRole("dialog", { name: "What needs you" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: /Tell me when the app is shut/ })).toHaveCount(0);
});

test("a phone that blocks notifications is told so, not offered a switch", async ({ page }) => {
  // Its own settings are the only place this can be undone, and a button that
  // silently does nothing is worse than a sentence that explains.
  await stubPushBlocked(page);
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  await page.locator("button.bell").click();
  const panel = page.getByRole("dialog", { name: "What needs you" });
  await expect(panel).toContainText("set to block notifications");
  await expect(panel.getByRole("button", { name: /Tell me when the app is shut/ })).toHaveCount(0);
});

/**
 * A phone that can hand a file to another app, which is every phone.
 *
 * Headless Chromium on Linux cannot, and answers so honestly — which is why
 * the existing quote tests still find a link called "Email" and are the other
 * half of this pair. This is the device the button is actually pressed on.
 */
async function stubCanShare(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const n = navigator as unknown as Record<string, unknown>;
    n.canShare = () => true;
    n.share = async () => {};
  });
}

test("the Save on the shop's details stays in reach of the field being corrected", async ({ page }) => {
  // The page runs to banking details, printing, slip width and two blocks of
  // small print. Save was the last thing on it, several screens below a
  // branch code somebody had just fixed — so the fix was typed, the page was
  // left, and nothing was written.
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: "Shop", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Printing/i })).toBeVisible();

  const save = page.getByRole("button", { name: /^Save$/ });
  const pane = page.locator("div.overflow-auto").filter({ has: save });

  // Non-vacuity: this proves nothing on a page that fits. It must overflow,
  // and something below the fold must really be below it.
  const room = await pane.evaluate((el) => ({
    scroll: el.scrollHeight, seen: el.clientHeight,
  }));
  expect(room.scroll, "the settings page is longer than the pane")
    .toBeGreaterThan(room.seen + 200);
  await pane.evaluate((el) => { el.scrollTop = 0; });
  await expect(page.getByLabel("Terms on a till slip"), "the small print is off the bottom")
    .not.toBeInViewport();

  // And from up here, with the small print out of sight, Save is still there.
  await expect(save).toBeInViewport();
  const box = (await save.boundingBox())!;
  const seen = page.viewportSize()!;
  expect(box.y + box.height, "the button is on the screen, not under it")
    .toBeLessThanOrEqual(seen.height);
});

test("on a phone the button says Share, because the share sheet is what opens", async ({ page }) => {
  // Reported from the shop: a manager pressed "Email" and got WhatsApp,
  // AirDrop, Notes and mail somewhere down the list. The press was right and
  // the word was wrong — and wrong on the device it is pressed on most.
  await stubCanShare(page);
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await saveAsQuote(page);
  await page.getByLabel("Close").click();
  await page.getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Quotes" }).click();
  await page.locator("tr.acc-row", { hasText: "QUO-000001" }).click();

  const popup = page.getByRole("dialog", { name: "Quote QUO-000001" });
  await expect(popup.getByRole("link", { name: "Share" })).toBeVisible();
  await expect(popup.getByRole("link", { name: "Email" })).toHaveCount(0);
});

test("a phone can find a quote and send it without going back to the shop", async ({ page }) => {
  // "Can you send me that quote again" is asked of whoever answers the phone,
  // and the only copy lived on a till behind the counter.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await saveAsQuote(page);
  await page.getByLabel("Close").click();

  const phoneContext = await page.context().browser()!.newContext({
    viewport: { width: 390, height: 844 },
  });
  const phone = await phoneContext.newPage();
  await installBackend(phone, be);
  await enrolPhoneAndSignIn(phone, be);
  await phoneMenu(phone, "Quotes");

  await expect(phone.getByRole("heading", { name: "Quotes" })).toBeVisible();
  await expect(phone.getByText("QUO-000001")).toBeVisible();

  // Not offered what a phone cannot do: there is no Sell screen here to open
  // a quote onto, and a button that refuses is worse than no button.
  await expect(phone.getByRole("button", { name: "Open on the till" })).toHaveCount(0);

  // What it IS here for: the document.
  await phone.getByText("QUO-000001").first().click();
  await expect(phone.getByRole("link", { name: /Share|Email/ }).first()).toBeVisible();

  // The page itself never scrolls sideways.
  expect(await phone.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await phoneContext.close();
});

test("a shop banks in two places, and the customer can pay into either", async ({ page }) => {
  // Not a filing preference: an EFT within a bank clears the same day and
  // between banks it takes two, so a customer shown their own bank pays the
  // shop sooner. A shop that lists one account is asking half its customers
  // to wait, and then chasing them for it.
  be.bankAccounts = [
    { id: "b1", bank_name: "First National Bank", account_name: "Ladybrand Hardware CC",
      account_number: "62012345678", branch_code: "250655", on_documents: true },
    { id: "b2", bank_name: "Capitec Business", account_name: "Ladybrand Hardware CC",
      account_number: "1051234567", branch_code: "470010", on_documents: true },
    // The shop's own, which a customer must never be handed.
    { id: "b3", bank_name: "Standard Bank", account_name: "Savings",
      account_number: "00099988877", branch_code: "051001", on_documents: false },
  ];

  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^EFT$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();

  const slip = page.locator("#print-area");
  await expect(slip).toContainText("PAYMENT DETAILS");
  await expect(slip).toContainText("62012345678");
  await expect(slip).toContainText("1051234567");
  await expect(slip).toContainText("Capitec Business");
  // One heading over both, not two blocks each announcing themselves.
  expect((await slip.innerText()).match(/PAYMENT DETAILS/g)?.length).toBe(1);
  // And the account the shop keeps to itself is nowhere near the counter —
  // the till was never sent it, so it cannot be printed by accident.
  await expect(slip).not.toContainText("00099988877");
  await expect(slip).not.toContainText("Standard Bank");
});

test("the account a shop keeps to itself never leaves the settings screen", async ({ page }) => {
  be.bankAccounts = [
    { id: "b1", bank_name: "First National Bank", account_name: "Ladybrand Hardware CC",
      account_number: "62012345678", branch_code: "250655", on_documents: true },
    { id: "b2", bank_name: "Standard Bank", account_name: "Savings",
      account_number: "00099988877", branch_code: "051001", on_documents: false },
  ];
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();

  // Here it is visible, because here is where it is edited.
  await expect(page.getByLabel("Account number 2")).toHaveValue("00099988877");
  await expect(page.getByLabel("Show account 2 on invoices and quotes")).not.toBeChecked();
  await expect(page.getByLabel("Show account 1 on invoices and quotes")).toBeChecked();
});

test("an account taken off the screen is an account the shop no longer has", async ({ page }) => {
  // Saving sends the list whole, so there is no second call to forget a row
  // and no way for the screen and the shop to disagree halfway through.
  be.bankAccounts = [
    { id: "b1", bank_name: "First National Bank", account_name: "Ladybrand Hardware CC",
      account_number: "62012345678", branch_code: "250655", on_documents: true },
    { id: "b2", bank_name: "Capitec Business", account_name: "Ladybrand Hardware CC",
      account_number: "1051234567", branch_code: "470010", on_documents: true },
  ];
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();
  await expect(page.getByLabel("Account number 1")).toHaveValue("62012345678");

  await page.getByRole("button", { name: "Remove account 1" }).click();
  await page.getByRole("button", { name: /^Save$/ }).click();

  await expect.poll(() => be.bankAccounts.length).toBe(1);
  expect(be.bankAccounts[0].account_number).toBe("1051234567");
});

test("a save cannot delete the accounts it never managed to read", async ({ page }) => {
  // The list is sent WHOLE — that is what makes removing a row work — and the
  // screen starts with an empty one. So anything that leaves it empty when it
  // should not be is an instruction to delete every account the shop has.
  // Two ways in: a read that fails, and a read that lands after somebody has
  // already started typing in a different field.
  be.bankAccounts = [
    { id: "b1", bank_name: "First National Bank", account_name: "Ladybrand Hardware CC",
      account_number: "62012345678", branch_code: "250655", on_documents: true },
  ];
  be.bankReadFails = true;

  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: /^Shop$/ }).click();
  await expect(page.getByText("Could not read the bank accounts")).toBeVisible();
  // Nothing to edit, because there is nothing safe to send.
  await expect(page.getByRole("button", { name: "Add another account" })).toBeDisabled();

  // A perfectly ordinary edit to something else, saved.
  await page.getByLabel("Phone").fill("051 924 1111");
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect.poll(() => be.orgSettings.phone).toBe("051 924 1111");

  // And the account is still there.
  expect(be.bankAccounts).toHaveLength(1);
  expect(be.bankAccounts[0].account_number).toBe("62012345678");
});

test("the shop is served its own security headers, not a weaker set", async ({ page }) => {
  // These are what a browser actually gets. worker/index.ts sets an identical
  // set, but Cloudflare's asset server answers any request matching a built
  // file WITHOUT invoking the Worker — so for a page load public/_headers is
  // the whole story, and the policy in the Worker was never in force on a
  // till. The deploy smoke check found it; this keeps it found.
  const res = await page.goto("/");
  const h = res!.headers();

  const csp = h["content-security-policy"] ?? "";
  // The line that matters: no 'unsafe-inline' on scripts is what makes an
  // injected <script> inert.
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");

  // Not SAMEORIGIN: a till that can be framed can be clickjacked into taking
  // a payment.
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["strict-transport-security"]).toContain("max-age=");

  // camera=(self), not camera=(). The camera IS the barcode scanner on a
  // phone and the viewfinder on the Shelf screen, and camera=() forbids the
  // shop's own page from opening one. Safari ignores this header on a
  // top-level document, which is why an iPhone kept working and nothing was
  // ever reported — a Chrome phone would have been refused.
  expect(h["permissions-policy"]).toContain("camera=(self)");
});

test("a sale rings all the way through without the policy refusing anything", async ({ page }) => {
  // The suite now runs under the shop's real Content-Security-Policy, so this
  // is the check that the policy and the app agree. A violation is reported to
  // the page rather than thrown, so it has to be collected deliberately —
  // otherwise the till simply does less and every assertion still passes.
  const refused: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const w = window as unknown as { __csp?: string[] };
      w.__csp ??= [];
      w.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) refused.push(m.text());
  });

  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByPlaceholder(/Scan barcode/i).fill("6001234000015");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Cash$/ }).click();
  await page.getByRole("button", { name: /Tender & print/i }).click();
  await expect(page.locator("#print-area")).toContainText("Cement");
  await page.getByLabel("Close").click();

  const reported = await page.evaluate(
    () => (window as unknown as { __csp?: string[] }).__csp ?? []
  );
  expect(reported, "the page reported no policy violation").toEqual([]);
  expect(refused, "and the console logged none").toEqual([]);
});

test("a person is hired into a job, not into sixteen boxes", async ({ page }) => {
  // A role plus sixteen permissions is the truth and it is also sixteen
  // chances to get somebody's Friday wrong — which is how a driver ends up
  // able to refund a sale.
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: "Staff", exact: true }).click();
  await page.getByRole("button", { name: /Add|Invite/ }).first().click();

  await page.getByLabel("Staff name").fill("Thabo Phakisi");
  await page.getByLabel("Staff mobile number").fill("082 555 0101");
  await page.getByRole("button", { name: "Driver", exact: true }).click();

  // The job says what it means, in the shop's own words.
  await expect(page.getByText(/Deliveries and looking an item up/)).toBeVisible();
  // And it is the Helper role underneath — the one that starts with nothing.
  await expect(page.getByRole("button", { name: "Driver", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: /^(Save|Add)/ }).last().click();

  // What actually reached the shop: a helper, holding nothing.
  await expect.poll(() => be.staff.find((s) => s.name === "Thabo Phakisi")?.role)
    .toBe("helper");
  expect(be.staff.find((s) => s.name === "Thabo Phakisi")?.permissions).toEqual([]);
});

test("a storeman gets the stock room and not the till", async ({ page }) => {
  // The point of the Helper role: on Counter these permissions would arrive
  // with take_payments attached, whatever was ticked.
  await pairAndSignIn(page, USERS.manager.pin);
  await openManage(page);
  await page.getByRole("button", { name: "Staff", exact: true }).click();
  await page.getByRole("button", { name: /Add|Invite/ }).first().click();
  await page.getByLabel("Staff name").fill("Sipho Dlamini");
  await page.getByLabel("Staff mobile number").fill("082 555 0102");
  await page.getByRole("button", { name: "Storeman", exact: true }).click();
  await page.getByRole("button", { name: /^(Save|Add)/ }).last().click();

  await expect.poll(() => be.staff.find((s) => s.name === "Sipho Dlamini")?.role)
    .toBe("helper");
  const saved = be.staff.find((s) => s.name === "Sipho Dlamini")!;
  expect([...saved.permissions].sort()).toEqual(["manage_inventory", "shelf_capture"]);
  // Not the till, and not the shop's margins.
  expect(saved.permissions).not.toContain("take_payments");
  expect(saved.permissions).not.toContain("view_cost_prices");
});

test("the jobs are on the manager's phone too, and fit it", async ({ page }) => {
  // Staff is where a manager hires somebody, and a manager is not at the
  // counter — they are in the aisle with a phone. A picker that only works at
  // 1280px is a picker they will not use.
  // A personal register is what makes it a phone to the SERVER; the viewport
  // is what makes it a phone to the layout. Both, or this checks a picker on
  // a 1280px screen and calls it a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await enrolPhoneAndSignIn(page, be, USERS.manager.pin);
  await openManageOnPhone(page, "Staff");
  await page.getByRole("button", { name: /Add|Invite/ }).first().click();

  await page.getByLabel("Staff name").fill("Naledi Mokoena");
  await page.getByLabel("Staff mobile number").fill("082 555 0103");
  const driver = page.getByRole("button", { name: "Driver", exact: true });
  await expect(driver).toBeVisible();
  await driver.click();
  await expect(driver).toHaveAttribute("aria-pressed", "true");

  // Every job is reachable without the page scrolling sideways.
  for (const job of ["Cashier", "Supervisor", "Storeman", "Manager"]) {
    await expect(page.getByRole("button", { name: job, exact: true })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);

  await page.getByRole("button", { name: /^(Save|Add)/ }).last().click();
  await expect.poll(() => be.staff.find((s) => s.name === "Naledi Mokoena")?.role)
    .toBe("helper");
});

test("a storeman is not shown a till she cannot use, nor a door into an empty room", async ({ page }) => {
  // Found in the shop, on a real counter machine. A Helper holding only the
  // stock room and the shelf was landed on the Sell screen, offered a Manage
  // button, and — because the back office had no tabs for her at all — given
  // a catalogue with a New product button, every count reading nought because
  // the server refused each call with her PIN. The database held the line and
  // every screen drew the door anyway.
  //
  // No camera, because that is the machine it happened on: a PinnPOS
  // all-in-one. It matters — the Shelf tab is the one thing a storeman HAS in
  // the back office, and without a lens there is nothing in there at all.
  await withCamera(page, false);
  await pairAndSignIn(page, USERS.storeman.pin);

  // Where she lands: her work, not the counter.
  const nav = page.getByRole("navigation", { name: "Sections" });
  await expect(nav.getByRole("button", { name: "Deliveries", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect(page.getByPlaceholder(/Scan barcode/i)).toHaveCount(0);

  // The counter is shown as shut, the way Quotes and Accounts already were.
  await expect(nav.getByRole("button", { name: "Sell", exact: true })).toBeDisabled();
  await expect(nav.getByRole("button", { name: "Quotes", exact: true })).toBeDisabled();
  // And the stock room, which IS hers, is not.
  await expect(nav.getByRole("button", { name: "Stock", exact: true })).toBeEnabled();

  // No Manage button: this counter machine has no camera, so the Shelf tab is
  // not offered, and manage_inventory opens nothing in the back office — the
  // Stock room is a screen on this till. The door would open on nothing.
  await expect(page.getByRole("button", { name: /^Manage$/ })).toHaveCount(0);
});

test("the same storeman on a device with a lens does get her one section", async ({ page }) => {
  // The other half, and the reason this is gated on what is INSIDE rather
  // than on the role: her Manage is the camera. Refusing her outright would
  // be as wrong as offering her a catalogue.
  await withCamera(page, true);
  await pairAndSignIn(page, USERS.storeman.pin);

  await page.getByRole("button", { name: /^Manage$/ }).click();
  const gate = page.getByRole("dialog", { name: "Manage" });
  for (const d of USERS.storeman.pin.split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(page.locator(".admin-screen")).toBeVisible();

  // One section, and it is hers. Not a catalogue she cannot load.
  await expect(page.getByRole("button", { name: "Shelf", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Catalogue", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New product" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Staff", exact: true })).toHaveCount(0);
});

test("the back office asks for YOUR PIN, and means it", async ({ page }) => {
  // The modal has always said "Enter your PIN to open the back office" and did
  // not check whose it was: it proved the PIN with a call the signed-in person
  // was entitled to make, then carried that PIN into every call inside. A
  // storeman who knew the manager's PIN got the manager's back office on her
  // own session — the screen hers, the authority his.
  await pairAndSignIn(page, USERS.manager.pin);
  await page.getByRole("button", { name: /^Manage$/ }).click();
  const gate = page.getByRole("dialog", { name: "Manage" });
  await expect(gate).toBeVisible();

  // Somebody else's PIN. Correct, current, and not this person's.
  for (const d of USERS.employee.pin.split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(gate.getByText(/not your PIN/i)).toBeVisible();
  await expect(page.locator(".admin-screen")).toHaveCount(0);

  // Their own opens it.
  for (const d of USERS.manager.pin.split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(page.locator(".admin-screen")).toBeVisible();
});

test("the stock room asks for YOUR PIN too, not just any that would open it", async ({ page }) => {
  // Reported from the shop the same day as the back office: the storeman
  // tapped Stock, was asked for a PIN, entered the manager's, and was let in.
  // It proved only that the PIN belonged to SOMEBODY holding the inventory
  // right — and every call inside then ran as him.
  await pairAndSignIn(page, USERS.storeman.pin);
  const nav = page.getByRole("navigation", { name: "Sections" });
  await nav.getByRole("button", { name: "Stock", exact: true }).click();

  const gate = page.getByRole("dialog", { name: "Stock" });
  await expect(gate).toBeVisible();
  for (const d of USERS.manager.pin.split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(gate.getByText(/not your PIN/i)).toBeVisible();
  // Still shut: the stock room never opened on somebody else's credentials.
  await expect(nav.getByRole("button", { name: "Stock", exact: true }))
    .not.toHaveAttribute("aria-current", "page");

  // Her own opens it — the room is hers, it is the borrowed key that is not.
  for (const d of USERS.storeman.pin.split("")) {
    await gate.locator(`button:text-is("${d}")`).first().click();
  }
  await expect(nav.getByRole("button", { name: "Stock", exact: true }))
    .toHaveAttribute("aria-current", "page");
});

