/**
 * South African number formatting.
 *
 * The convention is `R 3 019.82`: a thin space after the R, thin spaces as the
 * thousands separator, and always two decimals. `Intl.NumberFormat("en-ZA")`
 * does not produce this — depending on the runtime it gives `R3 019,82` with a
 * decimal comma, or a non-breaking space, or a plain space. A till shows prices
 * thousands of times a day next to a customer who is checking them, so the
 * formatter is written explicitly rather than left to vary by browser.
 *
 * One formatter, used everywhere. See CLAUDE.md, hard constraint 4.
 */

/** U+2009 THIN SPACE. Narrower than a word space; the correct separator here. */
export const THIN_SPACE = " ";

export interface MoneyOptions {
  /** Include the "R" prefix. Off for columns that carry the unit in the header. */
  currency?: boolean;
  /** Render a negative as "−R 12.00" (true minus, U+2212) rather than "-". */
  signed?: boolean;
}

/**
 * Group the integer part in threes with thin spaces: 3019 -> "3 019".
 * Grouping runs right-to-left, so it is done on the reversed string.
 */
function groupThousands(intPart: string): string {
  let out = "";
  for (let i = 0; i < intPart.length; i++) {
    if (i > 0 && i % 3 === 0) out = THIN_SPACE + out;
    out = intPart[intPart.length - 1 - i] + out;
  }
  return out;
}

/** `R 3 019.82`. The one place money becomes text. */
export function money(value: number, opts: MoneyOptions = {}): string {
  const { currency = true, signed = false } = opts;

  if (!Number.isFinite(value)) return currency ? `R${THIN_SPACE}0.00` : "0.00";

  const negative = value < 0;
  // toFixed rounds half away from zero on the absolute value, which is what a
  // till should do — rounding a price toward zero quietly favours one party.
  const fixed = Math.abs(value).toFixed(2);
  const [intPart, decPart] = fixed.split(".");

  let out = `${groupThousands(intPart)}.${decPart}`;
  if (currency) out = `R${THIN_SPACE}${out}`;
  if (negative) out = (signed ? "−" : "-") + out;
  return out;
}

/**
 * A quantity with its unit: `2.5 m`, `6.40 kg`, `20`.
 *
 * Trailing zeros are trimmed because "3.000 bag" reads badly on an invoice, but
 * weighed goods keep two decimals — 6.4 kg on a scale slip should read `6.40 kg`,
 * matching what the scale showed.
 */
export function quantity(value: number, unitCode?: string, weighed = false): string {
  const n = weighed ? value.toFixed(2) : String(Number(value.toFixed(3)));
  const grouped = n.includes(".")
    ? `${groupThousands(n.split(".")[0])}.${n.split(".")[1]}`
    : groupThousands(n);
  return unitCode && unitCode !== "ea" ? `${grouped} ${unitCode}` : grouped;
}

/**
 * The VAT contained within a VAT-inclusive amount.
 *
 * Shelf prices in South Africa include VAT, so the tax is the portion within
 * the total rather than something added to it.
 */
export function vatWithin(inclusive: number, rate: number): number {
  return Math.round((inclusive - inclusive / (1 + rate)) * 100) / 100;
}

/**
 * The cash-rounding adjustment for an amount that must be paid in coins.
 *
 * South Africa stopped minting 1c, 2c and 5c coins, so R187.05 cannot be handed
 * over. Cash settles to the nearest 10c, and an exact half rounds DOWN — in the
 * customer's favour, which is the convention South African retail adopted and
 * the one a customer can check in their head without feeling cheated.
 *
 * The invoice total is NOT rounded: VAT is computed on it, and only the cash
 * portion of a settlement is paid in coins. Mirrors public.cash_rounding() in
 * migration 0019 — the server recomputes and is the authority.
 */
export function cashRounding(amount: number): number {
  const cents = Math.round(amount * 100);
  const settled = Math.ceil(cents / 10 - 0.5) * 10;
  const adjustment = (settled - cents) / 100;
  // Normalise negative zero: it compares equal to 0 but formats as "-0.00",
  // and a receipt line reading "Cash rounding -0.00" is a support call.
  return adjustment === 0 ? 0 : adjustment;
}
