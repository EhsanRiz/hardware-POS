import { useEffect, useRef, useState } from "react";

/**
 * A till nobody has touched for ten minutes shuts itself.
 *
 * This is the guard that earns the rest of the change. The counter complained
 * of too many PINs, and they were right: Manage and the stock room each asked
 * for six digits at their own door, while every call behind them re-checks the
 * PIN server-side anyway. The doors were never what kept anyone out — somebody
 * standing at a signed-in till can already ring up a sale under the cashier's
 * name. So the asking moved here, where it does some good: one lock, on time,
 * instead of a toll on every screen.
 *
 * A LOCK, NOT A SIGN-OUT. The shop chose it and it is the right choice for a
 * counter: the same person comes back to the same basket, types their PIN and
 * carries on, with nothing lost in front of a customer. The lock screen still
 * offers to sign in as somebody else, because a till is shared and the person
 * who locked it may have gone home — and that path parks the open sale first,
 * so it stays attributed to whoever rang it up.
 *
 * WHAT COUNTS AS A TOUCH. Anything a person does: a tap, a key, a scroll, a
 * scanner gun (which types). Deliberately not a timer, a sync or a render —
 * a till that sits there refreshing its catalogue all evening is exactly the
 * unattended till this exists for, and an app that keeps itself awake would
 * defeat the point entirely.
 */
const IDLE_MS = 10 * 60_000;

/**
 * How often the clock is examined.
 *
 * A timestamp compared on a slow tick, rather than a timeout reset on every
 * keystroke: a scanner gun fires a burst of key events per item and a counter
 * types all day, and re-arming a timer thousands of times an hour to achieve
 * the same answer is work for nothing.
 */
const TICK_MS = 15_000;

/** The events that mean a person is there. Passive: none of them are handled. */
const TOUCHES = [
  "pointerdown", "keydown", "wheel", "touchstart", "scroll",
] as const;

/**
 * Locks after IDLE_MS without a touch. `enabled` is false where it does not
 * apply — a phone has its own away-lock, which is about being put in a pocket
 * rather than about time passing at a counter.
 *
 * Returns the locked flag and a way to clear it, which the lock screen calls
 * once a PIN has been proved.
 */
export function useIdleLock(enabled: boolean): [boolean, () => void] {
  const [locked, setLocked] = useState(false);
  const lastTouch = useRef(Date.now());
  // Read inside the listeners without re-binding them every time the lock
  // changes. Declared before the effect that closes over it, so the order on
  // the page matches the order it is used in.
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    if (!enabled) {
      setLocked(false);
      return;
    }
    lastTouch.current = Date.now();

    const touched = () => {
      // While locked a touch must NOT push the clock forward: the keypad is
      // on screen and typing at it is not being at the till in the sense
      // this measures. Unlocking is what clears it.
      if (!lockedRef.current) lastTouch.current = Date.now();
    };
    for (const e of TOUCHES) {
      window.addEventListener(e, touched, { passive: true, capture: true });
    }

    const tick = window.setInterval(() => {
      if (lockedRef.current) return;
      if (Date.now() - lastTouch.current >= IDLE_MS) setLocked(true);
    }, TICK_MS);

    return () => {
      for (const e of TOUCHES) {
        window.removeEventListener(e, touched, { capture: true });
      }
      window.clearInterval(tick);
    };
  }, [enabled]);

  return [
    locked,
    () => {
      lastTouch.current = Date.now();
      setLocked(false);
    },
  ];
}

/** The window, exported so a test can state the number it is asserting. */
export const IDLE_LOCK_MS = IDLE_MS;
