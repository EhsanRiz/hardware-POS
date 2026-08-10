import { useEffect, useState } from "react";

// Network status. navigator.onLine is a coarse and often UNRELIABLE signal on
// tablets — it can get stuck at "offline" after sleep/wake or a brief Wi-Fi
// blip even though the internet is fine, which would wrongly freeze the till and
// stop syncing. So instead of trusting it, we actively probe whether the
// Supabase server is reachable and use that as the source of truth. Reaching the
// server at all (any HTTP response) counts as online; only a real network
// failure counts as offline.

const PROBE_URL = `${import.meta.env.VITE_SUPABASE_URL}/auth/v1/health`;
const PROBE_INTERVAL_MS = 15000;
const PROBE_TIMEOUT_MS = 6000;

let online = typeof navigator === "undefined" ? true : navigator.onLine;
let probing = false;

type Listener = (online: boolean) => void;
const listeners = new Set<Listener>();

function setOnline(v: boolean): void {
  if (v === online) return;
  online = v;
  listeners.forEach((l) => l(online));
}

// Returns true if the server responded at all (even an error status), false on a
// genuine connectivity failure (DNS/timeout/abort).
async function probe(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    // no-cors: we only care that the server ANSWERED, not what it said, so CORS
    // can never make a reachable server look offline.
    await fetch(`${PROBE_URL}?t=${Date.now()}`, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    return true;
  } catch {
    return false;
  }
}

async function refresh(): Promise<void> {
  if (probing) return;
  probing = true;
  try {
    setOnline(await probe());
  } finally {
    probing = false;
  }
}

if (typeof window !== "undefined") {
  // The browser's own events are only hints now — always re-check by probing.
  window.addEventListener("online", () => void refresh());
  window.addEventListener("offline", () => void refresh());
  // Tablets fire these when waking / returning to the app — a good time to
  // recover a stuck "offline".
  window.addEventListener("focus", () => void refresh());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  // Steady heartbeat so a wrongly-stuck state self-corrects quickly.
  setInterval(() => void refresh(), PROBE_INTERVAL_MS);
  // Confirm the real state shortly after load.
  setTimeout(() => void refresh(), 800);
}

export function isOnline(): boolean {
  return online;
}

/** Force an immediate connectivity re-check (e.g. after a user action). */
export function recheckOnline(): void {
  void refresh();
}

/** Subscribe to online/offline transitions. Returns an unsubscribe function. */
export function onNetworkChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React hook: re-renders when connectivity changes. */
export function useOnline(): boolean {
  const [state, setState] = useState(online);
  useEffect(() => onNetworkChange(setState), []);
  return state;
}

// True when an error looks like a connectivity failure (fetch abort/timeout or
// the browser being offline) rather than a real server-side rejection. Used to
// decide whether to queue an action for later instead of surfacing an error.
export function isNetworkError(err: unknown): boolean {
  if (!isOnline()) return true;
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    return (
      err.name === "AbortError" ||
      err.name === "TypeError" || // fetch network failure
      m.includes("failed to fetch") ||
      m.includes("network") ||
      m.includes("load failed") ||
      m.includes("timeout")
    );
  }
  return false;
}

// True when the server doesn't (yet) have the RPC we called — e.g. the frontend
// was deployed before the offline migration was applied. Lets callers fall back
// to the legacy path so the till keeps working regardless of deploy order.
export function isMissingRpcError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  const msg = (e.message ?? "").toLowerCase();
  return (
    e.code === "PGRST202" ||
    msg.includes("could not find the function") ||
    msg.includes("does not exist")
  );
}
