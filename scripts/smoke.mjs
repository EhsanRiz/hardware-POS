/**
 * Did the deploy actually land?
 *
 * `wrangler deploy` exiting 0 is a tool reporting success. It is not a till
 * loading a page, and the difference is not academic: Cloudflare refused a
 * secret edit here with "the latest version of your Worker isn't currently
 * deployed", which is a Worker holding a version nobody is being served. Every
 * suite in this repository is green on such a shop, because every suite runs
 * against a build on localhost and a hand-written fake of the server.
 *
 * This is the one check that looks at the address a cashier types. It fetches
 * the live origin and compares what comes back against the `dist/` that was
 * just built, so a deploy that did not land fails the pipeline that claimed
 * to have done it rather than turning up as "the fix you sent never arrived".
 *
 *   node scripts/smoke.mjs https://till.innovaearth.com [dist]
 *
 * Exits non-zero on the first attempt where any guard is red, having retried
 * a few times first — an edge takes a moment to pick a new version up, and a
 * smoke check that cannot tell "not yet" from "not at all" gets switched off.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** Short, readable, and far past collision by accident. */
export const digest = (buf) =>
  createHash("sha256").update(buf).digest("hex").slice(0, 16);

/**
 * The hashed files a page pulls in, from its own markup.
 *
 * Vite writes the content hash into the filename, so this set IS the build's
 * identity: if the live page names the same files, the live page is this
 * build's page.
 */
export function assetsFrom(html) {
  const found = new Set();
  const re = /(?:src|href)\s*=\s*"(\/assets\/[^"]+)"/g;
  for (let m; (m = re.exec(html)); ) found.add(m[1]);
  return [...found].sort();
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Every guard, in the order they answer "is the shop being served this build".
 *
 * Each returns { name, ok, detail } — detail is what a person needs to act,
 * so it names the thing that differed rather than saying "mismatch".
 */
async function checks(origin, dist, get) {
  const out = [];
  const local = async (p) => readFile(path.join(dist, p));

  // 1. The page a cashier gets names this build's files.
  const liveHtml = await get("/").then((r) => r.text());
  const wantAssets = assetsFrom(await local("index.html").then(String));
  const gotAssets = assetsFrom(liveHtml);
  out.push({
    name: "the live page is this build",
    ok: wantAssets.length > 0 && same(wantAssets, gotAssets),
    detail: wantAssets.length === 0
      ? "the built index.html names no /assets/ files at all"
      : `built ${wantAssets.join(", ")} — served ${gotAssets.join(", ") || "none"}`,
  });

  // 2. And the files it names are byte-for-byte the ones built. A hashed name
  //    that matches while the bytes do not means something between here and
  //    the counter is serving its own copy.
  for (const asset of wantAssets) {
    const want = await local(asset);
    const got = Buffer.from(await get(asset).then((r) => r.arrayBuffer()));
    out.push({
      name: `${asset} is the built file`,
      ok: digest(want) === digest(got),
      detail: `built ${digest(want)} (${want.length} bytes) — served ${digest(got)} (${got.length} bytes)`,
    });
  }

  // 3. The service worker, which is how a till that "updated" keeps running
  //    last week's app. Its precache list changes every build, so a stale one
  //    is visible here and nowhere else.
  for (const file of ["sw.js", "push-sw.js"]) {
    const want = await local(file);
    const got = Buffer.from(await get(`/${file}`).then((r) => r.arrayBuffer()));
    out.push({
      name: `${file} is the built file`,
      ok: digest(want) === digest(got),
      detail: `built ${digest(want)} — served ${digest(got)}`,
    });
  }

  // 4. The Worker is the thing answering, not a bucket of files. An unknown
  //    path under /api/ is refused by worker/index.ts and by nothing else, so
  //    this fails if the assets are live but the code serving them is not.
  const api = await get("/api/definitely-not-a-route");
  out.push({
    name: "the Worker is answering, not just the assets",
    ok: api.status === 404,
    detail: `/api/ on an unknown path answered ${api.status}, wanted 404`,
  });

  // 5. The headers the Worker puts on the app. They are set in code, so their
  //    absence says the request never went through withSecurityHeaders.
  const head = await get("/");
  const csp = head.headers.get("content-security-policy") ?? "";
  const missing = [
    ["content-security-policy", csp.includes("default-src 'self'")],
    ["x-content-type-options", head.headers.get("x-content-type-options") === "nosniff"],
    ["x-frame-options", head.headers.get("x-frame-options") === "DENY"],
    ["strict-transport-security", (head.headers.get("strict-transport-security") ?? "").includes("max-age=")],
  ].filter(([, ok]) => !ok).map(([n]) => n);
  out.push({
    name: "the app's security headers are on the live response",
    ok: missing.length === 0,
    detail: missing.length ? `missing or wrong: ${missing.join(", ")}` : "all four present",
  });

  return out;
}

/** One pass. Returns every guard's verdict, red ones included. */
export async function runSmoke({ origin, dist = "dist", fetchImpl = fetch }) {
  const get = async (p) => {
    const res = await fetchImpl(new URL(p, origin), {
      headers: { "cache-control": "no-cache" },
      redirect: "follow",
    });
    return res;
  };
  return checks(origin, dist, get);
}

/** Red guards, once the retries are spent. */
export async function smoke(opts) {
  const { attempts = 3, waitMs = 10_000, log = console.log } = opts;
  for (let i = 1; i <= attempts; i++) {
    // An origin that cannot be reached at all is a red guard, not a stack
    // trace. It is also the most retry-worthy thing that can happen here —
    // a name that has not propagated, an edge still coming up — so it has to
    // be caught INSIDE the loop or the retries never happen.
    const results = await runSmoke(opts).catch((e) => [{
      name: "the origin answers",
      ok: false,
      detail: `${opts.origin} could not be reached: ${e instanceof Error ? e.message : e}`,
    }]);
    const bad = results.filter((r) => !r.ok);
    if (bad.length === 0 || i === attempts) {
      for (const r of results) log(`${r.ok ? "ok  " : "RED "} ${r.name}\n       ${r.detail}`);
      return bad;
    }
    log(`attempt ${i}: ${bad.length} guard(s) red, waiting ${waitMs / 1000}s — an edge takes a moment`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return [];
}

// Run directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const origin = process.argv[2];
  if (!origin) {
    console.error("usage: node scripts/smoke.mjs <origin> [dist]");
    process.exit(2);
  }
  const bad = await smoke({ origin, dist: process.argv[3] ?? "dist" });
  if (bad.length) {
    console.error(`\n${bad.length} guard(s) red: ${origin} is not serving this build.`);
    process.exit(1);
  }
  console.log(`\n${origin} is serving this build.`);
}
