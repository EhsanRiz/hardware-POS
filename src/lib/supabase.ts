import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
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

export const supabase = createClient(url, anonKey, {
  auth: {
    // We use PIN-based login via RPC, not Supabase Auth sessions.
    persistSession: false,
    autoRefreshToken: false,
  },
  global: { fetch: fetchWithTimeout },
});
