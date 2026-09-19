import { cacheGet, cacheSet } from "./localCache";

/**
 * Face ID, or a fingerprint, to pick the phone back up.
 *
 * WHAT THIS IS NOT. It is not a way to sign in, and it never proves who
 * anybody is. Signing in proves a PIN against the server, and nothing here
 * changes that. This unlocks a session THAT WAS ALREADY PROVED and is still
 * in memory — the phone was put in a pocket, the away lock fired sixty
 * seconds later, and the PIN that opened it is still sitting in React state
 * because the app never reloaded. Resuming that is not a new claim of
 * identity; it is the same session, and the biometric is what stands in for
 * re-typing six digits nobody has forgotten in the meantime.
 *
 * Which is why a reload still asks for the PIN, and must. A cold start has no
 * session to resume, `sessionPin` is null, and there is nothing on this device
 * to check a PIN against — lib/unlock.ts's rule, that no device ever holds a
 * PIN, is untouched by this file. Nothing here is a credential: a WebAuthn
 * credential ID is a public handle, the private key never leaves the phone's
 * secure hardware, and neither can open anything on the server.
 *
 * HOW STRONG IS IT. Exactly as strong as the lock screen it replaces, and no
 * stronger. Both gate state the page is already holding, and unlock.ts says
 * the honest thing about that: "every RPC behind those doors re-verifies the
 * PIN server-side, so the door is not what keeps anyone out". The door is for
 * the handset left on a counter. This is a better door for that — a stranger
 * who picks the phone up has neither the PIN nor the owner's face — and it is
 * not a security boundary. The boundary is the server, as before.
 *
 * WHAT IT FIXES IN THE YARD. The lock proves a PIN against the server, so with
 * no line it cannot be opened at all and offers only Look it up. A manager
 * working deliveries out of signal is therefore shut out of their own phone
 * every minute. The biometric is local and needs no line, so the session they
 * already had comes back.
 *
 * THE TEST SEAM, and the honesty of the suite rests on it being this thin:
 * everything below talks to `navigator.credentials` and nothing else, so a
 * test installs a fake and every path downstream — the offer, the enrolment,
 * the resume, the fallback — runs for real. What no suite can prove is that a
 * real sensor said yes, which is verified on an actual phone.
 */

/** Credential handles by user id. Public data: an id opens nothing by itself. */
const KEY = "device.biometric";

type Enrolments = Record<string, string>;

function all(): Enrolments {
  return cacheGet<Enrolments>(KEY, {});
}

const b64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromB64url(s: string): ArrayBuffer {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/**
 * A local challenge, and deliberately so.
 *
 * A challenge exists to stop an assertion being replayed at a SERVER. Nothing
 * here is sent to one: the answer is consumed by this page, on this device, to
 * resume state this page already holds. A server-issued challenge would imply
 * a guarantee this does not make and cannot keep offline, which is where it is
 * most wanted.
 */
function challenge(): ArrayBuffer {
  const c = new Uint8Array(new ArrayBuffer(32));
  crypto.getRandomValues(c);
  return c.buffer;
}

/** Whether this phone has a fingerprint reader or a face camera to ask. */
export async function biometricAvailable(): Promise<boolean> {
  try {
    const P = window.PublicKeyCredential;
    if (!P?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    return await P.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    // An older browser, or one that refuses to answer. Either way: the PIN.
    return false;
  }
}

/** Whether this person has set it up on THIS phone. */
export function biometricEnrolled(userId: string): boolean {
  return typeof all()[userId] === "string";
}

/**
 * Set it up, at a moment the PIN has just been proved.
 *
 * `userVerification: "required"` is the point of the whole thing: it makes the
 * phone ask for a face or a finger rather than accepting that the handset is
 * merely unlocked. A platform authenticator, because a shop phone's own sensor
 * is what is wanted, not a security key from a drawer.
 */
export async function biometricEnrol(
  userId: string, userName: string
): Promise<boolean> {
  try {
    const raw = new TextEncoder().encode(userId);
    const id = new Uint8Array(new ArrayBuffer(raw.length));
    id.set(raw);
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: challenge(),
        rp: { name: "InnovaPOS" },
        user: { id, name: userName, displayName: userName },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },   // ES256, what secure enclaves do
          { type: "public-key", alg: -257 }, // RS256, for the ones that do not
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    if (!cred) return false;
    cacheSet(KEY, { ...all(), [userId]: b64url(cred.rawId) });
    return true;
  } catch {
    // Refused, unsupported, or cancelled. The PIN still works; say nothing.
    return false;
  }
}

/** Ask the phone. True only if it verified a face or a finger. */
export async function biometricVerify(userId: string): Promise<boolean> {
  const handle = all()[userId];
  if (!handle) return false;
  try {
    const got = await navigator.credentials.get({
      publicKey: {
        challenge: challenge(),
        allowCredentials: [{ type: "public-key", id: fromB64url(handle) }],
        userVerification: "required",
        timeout: 60_000,
      },
    });
    return got != null;
  } catch {
    // Cancelled, wrong face, wet hands, gloves. All the same answer, and all
    // of them fall back to the keypad rather than stranding anybody.
    return false;
  }
}

/**
 * Forget it for this person on this phone.
 *
 * On sign-out, because the next person to hold this handset is not them — and
 * an enrolment left behind would offer to unlock somebody else's session.
 */
export function biometricForget(userId: string): void {
  const rest = { ...all() };
  delete rest[userId];
  cacheSet(KEY, rest);
}
