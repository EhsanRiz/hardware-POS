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
