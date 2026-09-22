import { createClient } from "@supabase/supabase-js";

/**
 * Where the backend lives, from the browser's point of view.
 *
 * The till talks to its OWN origin and nothing else: /api/... is reverse-proxied
 * to Supabase by worker/index.ts. Calling the Supabase host directly makes every
 * request third-party, and a shop counter is exactly where third-party requests
 * get eaten — by an ad blocker, an antivirus web-shield, or the mall's Wi-Fi
 * filter. We watched that happen: POSTs answered with 405 by something in the
 * middle while the server itself was provably healthy.
 *
 * A same-origin request also skips the CORS preflight, so every backend call is
 * one round trip instead of two.
 *
 * VITE_SUPABASE_URL remains the upstream for local development (vite proxies
 * /api to it) and the fallback for contexts with no http origin — the
 * single-file demo build opened from disk, where the backend is stubbed anyway.
 */
const configured = import.meta.env.VITE_SUPABASE_URL;
const sameOrigin =
  typeof location !== "undefined" && location.origin.startsWith("http")
    ? `${location.origin}/api`
    : null;

export const API_BASE: string = sameOrigin ?? configured;
/**
 * The publishable key, which is public by design — it ships in this bundle and
 * is meant to. Exported because the connectivity probe needs it too: Supabase
 * answers /auth/v1/health with 401 to a request that carries no key, and a
 * till that logs an error every fifteen seconds teaches its shop to ignore the
 * console. See lib/offline.ts.
 */
export const ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY;
const anonKey = ANON_KEY;

if (!API_BASE || !anonKey) {
  // Surfaced loudly so a misconfigured tablet fails fast instead of silently.
  throw new Error(
    "Missing Supabase config. Copy .env.example to .env and fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
  );
}

// Fail a stalled request after 20s instead of letting the UI hang forever
// (the #1 cause of a "frozen" till on flaky Wi-Fi). Respects any caller signal.
const REQUEST_TIMEOUT_MS = 20000;
const fetchWithTimeout: typeof fetch = (input, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const external = init?.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
};

export const supabase = createClient(API_BASE, anonKey, {
  auth: {
    // We use PIN-based login via RPC, not Supabase Auth sessions.
    persistSession: false,
    autoRefreshToken: false,
  },
  global: { fetch: fetchWithTimeout },
});

/**
 * A storage URL, brought back to the till's own origin.
 *
 * Signed URLs are the one thing that escaped the rule above. `createSignedUrl`
 * hands back an absolute address on the Supabase host, and the browser then
 * fetches it directly — the archived quotation, and the pages of a filed
 * supplier document. That is a third-party request from a shop counter, which
 * is precisely what this file exists to avoid: an ad blocker, an antivirus
 * web-shield or a mall's Wi-Fi filter eats it and the shop sees a document
 * that will not open, or worse, one silently rebuilt from today's letterhead.
 *
 * The Worker already proxies /storage/, and the signature travels in the query
 * string, so the same URL works perfectly well pointed at our own origin. It
 * is also what lets the Content-Security-Policy say connect-src 'self' and
 * mean it.
 *
 * Anything that is not an http(s) storage URL is handed back untouched.
 */
export function ownOrigin(url: string): string {
  if (!/^https?:/i.test(url)) return url;
  try {
    const u = new URL(url);
    if (!u.pathname.startsWith("/storage/")) return url;
    return `${API_BASE}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
