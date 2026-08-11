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
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

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
