import { CURRENCY } from "./config";

export function money(amount: number): string {
  return `${CURRENCY}${amount.toFixed(2)}`;
}

// Format a phone number as "xxxx xxxx" (8 digits, Lesotho-style).
export function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 8);
  return d.length > 4 ? `${d.slice(0, 4)} ${d.slice(4)}` : d;
}
