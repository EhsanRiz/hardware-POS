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

/** A section of Manage. Lives here because two screens must agree on the list. */
export type TabKey =
  | "catalogue" | "import" | "shelf" | "sales" | "suppliers" | "buying"
  | "approvals" | "cashup" | "reports" | "tillai" | "staff" | "shop";

/**
 * The sections of Manage this person may actually open, on THIS device.
 *
 * One list, read by the back office to draw its tabs and by the till to decide
 * whether to offer the Manage button at all. They were two lists and they
 * disagreed: the button asked for manage_catalogue OR manage_inventory OR
 * shelf_capture, and manage_inventory opens nothing in here — Stock is a
 * screen on the till, not a section of Manage. So a storeman on a counter
 * machine with no camera was shown a door into an empty room, and the room
 * then defaulted to the catalogue.
 */
export function backOfficeTabs(
  user: User,
  where: { camera: boolean; phone: boolean }
): { key: TabKey; label: string }[] {
  const t: { key: TabKey; label: string }[] = [];
  // Catalogue and Bulk import were unconditional, which was harmless while
  // everybody who could open Manage held manage_catalogue. The shelf grant
  // ends that: somebody whose only right is photographing shelves must not
  // be shown a catalogue screen that would only refuse them.
  if (can(user, "manage_catalogue")) {
    t.push({ key: "catalogue", label: "Catalogue" });
    // Bulk import is a CSV file picker and a column-mapping table. That is
    // desktop work, and offering it on a phone only wastes a tap.
    if (!where.phone) t.push({ key: "import", label: "Bulk import" });
  }
  // Photographing a shelf needs a lens. The shop's counter machine is a
  // PinnPOS all-in-one with no camera in it, so this was a tab that could
  // only ever say no — while the same screen sat one tap away on the phone,
  // which is where the work actually happens. Gated on the CAMERA and not on
  // the device's kind: a counter running on an iPad keeps it.
  if (where.camera && (can(user, "shelf_capture") || can(user, "manage_catalogue"))) {
    t.push({ key: "shelf", label: "Shelf" });
  }
  if (can(user, "view_reports")) t.push({ key: "sales", label: "Sales" });
  // The drawer of supplier paperwork, for whoever does the buying.
  if (can(user, "manage_purchasing")) t.push({ key: "suppliers", label: "Suppliers" });
  // Ordering, and what is owed for it. Its own tab rather than a corner of
  // Suppliers: filing a supplier's paperwork and deciding what to buy are
  // done by the same person at completely different moments.
  if (can(user, "manage_purchasing")) t.push({ key: "buying", label: "Buying" });
  // ON THE PHONE ONLY, and the clue was always in the description: issuing a
  // code is something a manager does standing in a bank queue with a phone to
  // their ear. The whole point of the code is that they are NOT at the till —
  // a manager standing at the counter types their PIN into the discount
  // dialog and no code exists. So a till was offering a screen whose reason
  // for existing is the till not being there.
  if (where.phone && can(user, "approve_discount")) {
    t.push({ key: "approvals", label: "Approvals" });
  }
  // Cash-up stays on a phone, but as history only: counting a drawer needs
  // the cash in hand (see CashUp). What a manager wants from away is
  // whether last night closed clean.
  if (can(user, "cash_management")) t.push({ key: "cashup", label: "Cash-up" });
  if (can(user, "view_reports")) t.push({ key: "reports", label: "Reports" });
  if (can(user, "view_reports")) t.push({ key: "tillai", label: "TillAI" });
  if (can(user, "manage_staff")) t.push({ key: "staff", label: "Staff" });
  // The shop's address, VAT number and printer width: set once, on a
  // keyboard, and never from an aisle.
  if (can(user, "manage_settings") && !where.phone) t.push({ key: "shop", label: "Shop" });
  return t;
}

/**
 * Whether there is anything at all behind the PIN for this person, here.
 *
 * The button and the room answer from the same list, so a door that opens on
 * nothing cannot exist.
 */
export function hasBackOffice(
  user: User, where: { camera: boolean; phone: boolean }
): boolean {
  return backOfficeTabs(user, where).length > 0;
}
