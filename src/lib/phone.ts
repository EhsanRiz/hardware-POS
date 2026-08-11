/**
 * Phone numbers, as typed at a counter.
 *
 * This mirrors `normalize_phone` from migration 0023. The server is the
 * authority — it holds the shop's own dialling code and it owns the uniqueness
 * constraint — but the till needs the same answer offline, where the cached
 * customer list is all it has. Keep the two in step: if the rules change in
 * SQL, change them here.
 *
 * The default of +27 is the one deliberate difference. The server reads the
 * shop's dial_code; a till working offline assumes South Africa. Anything typed
 * with a leading + is honoured as-is either way, so a Lesotho number entered as
 * +266… still matches while the line is down.
 */

const DEFAULT_DIAL_CODE = "+27";

/**
 * A number reduced to one canonical E.164 form, or null if it cannot be read as
 * a phone number at all.
 */
export function normalizePhone(
  input: string | null | undefined,
  dialCode = DEFAULT_DIAL_CODE
): string | null {
  const typed = (input ?? "").trim();
  if (!typed) return null;

  const digits = typed.replace(/\D/g, "");
  if (!digits) return null;

  const cc = dialCode.trim() || DEFAULT_DIAL_CODE;
  let out: string;

  if (typed.startsWith("+")) {
    // Typed in full. Believe it, whatever country it belongs to.
    out = `+${digits}`;
  } else if (digits.startsWith("00")) {
    // The other way of writing '+'.
    out = `+${digits.slice(2)}`;
  } else if (digits.startsWith("0")) {
    // National trunk code: 082… is this country's 82…
    out = cc + digits.slice(1);
  } else if (digits.startsWith(cc.slice(1)) && digits.length > 9) {
    // Carries the country code already, just without the plus.
    out = `+${digits}`;
  } else {
    // A bare subscriber number.
    out = cc + digits;
  }

  // The floor of 9 is what stops a mistyped '12345' becoming a customer.
  return /^\+\d{9,15}$/.test(out) ? out : null;
}

/**
 * Is the cashier typing a phone number or a name?
 *
 * Used to decide whether an unmatched search term is worth offering as a new
 * buyer. Six digits is enough of a signal without catching an account code.
 */
export function looksLikePhone(term: string): boolean {
  const digits = term.replace(/\D/g, "");
  return digits.length >= 6 && /^[\d\s+()./-]+$/.test(term.trim());
}

/**
 * A South African number as people actually write it: 082 123 4567.
 *
 * Anything foreign is left in E.164 rather than being forced into a local
 * shape it does not have.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^\+27(\d{2})(\d{3})(\d{4})$/.exec(e164);
  if (m) return `0${m[1]} ${m[2]} ${m[3]}`;
  return e164;
}

/**
 * Does this customer's number match what was typed?
 *
 * Falls back to a digit-suffix comparison when neither side normalises cleanly,
 * so a half-typed number still narrows the list as the cashier goes.
 */
export function phoneMatches(stored: string | null | undefined, term: string): boolean {
  const digits = term.replace(/\D/g, "");
  if (digits.length < 3) return false;

  const storedDigits = (stored ?? "").replace(/\D/g, "");
  if (!storedDigits) return false;

  const a = normalizePhone(stored);
  const b = normalizePhone(term);
  if (a && b && a === b) return true;

  // Partial: the cashier is still typing.
  return storedDigits.endsWith(digits) || storedDigits.includes(digits);
}
