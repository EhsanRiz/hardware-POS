// The app's one menu, on a phone.
//
// A phone used to have two: nine tiles on the home, and a different burger
// inside Manage. Two lists mean two places to keep in step, and a manager
// looking for Approvals had to know which of the two it lived behind. This
// is the single list both of them render, so "go to Approvals" is the same
// two taps from wherever you are.
//
// Three of the destinations are screens the phone owns outright; the rest
// are sections of Manage, which asks for a PIN on the way in. The order is
// the order of a day: what you are carrying, then what you are selling,
// then the books.
import { can, canAny } from "./permissions";
import type { PermKey } from "./permissions";
import type { User } from "./types";

/** A screen the phone owns, or a section of Manage behind the PIN. */
export type MenuKind = "screen" | "tab";

export interface MenuItem {
  key: string;
  label: string;
  kind: MenuKind;
  /** Any one of these is enough. Empty means everybody who can sign in. */
  perms: PermKey[];
  /** Needs a lens. */
  camera?: boolean;
}

const ITEMS: MenuItem[] = [
  { key: "lookup", label: "Look it up", kind: "screen", perms: [] },
  { key: "deliveries", label: "Deliveries", kind: "screen", perms: [] },
  // A quote is the one document a customer chases somebody about away from
  // the counter — "can you send it to me again" — and until now the only
  // copy lived on a till in the shop. Either permission is enough: a cashier
  // who wrote it, or a manager who is being asked about it.
  { key: "quotes", label: "Quotes", kind: "screen", perms: ["take_payments", "view_reports"] },
  { key: "stock", label: "Stock", kind: "screen", perms: ["manage_inventory"] },
  { key: "shelf", label: "Shelf", kind: "tab", perms: ["shelf_capture", "manage_catalogue"], camera: true },
  { key: "catalogue", label: "Catalogue", kind: "tab", perms: ["manage_catalogue"] },
  { key: "approvals", label: "Approvals", kind: "tab", perms: ["approve_discount"] },
  { key: "sales", label: "Sales", kind: "tab", perms: ["view_reports"] },
  { key: "suppliers", label: "Suppliers", kind: "tab", perms: ["manage_purchasing"] },
  { key: "buying", label: "Buying", kind: "tab", perms: ["manage_purchasing"] },
  { key: "cashup", label: "Cash-up", kind: "tab", perms: ["cash_management"] },
  { key: "reports", label: "Reports", kind: "tab", perms: ["view_reports"] },
  { key: "tillai", label: "TillAI", kind: "tab", perms: ["view_reports"] },
  { key: "staff", label: "Staff", kind: "tab", perms: ["manage_staff"] },
];

/**
 * What this person may open on this device. The RPC behind each destination
 * re-checks the permission anyway; this is so nobody is shown a door that
 * will only refuse them.
 */
export function menuItems(user: User, camera: boolean): MenuItem[] {
  return ITEMS.filter((i) => {
    if (i.camera && !camera) return false;
    return i.perms.length === 0 || canAny(user, i.perms);
  });
}

/** Whether this person can open anything at all behind the PIN. */
export function hasBackOffice(user: User): boolean {
  return ITEMS.some((i) => i.kind === "tab" && i.perms.some((p) => can(user, p)));
}
