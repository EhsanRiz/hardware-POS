import { useState } from "react";
import InnovaMark from "./InnovaMark";
import PinPad from "./PinPad";
import { login } from "../lib/api";
import { isNetworkError } from "../lib/offline";
import type { User } from "../lib/types";

/**
 * The till, untouched for ten minutes.
 *
 * This is what pays for the rest of the change. The counter asked for fewer
 * PINs and was right to — Manage and the stock room each charged six digits at
 * their own door while every call behind them re-checks the PIN server-side.
 * So the asking moved here, where it does some good: once, on time, instead of
 * on every screen.
 *
 * A LOCK, NOT A SIGN-OUT, which the shop chose. The same person comes back to
 * the same basket and carries on; nothing is lost in front of a customer, and
 * the sale stays attributed to whoever rang it up.
 *
 * BUT A TILL IS SHARED, and the person who locked it may have gone home for
 * the day. So it also offers to hand over. That path signs out properly rather
 * than letting somebody work under a name that is not theirs — the whole point
 * of a per-person PIN is that the slip says who sold it.
 *
 * The PIN is proved against the SERVER, exactly as the sign-in did. Nothing on
 * this device is checked against, because nothing is stored: a six-digit PIN in
 * local storage, however hashed, is a credential sitting on a counter machine,
 * and this shop's rule from the beginning is that no device holds one. Which
 * means a till with no line cannot be unlocked — stated plainly on the screen
 * rather than discovered, and the reason the window is ten minutes and not one.
 */
export default function TillLock({
  user,
  online,
  onUnlock,
  onHandOver,
}: {
  user: User;
  online: boolean;
  /** The PIN, proved. The caller re-opens the doors it stands for. */
  onUnlock: (pin: string) => void;
  /** Park anything open and sign out, so the next person is themselves. */
  onHandOver: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(pin: string) {
    setBusy(true);
    setError(null);
    try {
      const who = await login(user.id, pin);
      if (!who) {
        setError("That PIN does not match this till's user.");
        return;
      }
      onUnlock(pin);
    } catch (e) {
      setError(
        isNetworkError(e)
          ? "No line to the server, so the PIN cannot be checked. Try again when it is back."
          : "Could not check that PIN. Try again."
      );
    } finally {
      setBusy(false);
    }
  }

  // The phone lock's shell, because this is the same screen for a different
  // device and inventing a second set of styles for it would only let the two
  // drift apart.
  return (
    <div className="phone-lock">
      <div className="phone-lock-card">
        <InnovaMark size={40} />
        <h1>{user.name}</h1>
        <p className="phone-lock-why">
          The till locked itself after ten minutes. Enter your PIN to carry on
          — the sale on screen is still here.
        </p>

        {!online && (
          <p className="login-error" role="alert">
            No line to the server. A PIN is checked against the shop, never
            against this machine, so unlocking has to wait for the line.
          </p>
        )}

        <PinPad onSubmit={(pin) => void submit(pin)} busy={busy || !online} />
        {error && <p className="login-error" role="alert">{error}</p>}

        {/* Somebody else taking the counter. Deliberately not a second PIN
            pad: this signs out, and the ordinary sign-in screen asks who they
            are — the whole point of a per-person PIN is that the slip says
            who sold it. */}
        <button className="phone-lock-out" onClick={onHandOver} disabled={busy}>
          Someone else is taking over
        </button>
      </div>
    </div>
  );
}
