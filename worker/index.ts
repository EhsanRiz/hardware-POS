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
  /** Shared with the error-digest function; a Worker secret, not a var. */
  DIGEST_SECRET?: string;
  /** Shared with the push function; a Worker secret, not a var. */
  PUSH_SECRET?: string;
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
 * asked in the last day. It carries the public key for the gateway and the
 * shared DIGEST_SECRET for the function, which answers nothing without it.
 */
/** The nightly one, as wrangler.toml spells it. */
export const DIGEST_CRON = "0 4 * * *";

export function digestRequest(env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string; DIGEST_SECRET?: string }): Request {
  return new Request(`${env.SUPABASE_URL}/functions/v1/error-digest`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      // The function refuses without it: the public key alone let anybody
      // trigger the digest and read platform-wide counts off the reply.
      "x-digest-secret": env.DIGEST_SECRET ?? "",
    },
    body: "{}",
  });
}

/**
 * The other cron, every few minutes: ask the push function whether any phone
 * needs telling. It decides — quiet hours, nothing new, nobody subscribed —
 * and answers how many it sent. Same shape as the digest, same shared-secret
 * rule, and the same refusal to do anything at all without one.
 */
export function pushRequest(env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string; PUSH_SECRET?: string }): Request {
  return new Request(`${env.SUPABASE_URL}/functions/v1/push`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      "x-push-secret": env.PUSH_SECRET ?? "",
    },
    body: "{}",
  });
}

export default {
  async scheduled(event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    // Two crons on one Worker, told apart by which one fired. The nightly
    // digest is the 04:00 one; everything else is the push sweep, so a
    // schedule added later errs towards the harmless of the two.
    const cron = (event as { cron?: string } | null)?.cron;
    if (cron === DIGEST_CRON) {
      ctx.waitUntil(fetch(digestRequest(env)).then((r) => {
        if (!r.ok) console.error("error-digest", r.status);
      }));
      return;
    }
    ctx.waitUntil(fetch(pushRequest(env)).then((r) => {
      if (!r.ok) console.error("push", r.status);
    }));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const moved = redirectFor(url, request.headers);
    if (moved) return moved;

    if (!url.pathname.startsWith("/api/")) {
      return withSecurityHeaders(await env.ASSETS.fetch(request), "app");
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
    return withSecurityHeaders(new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    }), path.startsWith("/storage/") ? "storage" : "api");
  },
};

/**
 * The headers that decide what a page on this origin may do.
 *
 * The till loads nothing from anywhere else: one script bundle, its own
 * CSS and fonts, images from its own storage proxy or a catalogue's own
 * site. So the policy is short and strict, and it is what stands between a
 * string that reached innerHTML and a script on the till's origin, where
 * the register token lives. Inline styles stay allowed — React writes them
 * — and inline scripts do not exist, so they are not.
 *
 * A file from the storage bucket is served under this origin too. Whatever
 * it is, it runs nothing here: sandboxed, sniffing off, and never framed.
 */
export function withSecurityHeaders(res: Response, kind: "app" | "storage" | "api"): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (kind === "app") {
    h.set("Content-Security-Policy", [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self'",
      "connect-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "));
    h.set("X-Frame-Options", "DENY");
    // The shelf screen uses the camera; nothing here uses the rest.
    h.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  } else if (kind === "storage") {
    h.set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'");
    h.set("X-Frame-Options", "DENY");
  }
  return out;
}
