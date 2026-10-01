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
//
// Two limits on the offline path, both added with staff badges (0128) because
// 5 Star and the shops like it spend whole days with the line down:
//
//   * SEVEN DAYS. A till that has not reached the server for a week stops
//     signing anybody in offline, by PIN or by badge. What it holds is a copy,
//     and a copy cannot hear that somebody left, changed their PIN or lost
//     their card. A week rides out a bad stretch of line; it does not let a
//     sacked cashier's card work for ever on a till that never reconnects.
//
//   * A WAIT AFTER WRONG PINS. The server locks a person out after five wrong
//     PINs (0033). Offline there was nothing: a person could try PIN after PIN
//     at a till with the line down. Now the fifth wrong one costs thirty
//     seconds, and each after it doubles that, to fifteen minutes. Kept on the
//     device, so a reload does not reset it.
import {
  badgeLogin, login as serverLogin, staffBadgesForTill, staffForLogin,
} from "./api";
import { cacheGet, cacheSet } from "./localCache";
import { isOnline, isNetworkError } from "./offline";
import type { LoginCandidate, User } from "./types";

const CREDS_KEY = "auth.creds";
const ITERATIONS = 150_000;

/** The last time this device heard from the server about who may sign in. */
const CONTACT_KEY = "auth.lastContact";
/** How long a till may go without that before it stops signing people in offline. */
export const OFFLINE_DAYS = 7;
const OFFLINE_MS = OFFLINE_DAYS * 24 * 60 * 60_000;

export const STALE_MESSAGE =
  `This till has not reached the server for over ${OFFLINE_DAYS} days, ` +
  "so it cannot sign anybody in until the line is back.";

/** The server just answered a sign-in question. */
export function noteContact(): void {
  cacheSet(CONTACT_KEY, new Date().toISOString());
}

/**
 * When the device last heard from the server. A till upgraded from before this
 * was kept has no stamp, so its newest cached credential stands in — that was
 * written by an online sign-in, which is the same thing.
 */
function lastContact(): number {
  const stamp = cacheGet<string | null>(CONTACT_KEY, null);
  const times = [stamp, ...cacheGet<Credential[]>(CREDS_KEY, []).map((c) => c.cachedAt)]
    .map((t) => (t ? Date.parse(t) : 0))
    .filter((t) => Number.isFinite(t));
  return Math.max(0, ...times);
}

/** Too long without the server to trust what this device remembers. */
export function offlineExpired(now = Date.now()): boolean {
  return now - lastContact() > OFFLINE_MS;
}

const FAILS_KEY = "auth.pinFails";
interface Fails { n: number; at: number }

/** How long to wait after n wrong PINs in a row. */
function failWait(n: number): number {
  if (n < 5) return 0;
  return Math.min(30_000 * 2 ** (n - 5), 15 * 60_000);
}

/** Milliseconds before this person may try another PIN offline. */
export function offlineWaitMs(userId: string, now = Date.now()): number {
  const f = cacheGet<Record<string, Fails>>(FAILS_KEY, {})[userId];
  if (!f) return 0;
  return Math.max(0, f.at + failWait(f.n) - now);
}

function recordFail(userId: string): void {
  const all = cacheGet<Record<string, Fails>>(FAILS_KEY, {});
  all[userId] = { n: (all[userId]?.n ?? 0) + 1, at: Date.now() };
  cacheSet(FAILS_KEY, all);
}

function clearFails(userId: string): void {
  const all = cacheGet<Record<string, Fails>>(FAILS_KEY, {});
  if (!(userId in all)) return;
  delete all[userId];
  cacheSet(FAILS_KEY, all);
}

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

/**
 * Keep a PIN the server has just vouched for, as a sign-in would. Used by the
 * discount prompt (0128), where a manager's PIN can be proved online on a
 * till they have never signed in on with it — by badge, say.
 */
export async function rememberPin(pin: string, user: User): Promise<void> {
  await cacheCredential(pin, user);
  noteContact();
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
  if (offlineExpired()) throw new Error(STALE_MESSAGE);
  const wait = offlineWaitMs(userId);
  if (wait > 0) {
    throw new Error(
      `Too many wrong PINs for ${cred.user.name}. Try again in ${Math.ceil(wait / 1000)} seconds.`
    );
  }
  const hash = await derive(pin, cred.salt, cred.iter);
  if (hash !== cred.hash) {
    recordFail(userId);
    return null;
  }
  clearFails(userId);
  return cred.user;
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
  // The same week as sign-in: a manager who has left must not go on approving
  // discounts on a till that has not heard so.
  if (creds.length > 0 && offlineExpired()) throw new Error(STALE_MESSAGE);
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
      if (staff.length > 0) {
        cacheSet(ROSTER_KEY, staff);
        // Somebody no longer on the list takes their offline PIN with them.
        // Without this a person made inactive could still sign in here with
        // the line down, for as long as the copy of their PIN survived.
        const ids = new Set(staff.map((c) => c.id));
        cacheSet(
          CREDS_KEY,
          cacheGet<Credential[]>(CREDS_KEY, []).filter((c) => ids.has(c.user.id))
        );
        noteContact();
      }
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
      if (user) {
        await cacheCredential(pin, user);
        clearFails(userId);
        noteContact();
      }
      return user;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      // Network died mid-attempt — fall through to the offline check.
    }
  }
  return verifyPinOffline(userId, pin);
}

// --- Staff badges (0128) -----------------------------------------------------

const BADGES_KEY = "auth.badges";

/** "STAFF-" and fourteen characters, as pos_staff_badge_issue makes them. */
const BADGE_RE = /^STAFF-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{14}$/;

/** A scanned string as a badge code, or null if it is not one. */
export function asBadge(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return BADGE_RE.test(code) ? code : null;
}

/** Anything wearing the badge prefix, valid or not — never a product code. */
export function looksLikeBadge(raw: string): boolean {
  return /^STAFF-/i.test(raw.trim());
}

interface CachedBadge { hash: string; user: User }

async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/**
 * Fetch the shop's live badges, so a scan can be checked with the line down.
 *
 * Replaced whole, empty included: a badge missing from the server's answer
 * has been cancelled, and must stop working here as soon as this till hears.
 * Quietly does nothing without a line — the copy already held stands.
 */
export async function refreshBadges(): Promise<void> {
  if (!isOnline()) return;
  try {
    const rows = await staffBadgesForTill();
    cacheSet(
      BADGES_KEY,
      rows.map(({ code_hash, ...user }): CachedBadge => ({ hash: code_hash, user }))
    );
    noteContact();
  } catch {
    // Best effort, like every other cache; the next refresh tries again.
  }
}

/** Whether this device knows of any badge at all, to say "or scan" or not. */
export function knowsBadges(): boolean {
  return cacheGet<CachedBadge[]>(BADGES_KEY, []).length > 0;
}

/**
 * Who a scanned badge signs in, or null if it is nobody's.
 *
 * The server decides whenever it can be reached, and a "no" from it is final
 * — the copy here may still hold a card cancelled a minute ago. Offline, the
 * copy decides, for up to a week since this till last heard from the server.
 */
export async function signInWithBadge(raw: string): Promise<User | null> {
  const code = asBadge(raw);
  if (!code) return null;
  if (isOnline()) {
    try {
      const user = await badgeLogin(code);
      noteContact();
      return user;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  if (offlineExpired()) throw new Error(STALE_MESSAGE);
  const hash = await sha256Hex(code);
  return cacheGet<CachedBadge[]>(BADGES_KEY, []).find((b) => b.hash === hash)?.user ?? null;
}
