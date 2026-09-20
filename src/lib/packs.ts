import type { CartLine, Product, SoldAs } from "./types";

/**
 * Sold whole, or sold cut.
 *
 * Pipe goes out as a 6 m length at one price and cut to size at another; wire
 * off a drum is a 25 m bundle or however many metres somebody asks for. One
 * product, two ways to buy it, two prices.
 *
 * EVERY RULE HERE IS ALSO IN THE DATABASE, in 0107, and that is deliberate
 * rather than sloppy: the server is what decides, because the till is offline
 * half the time and a device is never the authority on money. What this file
 * is for is the till being able to SHOW the right price and the right label
 * before the server has seen the sale — and the slip that prints with the line
 * down saying the same thing the invoice will say when it syncs.
 *
 * Which makes the pair a hazard worth naming: two implementations of one rule
 * agree until they don't. The database tests in supabase/test/schema.test.sql
 * pin the server's half, the unit tests in test/packs.test.mjs pin this half,
 * and both name the same worked example — R180 the length, R38 the metre —
 * so a change to one that forgets the other has somewhere to go red.
 */

export type { SoldAs };

/** Whether this item can be bought both ways at all. */
export function soldBothWays(p: Product): boolean {
  return p.sold_in_packs === true && p.pack_size != null && p.pack_size > 0;
}

/**
 * What the counter reaches for first.
 *
 * A whole length, because that is the common sale and a cashier should not
 * have to choose on every pipe. Cutting is the deliberate act, so it is the
 * deliberate tap.
 */
export function defaultSoldAs(p: Product): SoldAs {
  return soldBothWays(p) ? "pack" : "unit";
}

/** The mode a line is actually on, tolerating a line saved before 0107. */
export function lineSoldAs(l: Pick<CartLine, "product" | "soldAs">): SoldAs {
  if (!soldBothWays(l.product)) return "unit";
  return l.soldAs === "unit" ? "unit" : "pack";
}

/**
 * The price of one of whatever is being bought.
 *
 * Mirrors price_for/price_cut_for (0002, 0107): trade falls back to retail
 * when the shop has not set a trade price, and it falls back down the SAME
 * column — a contractor buying cut pipe gets the trade cut price, not the
 * trade length price, and not the retail cut price either.
 */
export function priceFor(p: Product, trade: boolean, soldAs: SoldAs): number {
  if (soldAs === "unit" && soldBothWays(p)) {
    if (trade && p.price_cut_trade != null) return p.price_cut_trade;
    return p.price_cut_retail ?? p.price_retail;
  }
  if (trade && p.price_trade != null) return p.price_trade;
  return p.price_retail;
}

/** What the shelf gives up: two 6 m lengths is twelve metres. */
export function baseQty(p: Product, soldAs: SoldAs, qty: number): number {
  if (soldAs !== "pack" || !soldBothWays(p)) return qty;
  return qty * (p.pack_size as number);
}

/**
 * Whether a fraction is legitimate.
 *
 * The pack is the thing that cannot be split, whatever its base unit allows.
 * Pipe is measured in metres and metres divide — but two and a half 6 m
 * LENGTHS is not an order anybody can pick off a rack, so the mode overrules
 * the unit here. For a cut, and for every ordinary item, the unit decides
 * exactly as it always did.
 */
export function allowsFraction(p: Product, soldAs: SoldAs): boolean {
  if (soldAs === "pack" && soldBothWays(p)) return false;
  return p.allows_fraction;
}

/**
 * What one of it is called, in the shop's own words.
 *
 * "6 m length" rather than "1 pack (6 m)", because the first is what somebody
 * says across a counter and the second is what a system says back at them.
 */
export function unitLabel(p: Product, soldAs: SoldAs): string {
  if (soldAs === "pack" && soldBothWays(p)) {
    return p.pack_label?.trim() || `${p.pack_size} ${p.unit_code}`;
  }
  return p.unit_name || p.unit_code;
}

/**
 * How the line reads on a slip, under its name.
 *
 * A pack line has to say which way it went out or the paper is ambiguous and
 * a return cannot be priced: "2 x 6 m length" and "12 m" are the same pipe and
 * very different money.
 */
export function qtyLabel(p: Product, soldAs: SoldAs, qty: number): string {
  const n = Number.isInteger(qty) ? String(qty) : String(qty);
  if (soldAs === "pack" && soldBothWays(p)) {
    return `${n} x ${unitLabel(p, "pack")}`;
  }
  return `${n} ${unitLabel(p, "unit")}`;
}

/**
 * What the quantity box should ask for.
 *
 * "How many 6 m lengths" and "How many metres" are different questions and the
 * wrong one gets the wrong number typed into it.
 */
export function qtyPrompt(p: Product, soldAs: SoldAs): string {
  return soldAs === "pack" && soldBothWays(p)
    ? `How many ${unitLabel(p, "pack")}`
    : `How many ${unitLabel(p, "unit")}`;
}
