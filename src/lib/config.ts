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
const BASE_COLS = Number(import.meta.env.VITE_RECEIPT_WIDTH ?? 48);
export const RECEIPT_WIDTH = Math.max(16, Math.floor(BASE_COLS / PRINT_WIDTH_SCALE));

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
