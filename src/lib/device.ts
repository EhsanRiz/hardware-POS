// The till's own identity.
//
// A manager pairs the tablet once (Settings → Pair this till) and the server
// hands back a random token. It lives here, on the device, and is what lets a
// sale taken during an outage sync hours later without anyone's PIN — the one
// thing the cafe build could not do safely.
//
// The token identifies the *register*, not a person: every sale still records
// which cashier rang it up, and their permissions are still checked server-side.
// Losing the tablet means revoking one token rather than rotating every PIN.
import { cacheClearExcept, cacheGet, cacheRemove, cacheSet } from "./localCache";

const TOKEN_KEY = "device.registerToken";
const NAME_KEY = "device.registerName";
const ID_KEY = "device.registerId";
/**
 * What kind of device this is (0074).
 *
 * A till is the counter screen: it takes money and anybody on the staff can
 * sign in on it. A personal device is somebody's own phone, for the work that
 * happens away from the counter — photographing a supplier's quotation,
 * approving a discount, deciding what to buy. It belongs to one person, only
 * that person can sign in on it, and the DATABASE refuses money on it. This
 * value only decides which screen to show; it is not what makes any of that
 * true, so a tampered cache buys nothing.
 */
const KIND_KEY = "device.kind";

type Listener = () => void;
const listeners = new Set<Listener>();

export function onPairingChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The register token, or null when this device has not been paired. */
export function registerToken(): string | null {
  return cacheGet<string | null>(TOKEN_KEY, null);
}

export function isPaired(): boolean {
  return !!registerToken();
}

export function registerName(): string {
  return cacheGet<string>(NAME_KEY, "Till");
}

export function registerId(): string | null {
  return cacheGet<string | null>(ID_KEY, null);
}

export type DeviceKind = "till" | "personal";

/** Which shape of app this device gets. Defaults to a till, as it always was. */
export function deviceKind(): DeviceKind {
  return cacheGet<DeviceKind>(KIND_KEY, "till");
}

export function savePairing(
  id: string, token: string, name: string, kind: DeviceKind = "till"
): void {
  cacheSet(ID_KEY, id);
  cacheSet(TOKEN_KEY, token);
  cacheSet(NAME_KEY, name);
  cacheSet(KIND_KEY, kind);
  listeners.forEach((l) => l());
}

/**
 * Forget the pairing on this device. Does not revoke the token server-side —
 * a lost tablet should be revoked from Settings on another device, which is
 * what actually stops it selling.
 */
export function clearPairing(): void {
  // Not only the pairing: everything the device learned about the shop goes
  // with it — the roster, the offline credential hashes, the settings, the
  // session — so a tablet paired to another shop next starts clean. Only the
  // sale queues survive, because they are money; unpairing is refused while
  // they hold anything, so they are empty here in practice.
  cacheClearExcept(["queue.sales", "queue.failed"]);
  cacheRemove(ID_KEY);
  cacheRemove(TOKEN_KEY);
  cacheSet(NAME_KEY, "Till");
  cacheSet(KIND_KEY, "till");
  listeners.forEach((l) => l());
}
