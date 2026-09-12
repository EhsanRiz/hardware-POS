// Build-time configuration.
//
// Shop identity (name, address, VAT number) is NOT here — it lives in the
// `settings` table and is read via settings.ts, so the shop can correct it
// without a redeploy. What remains here is genuinely per-device or per-build:
// the printer's paper width and font scale.

/** Currency symbol shown throughout the app and on receipts. */
export const CURRENCY = import.meta.env.VITE_CURRENCY ?? "R";

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Number.isNaN(n) ? lo : n));

// Printed font scale (1-8x). Width scale narrows the columns (80mm fits ~48 at
// 1x, ~24 at 2x), so default to bigger height and normal width.
export const PRINT_WIDTH_SCALE = clamp(
  Number(import.meta.env.VITE_PRINT_WIDTH_SCALE ?? 1),
  1,
  8
);
export const PRINT_HEIGHT_SCALE = clamp(
  Number(import.meta.env.VITE_PRINT_HEIGHT_SCALE ?? 3),
  1,
  8
);

// Columns available for layout, derived from paper width / width scale.
const BASE_COLS = Number(import.meta.env.VITE_RECEIPT_WIDTH ?? 40);
export const RECEIPT_WIDTH = Math.max(16, Math.floor(BASE_COLS / PRINT_WIDTH_SCALE));

/**
 * How many columns the slip is printed at, per device.
 *
 * This is THE lever on the size of the print, and the only one. The type is
 * sized so that a full line just fits the paper, so a character is roughly
 * (paper width / columns): fewer columns is bigger print and nothing else is.
 * Everything else — the page margin, the divisor — is worth a few percent.
 *
 *   48  the most a 80mm roll holds. A description and an amount, comfortably.
 *   40  the default. ~20% bigger type; descriptions start to be cut.
 *   32  big enough to read at arm's length, and names are properly short.
 *
 * Per device rather than per shop, and for the same reason the print mode is:
 * the counter's 80mm Epson and a manager's A4 laser are not the same paper.
 * It is a build default with a local override, so a shop that has never opened
 * the setting still gets something sensible.
 */
export const SLIP_WIDTHS = [48, 40, 32] as const;
export type SlipWidth = (typeof SLIP_WIDTHS)[number];
const SLIP_WIDTH_KEY = "pos.slipWidth";

export function slipWidth(): number {
  if (typeof localStorage === "undefined") return RECEIPT_WIDTH;
  const n = Number(localStorage.getItem(SLIP_WIDTH_KEY));
  return (SLIP_WIDTHS as readonly number[]).includes(n) ? n : RECEIPT_WIDTH;
}

export function setSlipWidth(n: SlipWidth): void {
  localStorage.setItem(SLIP_WIDTH_KEY, String(n));
}

/**
 * The divisor the print rule sizes the type by: 100vw / (columns x 0.71).
 *
 * 0.69 is the measured width of a monospace character in ems — not the 0.6
 * usually quoted — and the rest is the hair of slack that keeps the longest
 * line off the edge. Published as a CSS variable because only JavaScript
 * knows how many columns this device prints at.
 */
export function slipTypeDivisor(cols = slipWidth()): number {
  return Math.round(cols * 0.71 * 10) / 10;
}

/** Hand the print rule the number only this side knows. Called at boot, and
    again whenever the width is changed, so the setting takes without a
    reload. */
export function publishSlipMetrics(): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--slip-div", String(slipTypeDivisor()));
}

/**
 * South African VAT, as a fraction. Shelf prices INCLUDE it, so this is used to
 * show the portion within a total, never to add to one.
 *
 * The rate is a build constant rather than a shop setting because it is set by
 * the Minister of Finance, not by the shop, and a till that lets a cashier
 * change it is a till that can print an invalid tax invoice.
 *
 * This is now only the LAST RESORT. What gets charged has always come from
 * public.tax_rates, resolved by date and stored on the sale line, and 0038
 * serves that same rate to the till with the rest of the shop's settings — so
 * settings.vatRate() is what anything on screen should ask. This constant is
 * reached only on a device that has never once heard from the server, which is
 * a till that has not made a sale yet.
 */
export const VAT_RATE = 0.15;

/**
 * Where staff prove their phone and choose their own PIN.
 *
 * Both the sign-in screen (a forgotten PIN) and the staff roster (a new
 * colleague) point here, so it lives in one place: the two must never disagree
 * about where somebody is being sent.
 */
export const ENROL_URL =
  import.meta.env.VITE_ENROL_URL ?? "https://pos.innovaearth.com/enrol/";

/**
 * Where a shop that is not on InnovaPOS yet asks to be. The first-run screen
 * points here, because a stranger who types the app's address must be given
 * somewhere to go rather than a form they cannot fill in.
 */
export const REQUEST_URL =
  import.meta.env.VITE_REQUEST_URL ?? "https://pos.innovaearth.com/request/";
