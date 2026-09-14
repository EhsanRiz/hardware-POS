import { requireToken } from "./api";
import { supabase } from "./supabase";

/**
 * The bell: what needs somebody, right now.
 *
 * Every row here is a CONDITION in the shop rather than an event that
 * happened — 0100 says why at length. The consequence for this file is that
 * there is nothing to mark as read: a notice leaves the list when the thing
 * is dealt with, because it was never anything but the thing itself. What the
 * bell remembers instead is what it looked like last time somebody opened it,
 * so the dot means "this is new since you looked" rather than "you have not
 * acknowledged this", which is the thing that turns bells into wallpaper.
 */

/** What the server counts. Null where it is not this device's business. */
export interface NoticeCounts {
  approvals: number | null;
  deliveries_late: number | null;
  deliveries_today: number | null;
  drawer_open: number | null;
  low_stock: number | null;
  staff_no_pin: number | null;
  unpriced: number | null;
  orders_overdue: number | null;
}

/** What the device itself knows, which no server can tell it. */
export interface LocalCounts {
  /** Sales taken offline, still queued. */
  pending: number;
  /** Sales the server refused, waiting for somebody to look. */
  failed: number;
}

export interface Notice {
  kind: string;
  count: number;
  /** One line of plain English, the count already in it. */
  line: string;
  /**
   * Where the fixing happens, as a menu key — the same keys lib/menu uses, so
   * the bell hands its destination to the router the menu already goes
   * through rather than inventing a second way to move about.
   */
  goes: "approvals" | "deliveries" | "stock" | "cashup" | "staff" | "catalogue"
      | "buying" | "failed";
}

const one = (n: number, singular: string, plural: string) =>
  `${n} ${n === 1 ? singular : plural}`;

/**
 * The rows, in the order they matter.
 *
 * A customer waiting at the counter beats a delivery that is late, which beats
 * anything the back office can do tomorrow. Zeroes and nulls are not rows: a
 * bell that lists "0 deliveries late" has taught you to stop reading it.
 */
export function buildNotices(
  server: Partial<NoticeCounts> | null,
  local: LocalCounts
): Notice[] {
  const out: Notice[] = [];
  const add = (
    count: number | null | undefined, kind: string, goes: Notice["goes"],
    line: (n: number) => string
  ) => {
    if (count == null || count <= 0) return;
    out.push({ kind, count, goes, line: line(count) });
  };

  add(server?.approvals, "approvals", "approvals", (n) =>
    `${one(n, "sale is", "sales are")} waiting for a manager`);
  add(local.failed, "failed", "failed", (n) =>
    `${one(n, "sale", "sales")} the server refused`);
  add(server?.deliveries_late, "deliveries_late", "deliveries", (n) =>
    `${one(n, "delivery", "deliveries")} should already have gone`);
  add(server?.deliveries_today, "deliveries_today", "deliveries", (n) =>
    `${one(n, "delivery goes", "deliveries go")} out today`);
  add(server?.drawer_open, "drawer_open", "cashup", (n) =>
    `${one(n, "drawer", "drawers")} left open since yesterday`);
  add(local.pending, "pending", "failed", (n) =>
    `${one(n, "sale", "sales")} still to reach the server`);
  add(server?.staff_no_pin, "staff_no_pin", "staff", (n) =>
    `${one(n, "person", "people")} invited but without a PIN`);
  add(server?.unpriced, "unpriced", "catalogue", (n) =>
    `${one(n, "item is", "items are")} waiting to be priced`);
  add(server?.orders_overdue, "orders_overdue", "buying", (n) =>
    `${one(n, "order is", "orders are")} past the day it was due`);
  add(server?.low_stock, "low_stock", "stock", (n) =>
    `${one(n, "item is", "items are")} at or below its reorder level`);

  return out;
}

/**
 * What this list looked like, as one short string.
 *
 * Kinds and counts, so a new notice OR one that grew marks the bell, and
 * opening it and dealing with nothing does not.
 */
export function signature(notices: Notice[]): string {
  return notices.map((n) => `${n.kind}:${n.count}`).join(",");
}

export async function fetchNotices(today: Date): Promise<NoticeCounts> {
  const { data, error } = await supabase.rpc("pos_notices", {
    p_register_token: requireToken(),
    // The shop's own date, not the server's: a delivery is late where the
    // shop is standing.
    p_today: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`,
  });
  if (error) throw error;
  return data as NoticeCounts;
}
