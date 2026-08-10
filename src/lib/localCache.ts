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
