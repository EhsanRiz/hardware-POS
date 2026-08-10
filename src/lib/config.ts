// Currency symbol shown throughout the app and on receipts.
// Change VITE_CURRENCY in .env to match the shop (e.g. "R", "M", "$", "£").
export const CURRENCY = import.meta.env.VITE_CURRENCY ?? "R";

export const SHOP_NAME = import.meta.env.VITE_SHOP_NAME ?? "Hardware Shop";

// Shop address printed on bills/invoices. Use "|" to separate lines in .env.
export const SHOP_ADDRESS = (import.meta.env.VITE_SHOP_ADDRESS ?? "")
  .split("|")
  .map((s: string) => s.trim())
  .filter(Boolean);

// VAT registration number and rate (e.g. 0.15 for 15%). Prices are treated as
// VAT-inclusive, so the printed VAT line is the tax portion of the total.
export const VAT_NUMBER = import.meta.env.VITE_VAT_NUMBER ?? "";
export const VAT_RATE = Number(import.meta.env.VITE_VAT_RATE ?? 0.15);

// Suggested tip percentages (on the after-discount total).
export const TIP_PERCENTS = (import.meta.env.VITE_TIP_PERCENTS ?? "10,12.5,15")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => !Number.isNaN(n));

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Number.isNaN(n) ? lo : n));

// Printed font scale (1–8×). Width scale narrows the columns (80mm fits ~48 at
// 1×, ~24 at 2×), so default to bigger height and normal width.
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

// Columns available for layout, derived from paper width ÷ width scale.
const BASE_COLS = Number(import.meta.env.VITE_RECEIPT_WIDTH ?? 48);
export const RECEIPT_WIDTH = Math.max(16, Math.floor(BASE_COLS / PRINT_WIDTH_SCALE));
