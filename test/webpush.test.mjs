/**
 * A push the phone can actually open.
 *
 * supabase/functions/push/webpush.ts implements RFC 8291 by hand. The failure
 * it must not have is the quiet one: a payload encrypted ALMOST right is not
 * an error anywhere — the push service accepts it, the phone's service worker
 * throws it away, and nobody sees a notification or a log line. A test that
 * decrypted with the same code would agree with itself all the way into that
 * hole.
 *
 * So the plaintext is recovered here by http_ece, the library the reference
 * web-push implementation uses, through node's own ECDH. If the two agree,
 * the bytes are the shape every browser expects.
 *
 * The VAPID half is checked the same way round: the JWT is verified against
 * the public key, which is exactly what the push service does with it.
 */
import { readFileSync } from "node:fs";
import { createECDH, webcrypto, createPublicKey, createVerify } from "node:crypto";
import ece from "http_ece";
import ts from "typescript";

const src = readFileSync(new URL("../supabase/functions/push/webpush.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = {};
new Function("exports", "crypto", "atob", "btoa", "TextEncoder", js)(
  mod, webcrypto, atob, btoa, TextEncoder);
const { encryptPayload, vapidAuth, b64uToBytes, bytesToB64u } = mod;

let failures = 0;
const check = (label, got, want) => {
  if (got !== want) { failures++; console.error(`FAIL ${label}: got ${got}, wanted ${want}`); }
};
const ok = (label, cond) => {
  if (!cond) { failures++; console.error(`FAIL ${label}`); }
};

const b64u = (b) => Buffer.from(b).toString("base64url");

// A phone's subscription, as a browser hands one over: an ECDH key pair on
// P-256 and sixteen bytes of auth secret.
const ua = createECDH("prime256v1");
ua.generateKeys();
const authSecret = webcrypto.getRandomValues(new Uint8Array(16));
const sub = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  p256dh: b64u(ua.getPublicKey()),
  auth: b64u(authSecret),
};

const said = "1 sale is waiting for a manager";
const body = Buffer.from(await encryptPayload(said, sub));

// The framing, before the crypto: RFC 8188's header is salt, record size,
// then the sender's public key with its length in front.
check("the salt and header come first", body.length > 16 + 4 + 1 + 65, true);
check("the record size is the one browsers expect", body.readUInt32BE(16), 4096);
check("and the key that follows is a full uncompressed point", body[20], 65);

// The half that matters: somebody else's code gets the sentence back.
const out = ece.decrypt(body, {
  version: "aes128gcm",
  privateKey: ua,
  authSecret: Buffer.from(authSecret),
});
check("the phone reads what was sent", out.toString(), said);

// A different phone must not: the auth secret and the device key are what
// make this end to end rather than merely encrypted.
const other = createECDH("prime256v1");
other.generateKeys();
let refused = false;
try {
  ece.decrypt(body, { version: "aes128gcm", privateKey: other, authSecret: Buffer.from(authSecret) });
} catch { refused = true; }
ok("another phone's key does not open it", refused);

// VAPID: the push service checks this signature against the public key the
// phone subscribed with, so it is checked here the same way.
const kp = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const rawPublic = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
const jwk = await webcrypto.subtle.exportKey("jwk", kp.privateKey);

const header = await vapidAuth(
  sub.endpoint, "mailto:till@innovaearth.com",
  bytesToB64u(rawPublic), jwk.d, Date.parse("2026-09-14T10:00:00Z"));

const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
ok("the header is the shape RFC 8292 describes", !!m);
if (m) {
  const [, jwt, k] = m;
  check("it carries the same key the phone subscribed with", k, bytesToB64u(rawPublic));
  const [h, p, sig] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  // The audience is the push service's origin and nothing more — a JWT made
  // out to the whole endpoint leaks the subscription to anybody who sees it.
  check("it is addressed to the push service", claims.aud, "https://fcm.googleapis.com");
  check("and says who to complain to", claims.sub, "mailto:till@innovaearth.com");
  check("and expires twelve hours on", claims.exp, Date.parse("2026-09-14T10:00:00Z") / 1000 + 43200);
  check("signed with ES256", JSON.parse(Buffer.from(h, "base64url").toString()).alg, "ES256");

  const verified = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, kp.publicKey,
    b64uToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
  ok("and the signature holds against the public key", verified);
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("webpush: all checks passed");
