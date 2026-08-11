/**
 * The till's own origin, and the only host it ever talks to.
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
}

/** Supabase's public API surfaces. Anything else under /api/ is refused. */
const ALLOWED = ["/rest/", "/auth/", "/functions/", "/storage/", "/realtime/"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
