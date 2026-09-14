/**
 * Web Push, by hand: RFC 8291 (encryption) and RFC 8292 (who is asking).
 *
 * No library, for the same reason the till draws its own barcodes and its own
 * icons — this runs in one small function, the standards are short, and a
 * dependency that fetches at deploy time is a thing that can be down when a
 * shop needs a manager. What is NOT waved through is correctness: a payload
 * encrypted almost right is one the phone silently drops, so
 * test/webpush.test.mjs encrypts with this and DECRYPTS with http_ece, the
 * library the reference implementation uses. Agreeing with itself would prove
 * nothing.
 *
 * Kept free of Deno APIs (Web Crypto only) so that test can run it in node.
 */

const enc = new TextEncoder();

export function b64uToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** HMAC-SHA256, which is all HKDF actually is at these sizes. */
async function hmac(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
}

/** HKDF-Extract then one Expand block, written out because it is two lines. */
async function derive(
  salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number
): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, join(info, Uint8Array.of(1)));
  return okm.slice(0, length);
}

export interface Subscription {
  endpoint: string;
  /** The device's public key, base64url, 65 bytes uncompressed. */
  p256dh: string;
  /** The device's auth secret, base64url, 16 bytes. */
  auth: string;
}

/**
 * The body of a push: RFC 8188's aes128gcm framing around RFC 8291's keys.
 *
 * salt(16) | rs(4) | idlen(1) | server public key(65) | AES-128-GCM(payload|0x02)
 */
export async function encryptPayload(
  payload: string,
  sub: Subscription,
  // Given by the test so the same inputs make the same bytes; random in life.
  fixed?: { salt: Uint8Array; serverKeys: CryptoKeyPair },
): Promise<Uint8Array> {
  const uaPublic = b64uToBytes(sub.p256dh);
  const authSecret = b64uToBytes(sub.auth);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const keys = fixed?.serverKeys ?? await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);

  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey!));
  const ua = await crypto.subtle.importKey(
    "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: ua }, keys.privateKey!, 256));

  // RFC 8291 §3.4: the auth secret salts the first extract, and the two
  // public keys are bound into the info so a key swapped in transit cannot
  // produce the same secret.
  const ikm = await derive(
    authSecret, shared,
    join(enc.encode("WebPush: info"), Uint8Array.of(0), uaPublic, asPublic), 32);
  const cek = await derive(
    salt, ikm, join(enc.encode("Content-Encoding: aes128gcm"), Uint8Array.of(0)), 16);
  const nonce = await derive(
    salt, ikm, join(enc.encode("Content-Encoding: nonce"), Uint8Array.of(0)), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record, so it carries the last-record delimiter (0x02) rather than
  // the padding delimiter (0x01).
  const body = join(enc.encode(payload), Uint8Array.of(2));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, key, body));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return join(salt, rs, Uint8Array.of(asPublic.length), asPublic, sealed);
}

/**
 * Who is asking, and how to reach them if it goes wrong (RFC 8292).
 *
 * A JWT the push service checks against the public key the phone subscribed
 * with, so a stolen endpoint cannot be pushed to by anybody else.
 */
export async function vapidAuth(
  endpoint: string, subject: string,
  vapidPublic: string, vapidPrivate: string,
  now = Date.now(),
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // Twelve hours: long enough that a clock a few minutes out is not a
  // failure, short enough that a captured token is not a standing licence.
  const body = bytesToB64u(enc.encode(JSON.stringify({
    aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject,
  })));

  const raw = b64uToBytes(vapidPublic);
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC", crv: "P-256", ext: true,
      // The public key IS x||y behind a 0x04 tag, so the JWK needs no second
      // secret: one private scalar and the public key everybody already has.
      x: bytesToB64u(raw.slice(1, 33)),
      y: bytesToB64u(raw.slice(33, 65)),
      d: vapidPrivate,
    },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`)));

  return `vapid t=${head}.${body}.${bytesToB64u(sig)}, k=${vapidPublic}`;
}
