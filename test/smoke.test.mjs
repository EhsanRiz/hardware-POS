/**
 * The check that the shop is being served what was built — checked itself.
 *
 * It cannot be pointed at the real address from here, and a check nobody can
 * exercise is a check nobody trusts. So this stands up a server that answers
 * the way the Worker does, serving the real dist/, and then breaks it one way
 * at a time: a page left on last week's bundle, an asset whose bytes were
 * swapped underneath its hashed name, a stale service worker, the Worker gone
 * with the files still there, the security headers missing.
 *
 * Every one of those is a deploy a person would call successful.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSmoke, assetsFrom } from "../scripts/smoke.mjs";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

let failures = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { failures++; console.error(`FAIL ${label}: got ${a}, wanted ${b}`); }
};

try {
  await stat(path.join(DIST, "index.html"));
} catch {
  console.error("smoke: no dist/ to check against — run `npm run build` first");
  process.exit(1);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

/**
 * A stand-in for the deployed Worker: the same files, the same SPA fallback,
 * the same refusal on an unknown /api/ path, the same headers.
 *
 * `bend` is how a deploy goes wrong. Each key is one way.
 */
function serve(bend = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let p = url.pathname;

    if (p.startsWith("/api/")) {
      // The Worker refuses unknown paths under /api/. A bucket of files
      // would answer something else entirely.
      res.writeHead(bend.apiStatus ?? 404).end("Not found");
      return;
    }

    if (p === "/") p = "/index.html";
    let body;
    try {
      body = await readFile(path.join(DIST, p));
    } catch {
      body = await readFile(path.join(DIST, "index.html")); // single-page app
      p = "/index.html";
    }

    if (p === "/index.html" && bend.staleIndex) {
      // Yesterday's page, still naming yesterday's bundle.
      body = Buffer.from(String(body).replace(/\/assets\/index-[^."]+\./g, "/assets/index-0LDBUILD."));
    }
    if (bend.mutateAsset && p.endsWith(".js") && p.startsWith("/assets/")) {
      body = Buffer.concat([body, Buffer.from("\n// something in the middle changed this\n")]);
    }
    if (bend.staleSw && (p === "/sw.js" || p === "/push-sw.js")) {
      body = Buffer.from("// last week's service worker\n");
    }

    const headers = { "content-type": TYPES[path.extname(p)] ?? "application/octet-stream" };
    if (bend.dropHeaders !== true) {
      headers["content-security-policy"] = bend.weakCsp ? "default-src *" : "default-src 'self'; script-src 'self'";
      headers["x-content-type-options"] = "nosniff";
      headers["x-frame-options"] = "DENY";
      headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
    }
    res.writeHead(200, headers).end(body);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

/** Run the real check against a server bent the given way. */
async function against(bend) {
  const server = await serve(bend);
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const results = await runSmoke({ origin, dist: DIST });
    return { red: results.filter((r) => !r.ok).map((r) => r.name), all: results };
  } finally {
    server.close();
  }
}

// --- reading a build's identity out of its own markup -----------------------

check("the built page names its hashed bundle",
  assetsFrom('<script src="/assets/index-AbC123.js"></script>'), ["/assets/index-AbC123.js"]);
check("stylesheets count too",
  assetsFrom('<link rel="stylesheet" href="/assets/index-Zz9.css">'), ["/assets/index-Zz9.css"]);
check("and a page naming nothing yields nothing",
  assetsFrom("<html><body>hello</body></html>"), []);
check("the same file named twice is one file",
  assetsFrom('<script src="/assets/a-1.js"></script><link href="/assets/a-1.js">'), ["/assets/a-1.js"]);

// --- a deploy that landed ---------------------------------------------------

const good = await against({});
check("a shop served the build it was sent has nothing red", good.red, []);
// Vacuity: a check that passes everything would also pass the line above.
check("and it actually looked at something", good.all.length > 5, true);

// --- and the ways one does not ----------------------------------------------

// The page still on last week's bundle: the deploy uploaded, nothing serves it.
check("a page naming a bundle that was not built is caught",
  (await against({ staleIndex: true })).red.includes("the live page is this build"), true);

// The hashed name matches; the bytes do not. Something in the middle has its
// own copy — an edge cache, a proxy, a half-finished upload.
const swapped = await against({ mutateAsset: true });
check("an asset whose bytes were changed under its own name is caught",
  swapped.red.some((n) => n.endsWith("is the built file") && n.includes("/assets/")), true);

// The one that keeps a till on last week's app after it says it updated.
const stale = await against({ staleSw: true });
check("a stale service worker is caught", stale.red.includes("sw.js is the built file"), true);
check("and so is a stale push worker", stale.red.includes("push-sw.js is the built file"), true);

// Files served, Worker not — the case where /api/ stops being proxied at all
// and every call from the till goes nowhere.
check("assets alive with the Worker gone is caught",
  (await against({ apiStatus: 200 })).red.includes("the Worker is answering, not just the assets"), true);

// Headers are set in code. Their absence means the response never went
// through it, whatever the page looks like.
check("missing security headers are caught",
  (await against({ dropHeaders: true })).red.includes("the app's security headers are on the live response"), true);
check("and a content policy that permits everything is not accepted as one",
  (await against({ weakCsp: true })).red.includes("the app's security headers are on the live response"), true);

// One thing wrong should not read as everything wrong; a check that goes red
// across the board tells nobody where to look.
check("one fault reports one fault",
  (await against({ apiStatus: 200 })).red.length, 1);

// An address nobody answers. This is what a smoke check meets when a name has
// not propagated or an edge is still coming up, and it has to come back as a
// red guard that can be retried — not a stack trace out of the middle of the
// run, which skips the retries and reads like the checker itself is broken.
{
  const { smoke } = await import("../scripts/smoke.mjs");
  const said = [];
  const bad = await smoke({
    origin: "http://127.0.0.1:1",   // nothing listens on port 1
    dist: DIST, attempts: 2, waitMs: 1, log: (l) => said.push(l),
  });
  check("an origin that cannot be reached is one red guard, not a crash",
    bad.map((r) => r.name), ["the origin answers"]);
  check("and it was retried rather than given up on",
    said.some((l) => l.startsWith("attempt 1:")), true);
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("smoke check: all checks passed");
