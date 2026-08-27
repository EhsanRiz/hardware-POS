export { money } from "./money";
// The design spec's hard constraint is ONE money formatter, everywhere:
// thin space after the R and as the thousands separator, two decimals always.
// The Sell screen has complied since lib/money was written; this module used
// to carry its own `R123.45` and every back-office screen inherited the
// violation. Now both names lead to the same formatter.

// Format a phone number as "xxxx xxxx" (8 digits, Lesotho-style).
export function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 8);
  return d.length > 4 ? `${d.slice(0, 4)} ${d.slice(4)}` : d;
}
