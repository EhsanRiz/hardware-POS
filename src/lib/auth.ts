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
import { login as serverLogin, staffForLogin } from "./api";
import { cacheGet, cacheSet } from "./localCache";
import { isOnline, isNetworkError } from "./offline";
import type { LoginCandidate, User } from "./types";

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

/**
 * Verify a PIN against this person's cached credential (offline path).
 *
 * Keyed by who is signing in, not searched across everybody. The old version
 * walked every cached credential and returned the first PIN that matched, which
 * is the same flaw the server had: two people sharing six digits meant the
 * second became the first, on the device as well as in the database.
 */
export async function verifyPinOffline(
  userId: string,
  pin: string
): Promise<User | null> {
  const cred = cacheGet<Credential[]>(CREDS_KEY, []).find(
    (c) => c.user.id === userId
  );
  if (!cred) return null;
  const hash = await derive(pin, cred.salt, cred.iter);
  return hash === cred.hash ? cred.user : null;
}

/**
 * Find a manager by PIN alone, for an over-the-shoulder approval.
 *
 * Sign-in asks who you are first; this cannot, because a manager leans over a
 * colleague's till and types a PIN with a customer waiting. So it searches —
 * but it refuses when the PIN matches more than one cached person rather than
 * returning whichever came first, which would put somebody else's name against
 * the approval. The server applies the same rule.
 */
export async function findByPinOffline(pin: string): Promise<User | null> {
  const creds = cacheGet<Credential[]>(CREDS_KEY, []);
  const hits: User[] = [];
  for (const c of creds) {
    const hash = await derive(pin, c.salt, c.iter);
    if (hash === c.hash) hits.push(c.user);
  }
  if (hits.length > 1) {
    throw new Error(
      "That PIN belongs to more than one person. Change one of them before using it."
    );
  }
  return hits[0] ?? null;
}

/** Whether this person has ever signed in online on this till. */
export function canSignInOffline(userId: string): boolean {
  return cacheGet<Credential[]>(CREDS_KEY, []).some((c) => c.user.id === userId);
}

const ROSTER_KEY = "auth.roster";

/**
 * Who to offer on the sign-in screen.
 *
 * Refreshed from the server whenever it can be, and cached so the list is still
 * there with the line down — a till that cannot name its own staff cannot let
 * anybody start a shift, and the whole point of this app is that it keeps
 * selling through an outage.
 */
export async function loginRoster(): Promise<LoginCandidate[]> {
  if (isOnline()) {
    try {
      const staff = await staffForLogin();
      if (staff.length > 0) cacheSet(ROSTER_KEY, staff);
      return staff;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  return cacheGet<LoginCandidate[]>(ROSTER_KEY, []);
}

/**
 * Sign in as a named person. Tries the server when online (and refreshes the
 * offline credential), and falls back to that person's cached credential when
 * the network is unavailable. Returns null for a genuinely wrong PIN.
 */
export async function signIn(userId: string, pin: string): Promise<User | null> {
  if (isOnline()) {
    try {
      const user = await serverLogin(userId, pin);
      if (user) await cacheCredential(pin, user);
      return user;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      // Network died mid-attempt — fall through to the offline check.
    }
  }
  return verifyPinOffline(userId, pin);
}
