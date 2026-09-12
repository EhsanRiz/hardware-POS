/**
 * The till's own origin, and the only host it ever talks to.
 *
 * Served at till.innovaearth.com; app.innovaearth.com, its old address, still
 * answers and sends people on (see redirectFor).
 *
 * Everything under /api/ is forwarded to the Supabase project; everything else
 * is the built app, served from the ASSETS binding.
 *
 * WHY THIS EXISTS. The client used to call the Supabase host directly, which
 * makes every request a third-party request from the browser's point of view.
 * That is fine on a developer's laptop and fragile on a shop counter: ad
 * blockers, antivirus web-shields, school and mall Wi-Fi filters, and
 * corporate proxies all routinely block or rewrite calls to a domain they do
 * not recognise. We hit exactly that — POSTs to supabase.co were being
 * answered with 405 by something between the browser and the server, while the
 * server itself was provably healthy.
 *
 * Talking only to the shop's own domain removes that whole class of failure,
 * and takes CORS preflights out of the hot path as a side effect: a same-origin
 * request never sends one, so every call to the till's backend is now one round
 * trip instead of two.
 *
 * This is a reverse proxy for ONE project, not an open relay: the upstream host
 * is fixed in wrangler.toml and only Supabase's own API prefixes are forwarded.
 */

interface Env {
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

/** Supabase's public API surfaces. Anything else under /api/ is refused. */
const ALLOWED = ["/rest/", "/auth/", "/functions/", "/storage/", "/realtime/"];

/**
 * The till's address, and the address it used to have.
 *
 * It moved from app.innovaearth.com to till.innovaearth.com: "app" is the
 * suite's most generic word and can only ever be one of its products, and
 * "till" is what the product calls itself. The old host stays attached to
 * this Worker and sends people to the new one — but only PEOPLE. A till that
 * was paired on the old address keeps its token in that origin's storage,
 * and until it is re-paired it must go on working: its API calls, its
 * assets and its service-worker update checks all still come to the old
 * host, and a redirect on any of those would break it (a 301 turns a POST
 * into a GET; a script that redirects cross-origin will not load). So only
 * a navigation — a typed address, a bookmark, a link in an old SMS — is
 * redirected. The installed app on the old origin serves its own shell from
 * the service worker and never navigates, so it is untouched until the
 * manager re-pairs it at their own pace.
 */
export const TILL_HOST = "till.innovaearth.com";
export const OLD_HOSTS = ["app.innovaearth.com"];

export function redirectFor(url: URL, headers: Headers): Response | null {
  if (!OLD_HOSTS.includes(url.hostname)) return null;
  if (url.pathname.startsWith("/api/")) return null;
  const navigating =
    headers.get("sec-fetch-mode") === "navigate" ||
    (headers.get("accept") ?? "").includes("text/html");
  if (!navigating) return null;
  const to = new URL(url.toString());
  to.protocol = "https:";
  to.hostname = TILL_HOST;
  to.port = "";
  return Response.redirect(to.toString(), 301);
}

/**
 * The nightly line. Once a day (wrangler.toml, [triggers]) this Worker asks
 * the error-digest function to send InnovaEarth what the tills reported and
 * asked in the last day. The public key is all it needs: the function keeps
 * its own once-a-day memory, so an extra call cannot send an extra email.
 */
export function digestRequest(env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string }): Request {
  return new Request(`${env.SUPABASE_URL}/functions/v1/error-digest`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
}

export default {
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(fetch(digestRequest(env)).then((r) => {
      if (!r.ok) console.error("error-digest", r.status);
    }));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const moved = redirectFor(url, request.headers);
    if (moved) return moved;

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const path = url.pathname.slice("/api".length);
    if (!ALLOWED.some((p) => path.startsWith(p))) {
      return new Response("Not found", { status: 404 });
    }

    const target = new URL(env.SUPABASE_URL);
    target.pathname = path;
    target.search = url.search;

    // Copying the Request preserves method, headers and body — including the
    // apikey the client sends. Redirects are followed manually so a 30x can
    // never turn a POST into a GET behind our back.
    const upstream = new Request(target.toString(), request);
    upstream.headers.delete("host");

    const res = await fetch(upstream, { redirect: "manual" });

    // The body is streamed straight back. Headers are copied so PostgREST's
    // Content-Range and error details survive the hop.
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  },
};
