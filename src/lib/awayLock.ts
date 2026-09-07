import { useEffect, useRef, useState } from "react";
import { cacheGet, cacheRemove, cacheSet } from "./localCache";

/**
 * A personal device locks itself when it has been put away.
 *
 * The counter's rule — hold the manager's PIN only while the back office is
 * open — is right for a till that several people share and nobody carries. A
 * phone is the opposite: one person carries it, and the thing that actually
 * goes wrong is the handset being left on a counter or lifted from a bag while
 * still signed in. So the phone re-asks for its owner's PIN when it comes
 * back, and nothing else about the PIN rules changes.
 *
 * Not instant, deliberately. Two of the phone's errands — photographing a
 * supplier's quotation, photographing a shelf — can send the browser to the
 * camera, and a lock that fired on every one of those would be a PIN after
 * every picture. A minute is longer than a camera trip and far shorter than a
 * phone spends in a pocket.
 */
const AWAY_MS = 60_000;

/** When the app was last hidden. On disk, because of the reload case below. */
const HIDDEN_KEY = "device.hiddenAt";

/**
 * Was this device put away for long enough to lock?
 *
 * `enabled` is false on a till, where none of the above applies.
 */
export function useAwayLock(enabled: boolean): [boolean, () => void] {
  const [locked, setLocked] = useState(false);
  // Mirrors the stored value so the common path needs no storage read.
  const hiddenAt = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      cacheRemove(HIDDEN_KEY);
      return;
    }

    /**
     * A backgrounded tab that iOS discarded comes back as a FRESH LOAD, not a
     * visibility change — and the sign-in survives it, because the session is
     * cached. Checking the stored timestamp on mount is what makes the lock
     * hold in the case it is most needed: a phone left alone long enough for
     * the browser to throw the page away.
     */
    const storedAt = cacheGet<number | null>(HIDDEN_KEY, null);
    if (storedAt != null && Date.now() - storedAt >= AWAY_MS) setLocked(true);

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        cacheSet(HIDDEN_KEY, hiddenAt.current);
        return;
      }
      const since = hiddenAt.current ?? cacheGet<number | null>(HIDDEN_KEY, null);
      hiddenAt.current = null;
      cacheRemove(HIDDEN_KEY);
      if (since != null && Date.now() - since >= AWAY_MS) setLocked(true);
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled]);

  return [
    locked,
    () => {
      hiddenAt.current = null;
      cacheRemove(HIDDEN_KEY);
      setLocked(false);
    },
  ];
}
