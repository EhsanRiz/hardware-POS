/**
 * The till moved from app.innovaearth.com to till.innovaearth.com, and the
 * old address sends people on — but only people. A till paired on the old
 * address keeps its token in that origin's storage and must go on working
 * until it is re-paired, so its API calls, its assets and its service-worker
 * update checks must NOT be redirected: a 301 turns a POST into a GET, and a
 * script redirected cross-origin does not load. Only a navigation moves.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { redirectFor, TILL_HOST, digestRequest } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  → ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}
const nav = new Headers({ "sec-fetch-mode": "navigate", accept: "text/html,*/*" });
const browserNoHint = new Headers({ accept: "text/html" });
const script = new Headers({ "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script", accept: "*/*" });
const api = new Headers({ "sec-fetch-mode": "cors", accept: "application/json" });
const at = (u, h) => redirectFor(new URL(u), h);

console.log("--- a typed address on the old host moves ---");
let r = at("https://app.innovaearth.com/", nav);
check("status", r?.status, 301);
check("location", r?.headers.get("location"), `https://${TILL_HOST}/`);
r = at("https://app.innovaearth.com/manage?tab=staff", nav);
check("the path and query go with it", r?.headers.get("location"), `https://${TILL_HOST}/manage?tab=staff`);
r = at("https://app.innovaearth.com/", browserNoHint);
check("an older browser that only says text/html moves too", r?.status, 301);

console.log("--- a till still paired on the old host is left alone ---");
check("its API calls", at("https://app.innovaearth.com/api/rest/v1/rpc/pos_login", api), null);
check("its assets", at("https://app.innovaearth.com/assets/index-abc.js", script), null);
check("its service worker's update check", at("https://app.innovaearth.com/sw.js", script), null);
check("its manifest", at("https://app.innovaearth.com/manifest.webmanifest", new Headers({ accept: "application/manifest+json" })), null);

console.log("--- the new host is home ---");
check("a navigation on till. is served, not bounced", at(`https://${TILL_HOST}/`, nav), null);
check("and so is any other host this Worker might be given", at("https://hardware-pos.workers.dev/", nav), null);

console.log("--- the nightly line is asked for with the public key, and nothing else ---");
const dr = digestRequest({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon-key" });
check("it calls the digest function", dr.url, "https://x.supabase.co/functions/v1/error-digest");
check("as a POST", dr.method, "POST");
check("with the public key", dr.headers.get("apikey"), "anon-key");
check("as a bearer too, the way the gateway wants it", dr.headers.get("authorization"), "Bearer anon-key");

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
