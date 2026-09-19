import { useEffect, useState } from "react";
import InnovaMark from "./InnovaMark";
import PinPad from "./PinPad";
import { login } from "../lib/api";
import {
  biometricAvailable, biometricEnrolled, biometricVerify,
} from "../lib/biometric";
import { isNetworkError } from "../lib/offline";
import type { User } from "../lib/types";

/**
 * The phone, put away and picked up again.
 *
 * Asks its owner for their own PIN — the same one they signed in with, proved
 * the same way, against the server. Nothing is stored on the device to check
 * it against: a six-digit PIN sitting in local storage, however hashed, is a
 * credential on the handset, and this shop's rule from the beginning has been
 * that no device ever holds one.
 *
 * Which leaves the yard. With no line the PIN cannot be proved, and refusing
 * everything would brick the phone in exactly the place Look it up was built
 * for — a price and a bin, out of the cached catalogue, with no signal. So
 * when there is no line the lock offers that one screen and nothing else. It
 * is a deliberate line: prices and bins are on the shelf edge anyway, while
 * the back office, the approvals and this person's identity stay behind the
 * PIN whatever the signal is doing.
 *
 * FACE ID, WHERE THE SESSION IS STILL THERE. Turned on from the phone's own
 * menu, not from here — this screen only uses it. Somebody standing at a lock
 * wanting back into their phone is the worst moment to be setting anything up,
 * and an offer made only here has nowhere to say no later.
 * `resumable` is true when the PIN
 * this phone was opened with is still in memory — the app was never reloaded,
 * only hidden. Then a face or a finger stands in for typing the same six
 * digits again, and because that check is local it works in the yard, where
 * the PIN cannot be proved at all. A reload leaves `resumable` false and the
 * keypad is the only way back, which is the correct behaviour: there is no
 * session to resume and no PIN on this device to check one against.
 */
export default function PhoneLock({
  user, online, resumable, onResume, onUnlock, onLookup, onSignOut,
}: {
  user: User;
  online: boolean;
  /** The PIN that opened this phone is still in memory: only hidden, not reloaded. */
  resumable: boolean;
  /** Carry on with that session, no PIN retyped. */
  onResume: () => void;
  onUnlock: (pin: string) => void;
  /** Read-only escape hatch, offered only when the PIN cannot be proved. */
  onLookup: () => void;
  onSignOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Has this handset got a sensor at all — asked once, not on every render. */
  const [hasSensor, setHasSensor] = useState(false);
  const enrolled = biometricEnrolled(user.id);

  useEffect(() => {
    let gone = false;
    void biometricAvailable().then((ok) => !gone && setHasSensor(ok));
    return () => { gone = true; };
  }, []);

  async function resume() {
    setBusy(true);
    setError(null);
    const ok = await biometricVerify(user.id);
    setBusy(false);
    if (ok) onResume();
    // No error on a refusal: a cancelled prompt is somebody choosing the
    // keypad, and telling them off for it would be nonsense. A face that did
    // not match looks the same from here, and the keypad is right there.
  }


  async function submit(pin: string) {
    setBusy(true);
    setError(null);
    try {
      const who = await login(user.id, pin);
      if (who) onUnlock(pin);
      else setError("That PIN was not recognised.");
    } catch (e) {
      // Told apart on purpose: "we could not ask" is a different problem from
      // "you typed it wrong", and only one of them is the person's fault.
      setError(
        isNetworkError(e)
          ? "No line, so your PIN cannot be checked."
          : "That PIN could not be checked. Try again."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="phone-lock">
      <div className="phone-lock-card">
        <InnovaMark size={40} />
        <h1>{user.name}</h1>
        <p className="phone-lock-why">
          This phone was put away. Enter your PIN to carry on.
        </p>

        {/* Above the keypad, because when it is offered it is the way in. */}
        {resumable && enrolled && hasSensor && (
          <button
            className="btn-primary w-full"
            disabled={busy}
            onClick={() => void resume()}
          >
            Unlock with Face ID or fingerprint
          </button>
        )}

        <PinPad onSubmit={(pin) => void submit(pin)} busy={busy} />

        {error && <p className="login-error" role="alert">{error}</p>}

        {!online && (
          <div className="phone-lock-offline">
            <p>
              There is no line, so your PIN cannot be checked until there is.
              Prices and stock still work from what this phone already has.
            </p>
            <button className="btn-line w-full" onClick={onLookup}>
              Look something up
            </button>
          </div>
        )}

        <button className="phone-lock-out" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
