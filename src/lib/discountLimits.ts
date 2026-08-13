import type { CartLine, User } from "./types";

/**
 * The two ceilings on a discount, worked out on the device.
 *
 * The database is where these are enforced — see 0037_discount_limits.sql, and
 * the comment at the top of it for why one refuses and the other only parks.
 * This file exists so the till can say what the ceiling is *while somebody is
 * typing into the box*, rather than letting them promise a customer 20% off and
 * then discovering at tender time that the cement is capped at 5%.
 *
 * So this is a second implementation of the server's arithmetic, which is
 * exactly the kind of thing that drifts. Two defences: it is small, and the
 * numbers it produces are asserted against the real database in
 * supabase/test/schema.test.sql rather than only against the fake backend.
 */

/** A per-unit price and quantity is all a cap needs to know about a line. */
interface Capped {
  qty: number;
  unitPrice: number;
  maxDiscountPercent?: number | null;
  maxDiscountAmount?: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The most that may ever come off this line, however the discount is given.
 *
 * Null means uncapped. Where both halves are set the tighter binds, and the
 * rand one is per unit — "R2 off a bag" on ten bags is R20, so the cap scales
 * with quantity the way a percentage does.
 */
export function lineCap(l: Capped): number | null {
  const gross = r2(l.unitPrice * l.qty);
  const caps: number[] = [];
  if (l.maxDiscountPercent != null) caps.push(r2((gross * l.maxDiscountPercent) / 100));
  if (l.maxDiscountAmount != null) caps.push(r2(l.maxDiscountAmount * l.qty));
  return caps.length ? Math.min(...caps) : null;
}

/**
 * The cap on a cart line. The unit price is passed in rather than read off the
 * product because a trade customer is charged price_trade, and a cap expressed
 * as a percentage has to be a percentage of what is actually being charged.
 */
export function cartLineCap(line: CartLine, unitPrice: number): number | null {
  return lineCap({
    qty: line.qty,
    unitPrice,
    maxDiscountPercent: line.product.max_discount_percent,
    maxDiscountAmount: line.product.max_discount_amount,
  });
}

/**
 * The largest sale-level discount the caps leave room for.
 *
 * A blanket discount spreads pro-rata across what each line is left worth after
 * its own discount, so line i takes D × netᵢ / netTotal of it. Holding that
 * plus the line's own discount inside the line's cap gives
 *
 *     D ≤ (capᵢ − ownᵢ) × netTotal / netᵢ
 *
 * for every capped line, and the smallest of those is the answer. Uncapped
 * lines put no ceiling on it, so a cart with no caps in it returns the whole
 * net subtotal and nothing changes for the shops that never set one.
 */
export function saleDiscountCeiling(
  lines: { qty: number; price: number; discount?: number; cap: number | null }[]
): number {
  const nets = lines.map((l) => r2(l.price * l.qty) - (l.discount ?? 0));
  const netTotal = nets.reduce((a, b) => a + b, 0);
  if (netTotal <= 0) return 0;

  let ceiling = netTotal;
  lines.forEach((l, i) => {
    if (l.cap == null) return;
    const headroom = l.cap - (l.discount ?? 0);
    // Already at or past its cap on its own: this line can take no share of a
    // blanket discount at all, so no blanket discount is possible.
    if (headroom <= 0) {
      ceiling = 0;
      return;
    }
    if (nets[i] <= 0) return;
    ceiling = Math.min(ceiling, (headroom * netTotal) / nets[i]);
  });
  // Round down, not to nearest: rounding up would hand back a figure the
  // server then refuses by a cent.
  return Math.max(0, Math.floor(ceiling * 100) / 100);
}

/**
 * What this person may discount without fetching anybody.
 *
 * Null means "no standing authority" — every discount goes for approval, which
 * is how the shop behaved before limits existed. Somebody who can approve
 * discounts is not bound by a limit at all: they would only be approving
 * themselves. To rein those people in the owner caps the items instead.
 */
export function staffCeiling(user: User | null, subtotal: number): number | null {
  if (!user) return null;
  const caps: number[] = [];
  if (user.discount_limit_percent != null) {
    caps.push(r2((subtotal * user.discount_limit_percent) / 100));
  }
  if (user.discount_limit_amount != null) caps.push(user.discount_limit_amount);
  return caps.length ? Math.min(...caps) : null;
}
