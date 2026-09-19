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
/**
 * That a newer app is waiting — the fact, which persists, as against READY,
 * which is only the nudge that announces it.
 *
 * Latched by listening for READY rather than beside each dispatch, so there is
 * ONE path and the suite walks it. A test cannot stage a genuine service
 * worker, so it fires the event; if the latch were set only next to the real
 * dispatches, every test would leave it false and a screen that reads the
 * latch could be broken with the suite still green.
 */
let waiting = false;
/**
 * Whether there is a REAL worker sitting there to be activated, which is a
 * different question from whether to draw the button. A test fires the event
 * and no worker exists; applyUpdate must then plainly reload rather than wait
 * on a promise for something that was never there.
 */
let workerWaiting = false;

export function startUpdateWatch(): void {
  if (typeof window === "undefined") return;
  window.addEventListener(READY, () => { waiting = true; });
  apply = registerSW({
    onNeedRefresh() {
      workerWaiting = true;
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
        workerWaiting = true;
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
  if (apply && workerWaiting) void apply(true);
  else window.location.reload();
}

/**
 * Whether a newer app is waiting, for whoever is drawing the button.
 *
 * THE LATCH IS THE ANSWER, NOT THE EVENT, and this is the whole of the fix.
 * READY is dispatched once, when the worker arrives. A component that mounts
 * afterwards hears nothing — so it must ask `waiting`, which remembers.
 *
 * The till never noticed, because SellHeader mounts when the sell screen opens
 * and is still mounted on Friday: the deploy lands mid-session, into a
 * component that is already there. The phone is the opposite shape. PhoneHome
 * is the fallback branch — it unmounts for Deliveries, Quotes, the stock room,
 * Look it up, and the away lock — and an installed app is opened from the home
 * screen fresh every time, which is the case that loses. onRegisteredSW finds
 * the worker already waiting from last time and fires READY at module load,
 * before React has rendered anything at all; PhoneHome then mounts into a
 * signal that has already been and gone, and the owner is told to press a
 * button that is not on their screen.
 *
 * Both the initial value AND the effect read it, because they close different
 * halves of the same gap: the lazy init covers an event fired before this
 * mounted, and the effect covers one fired between the render and the listener
 * being attached.
 */
export function useUpdateReady(): boolean {
  const [ready, setReady] = useState(() => waiting);
  useEffect(() => {
    if (waiting) setReady(true);
    const on = () => setReady(true);
    window.addEventListener(READY, on);
    return () => window.removeEventListener(READY, on);
  }, []);
  return ready;
}
