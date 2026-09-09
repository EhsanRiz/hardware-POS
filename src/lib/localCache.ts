// Tiny typed wrapper around localStorage for offline caches and queues.
// Everything is namespaced and JSON-encoded, and every call is guarded so a
// full / unavailable store (private mode, quota) never crashes the till.

const PREFIX = "pos.";

export function cacheGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function cacheSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Out of space / unavailable — caches are best-effort, so swallow.
  }
}

export function cacheRemove(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/**
 * Forget everything cached under the namespace except the keys named.
 *
 * Used when a device leaves a shop. What the till caches — the roster, the
 * credential hashes that let people sign in offline, the shop's own settings,
 * the signed-in session — belongs to that shop, and a tablet paired to a
 * second shop must not carry the first shop's staff and details across with
 * it. The queues are the exception: they hold sales, which are money, and are
 * never deleted quietly; unpairing is refused while they are non-empty.
 */
export function cacheClearExcept(keep: string[]): void {
  try {
    const keepFull = new Set(keep.map((k) => PREFIX + k));
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX) && !keepFull.has(k)) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
