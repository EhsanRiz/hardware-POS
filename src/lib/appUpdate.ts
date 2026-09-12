import { useEffect, useState } from "react";
import { registerSW } from "virtual:pwa-register";

/**
 * "There is a newer till than the one you are looking at."
 *
 * The app was registered with autoUpdate, which is wrong here twice over. It
 * reloads the page ITSELF the moment a new version lands — and a till that
 * reloads mid-sale loses the cart in front of a customer. And it only looks
 * for one on a navigation, which an installed app on a counter does not do:
 * the window is opened on Monday and is still the same window on Friday, so a
 * fix shipped on Tuesday sat unseen.
 *
 * So: check on a timer, and when something is waiting, SAY so and let the
 * person choose the moment. Between sales is a moment; halfway through one is
 * not, and only the cashier knows which this is.
 */

/** The internal signal. Also what a test fires, because a genuine service
    worker update cannot be staged in a browser test. */
const READY = "pos:update-ready";

/**
 * A till left open all week still wants Tuesday's fix on Tuesday.
 *
 * Five minutes, not fifteen. This is the whole delay between a change being
 * deployed and the counter being ABLE to take it, and the thing being waited
 * on is one conditional request for a file the size of a sentence.
 */
const CHECK_EVERY_MS = 5 * 60 * 1000;

let apply: ((reload?: boolean) => Promise<void>) | null = null;
let waiting = false;

export function startUpdateWatch(): void {
  if (typeof window === "undefined") return;
  apply = registerSW({
    onNeedRefresh() {
      waiting = true;
      window.dispatchEvent(new Event(READY));
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;

      // A check that cannot happen is not an error: offline is the normal
      // state of a shop whose line is down, and it will be asked again.
      const look = () => void registration.update().catch(() => {});

      window.setInterval(look, CHECK_EVERY_MS);

      // And at the moments a new version is most likely to have appeared AND
      // somebody is about to look at the screen. A counter machine sits on one
      // page for days, so a timer alone means the news is up to five minutes
      // stale exactly when the shop is waiting for it — coming back to the
      // window, or coming back online, are both better cues than the clock.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") look();
      });
      window.addEventListener("focus", look);
      window.addEventListener("online", look);

      // The waiting worker may already be sitting there from a previous
      // visit: registerSW only announces one it saw arrive.
      if (registration.waiting) {
        waiting = true;
        window.dispatchEvent(new Event(READY));
      }
    },
  });
}

/**
 * Take the update.
 *
 * Activates the worker that is waiting and reloads the page onto it, so every
 * change in that version — markup, styles, and the service worker's own
 * precache — is what the till is running afterwards. Nobody has to refresh
 * anything by hand; pressing the button IS the refresh, and it is one press
 * because the cashier is the only one who knows this second is between sales.
 */
export function applyUpdate(): void {
  // No waiting worker to activate (a dev build, a browser that refused one, or
  // a version that landed before this tab registered): a plain reload still
  // fetches the new files rather than doing nothing at all.
  if (apply && waiting) void apply(true);
  else window.location.reload();
}

export function useUpdateReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const on = () => setReady(true);
    window.addEventListener(READY, on);
    return () => window.removeEventListener(READY, on);
  }, []);
  return ready;
}
