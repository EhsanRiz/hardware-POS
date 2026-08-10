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
import { cacheGet, cacheSet } from "./localCache";

const TOKEN_KEY = "device.registerToken";
const NAME_KEY = "device.registerName";
const ID_KEY = "device.registerId";

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

export function savePairing(id: string, token: string, name: string): void {
  cacheSet(ID_KEY, id);
  cacheSet(TOKEN_KEY, token);
  cacheSet(NAME_KEY, name);
  listeners.forEach((l) => l());
}

/**
 * Forget the pairing on this device. Does not revoke the token server-side —
 * a lost tablet should be revoked from Settings on another device, which is
 * what actually stops it selling.
 */
export function clearPairing(): void {
  cacheSet(ID_KEY, null);
  cacheSet(TOKEN_KEY, null);
  cacheSet(NAME_KEY, "Till");
  listeners.forEach((l) => l());
}
