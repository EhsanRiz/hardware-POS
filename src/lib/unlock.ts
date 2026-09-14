import { canAny, can } from "./permissions";
import type { User } from "./types";

/**
 * A PIN proved at a door, kept for a few minutes.
 *
 * Manage and the stock room each ask for a PIN, and each used to forget it the
 * moment its screen closed. Look at a delivery, then the catalogue, then the
 * approvals and you typed six digits three times in a minute — for the same
 * person, on the same device, proving the same thing each time. Nothing was
 * gained by it: every RPC behind those doors re-verifies the PIN server-side,
 * so the door is not what keeps anyone out. What the door is for is the tablet
 * left face-up on the counter, and that is a question about TIME, not about
 * how many screens have been opened since.
 *
 * So: proved once, good for a while, and the while rolls forward each time it
 * is used. Put the device down for longer than that and the next door asks
 * again.
 *
 * In memory only, and deliberately. A six-digit PIN written to storage,
 * however hashed, is a credential sitting on the handset; this shop's rule
 * from the beginning is that no device holds one. A reload forgets everything
 * here, which is the correct behaviour and not a limitation.
 */
const KEEP_MS = 10 * 60_000;

/** The doors. Separate, because each was proved by its own kind of call. */
export type Door = "admin" | "stock";

/** What a PIN must open something behind, for the back office to be worth it. */
export const BACK_OFFICE = [
  "manage_catalogue", "manage_inventory", "shelf_capture", "manage_purchasing",
  "approve_discount", "view_reports", "manage_staff", "manage_settings",
  "cash_management",
] as const;

const held = new Map<Door, { pin: string; at: number }>();

/** This PIN was just proved at this door. */
export function remember(door: Door, pin: string): void {
  held.set(door, { pin, at: Date.now() });
}

/**
 * The PIN still good at this door, or null to ask for it.
 *
 * Using it rolls the clock: somebody working through the back office is not
 * interrupted at the ten-minute mark, and a device nobody has touched since
 * is shut whatever was open on it.
 */
export function recall(door: Door): string | null {
  const it = held.get(door);
  if (!it) return null;
  if (Date.now() - it.at >= KEEP_MS) {
    held.delete(door);
    return null;
  }
  it.at = Date.now();
  return it.pin;
}

/** Sign-out. Nothing survives one person leaving the device. */
export function forgetPins(): void {
  held.clear();
}

/**
 * A phone's owner has just proved their PIN — at sign-in, or at the lock
 * screen after the phone was put away — so the doors they are entitled to
 * open stand open.
 *
 * A phone is one person's, which is the whole difference: the till is shared
 * and watched, and its doors are asked for on their own. Here the PIN was
 * proved against the server moments ago, by the same check the door would
 * make; asking for the identical six digits twice in ten seconds proves
 * nothing except that the app was not paying attention. Permissions are
 * untouched by any of this — the server still decides what each call may do.
 */
export function ownerProved(user: User, pin: string): void {
  if (canAny(user, [...BACK_OFFICE])) remember("admin", pin);
  if (can(user, "manage_inventory")) remember("stock", pin);
}
