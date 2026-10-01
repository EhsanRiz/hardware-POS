import { useState } from "react";
import InnovaMark from "./InnovaMark";
import PinPad from "./PinPad";
import { canSignInOffline, signInWithBadge, signIn } from "../lib/auth";
import { useBadgeScan } from "../lib/badgeScan";
import { errorMessage } from "../lib/errors";
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
 * The PIN is proved exactly as sign-in proves it (lib/auth): against the server
 * when there is a line, and against this till's cached copy when there is not.
 * This screen used to insist on the server, which left a shop with a bad line
 * worse off than at sign-in: the cashier who stepped away for ten minutes in an
 * outage could not get back to their own sale, though signing in from scratch
 * would have worked. The same week-long limit and wrong-PIN wait apply.
 *
 * Or the same person's staff badge (0129). A badge opens this lock and sign-in,
 * nothing else, so unlocking with one leaves no PIN behind for the back office
 * to reuse. Somebody else's badge does not hand the till over: that is what
 * the button below is for, and it parks the sale first.
 */
export default function TillLock({
  user,
  online,
  onUnlock,
  onHandOver,
}: {
  user: User;
  online: boolean;
  /**
   * Proved. With the PIN when one was typed, so the caller re-opens the doors
   * it stands for; null for a badge, which opens none of them.
   */
  onUnlock: (pin: string | null) => void;
  /** Park anything open and sign out, so the next person is themselves. */
  onHandOver: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(pin: string) {
    setBusy(true);
    setError(null);
    try {
      const who = await signIn(user.id, pin);
      if (!who) {
        setError(
          !online && !canSignInOffline(user.id)
            ? `${user.name}'s PIN has not been checked on this till before, so it cannot be checked with the line down. Scan your badge, or wait for the line.`
            : "That PIN does not match this till's user."
        );
        return;
      }
      onUnlock(pin);
    } catch (e) {
      setError(errorMessage(e, "Could not check that PIN. Try again."));
    } finally {
      setBusy(false);
    }
  }

  useBadgeScan((code) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    signInWithBadge(code)
      .then((who) => {
        if (!who) {
          setError("That badge was not recognised. It may have been cancelled or replaced.");
        } else if (who.id !== user.id) {
          setError(
            `That is ${who.name}'s badge. The till is locked for ${user.name} — tap "Someone else is taking over" to hand it over.`
          );
        } else {
          onUnlock(null);
        }
      })
      .catch((e) => setError(errorMessage(e, "Could not check that badge. Try again.")))
      .finally(() => setBusy(false));
  });

  // The phone lock's shell, because this is the same screen for a different
  // device and inventing a second set of styles for it would only let the two
  // drift apart.
  return (
    <div className="phone-lock">
      <div className="phone-lock-card">
        <InnovaMark size={40} />
        <h1>{user.name}</h1>
        <p className="phone-lock-why">
          The till locked itself after ten minutes. Enter your PIN or scan
          your badge to carry on — the sale on screen is still here.
        </p>

        <PinPad onSubmit={(pin) => void submit(pin)} busy={busy} />
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
