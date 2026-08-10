// Offline-capable PIN sign-in.
//
// Online, we always verify against the server (pos_login, bcrypt). On a
// successful online login we cache a PBKDF2 hash of that PIN on the device, so
// the same staff member can still sign in while the connection is down. New
// staff who have never logged in online on this tablet cannot sign in offline.
//
// Security note: a 4-digit PIN is inherently low-entropy, and any offline-login
// scheme necessarily stores something on the device that can verify it. We use
// a per-credential random salt + PBKDF2 (150k iterations) so a stolen device
// can't read PINs at a glance, but this is a shop tablet trade-off, not a
// high-security vault.
import { login as serverLogin } from "./api";
import { cacheGet, cacheSet } from "./localCache";
import { isOnline, isNetworkError } from "./offline";
import type { User } from "./types";

const CREDS_KEY = "auth.creds";
const ITERATIONS = 150_000;

interface Credential {
  user: User;
  salt: string; // hex
  hash: string; // hex
  iter: number;
  cachedAt: string;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSaltHex(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return toHex(a.buffer);
}

async function derive(pin: string, saltHex: string, iter: number): Promise<string> {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(
    saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16))
  );
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    key,
    256
  );
  return toHex(bits);
}

async function cacheCredential(pin: string, user: User): Promise<void> {
  const salt = randomSaltHex();
  const hash = await derive(pin, salt, ITERATIONS);
  const creds = cacheGet<Credential[]>(CREDS_KEY, []).filter(
    (c) => c.user.id !== user.id
  );
  creds.push({ user, salt, hash, iter: ITERATIONS, cachedAt: new Date().toISOString() });
  cacheSet(CREDS_KEY, creds);
}

/** Verify a PIN against the on-device credential cache (offline path). */
export async function verifyPinOffline(pin: string): Promise<User | null> {
  const creds = cacheGet<Credential[]>(CREDS_KEY, []);
  for (const c of creds) {
    const hash = await derive(pin, c.salt, c.iter);
    if (hash === c.hash) return c.user;
  }
  return null;
}

/**
 * Sign in by PIN. Tries the server when online (and refreshes the offline
 * credential), and falls back to the cached credential when the network is
 * unavailable. Returns null for a genuinely wrong PIN.
 */
export async function signIn(pin: string): Promise<User | null> {
  if (isOnline()) {
    try {
      const user = await serverLogin(pin);
      if (user) await cacheCredential(pin, user);
      return user;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      // Network died mid-attempt — fall through to the offline check.
    }
  }
  return verifyPinOffline(pin);
}
