/**
 * The built till, served the way Cloudflare serves it.
 *
 * The browser suite used to run against `vite preview`, which sets none of the
 * shop's headers. That is why a Content-Security-Policy could sit in
 * worker/index.ts, never reach a live response, and leave 322 tests green:
 * nothing the suite ran under had a policy at all.
 *
 * So this serves dist/ and applies public/_headers, which is what Cloudflare's
 * asset server actually applies. A build that breaks under the shop's own CSP
 * now fails here — in a suite, on a branch — instead of white-screening a
 * counter.
 *
 *   node scripts/serve-dist.mjs [port] [dist] [headersFile]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.argv[2] ?? 4173);
const DIST = process.argv[3] ?? "dist";
const HEADERS_FILE = process.argv[4] ?? "public/_headers";

/**
 * Cloudflare's `_headers`: a path pattern at the margin, its headers indented
 * under it. Every matching rule applies, later ones winning a header an
 * earlier one already set — which is how /assets/* adds a Cache-Control to
 * the policy /* has already given it.
 */
export function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    const at = line.indexOf(":");
    if (at === -1 || !current) continue;
    current.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return rules;
}

/** `/*` and `/assets/*` only — the shapes this file uses. */
export function matches(pattern, pathname) {
  if (pattern.endsWith("/*")) return pathname.startsWith(pattern.slice(0, -1));
  if (pattern === "/*") return true;
  return pattern === pathname;
}

export function headersFor(rules, pathname) {
  const out = new Map();
  for (const rule of rules) {
    if (!matches(rule.pattern, pathname)) continue;
    for (const [k, v] of rule.headers) out.set(k, v);
  }
  return out;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const rules = parseHeaders(readFileSync(HEADERS_FILE, "utf8"));

  createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    // No climbing out of dist/ with ../ — this serves a shop's build, and a
    // test server that reads arbitrary files is a habit worth not forming.
    let p = path.posix.normalize(decodeURIComponent(url.pathname));
    if (p.endsWith("/")) p += "index.html";

    let file = path.join(DIST, p);
    if (!path.resolve(file).startsWith(path.resolve(DIST))) {
      res.writeHead(403).end("No");
      return;
    }

    let body;
    try {
      if ((await stat(file)).isDirectory()) throw new Error("directory");
      body = await readFile(file);
    } catch {
      // The till is a single-page app: an unknown path is a route, not a 404.
      p = "/index.html";
      file = path.join(DIST, p);
      try {
        body = await readFile(file);
      } catch {
        res.writeHead(404).end("Not found");
        return;
      }
    }

    const headers = { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream" };
    for (const [k, v] of headersFor(rules, p)) headers[k] = v;
    res.writeHead(200, headers).end(body);
  }).listen(PORT, () => {
    console.log(`dist/ on http://localhost:${PORT}, under ${HEADERS_FILE}`);
  });
}
