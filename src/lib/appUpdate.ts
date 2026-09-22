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
 * How long to let the waiting worker take over before stopping waiting on it.
 *
 * Three seconds: long enough for a handover that is going to happen, short
 * enough that a cashier who pressed a button is not left watching a screen
 * that has not changed and wondering whether they pressed it.
 */
const TAKEOVER_MS = 3000;

/**
 * Take the update.
 *
 * Activates the worker that is waiting and reloads the page onto it, so every
 * change in that version — markup, styles, and the service worker's own
 * precache — is what the till is running afterwards. Nobody has to refresh
 * anything by hand; pressing the button IS the refresh, and it is one press
 * because the cashier is the only one who knows this second is between sales.
 *
 * REPORTED FROM A LAPTOP AT THE SHOP: "I click on update when it appears and
 * it doesn't do anything; however, I get the feature when I Shift+Cmd+R."
 * Both halves of this used to be able to do nothing at all.
 *
 *   THE PLAIN RELOAD COULD NOT WORK. index.html is precached — it is in
 *   globPatterns — so the service worker answers navigations out of its own
 *   cache. location.reload() therefore asked the OLD worker for the OLD app
 *   and got it: same page, same bundle, no visible effect. A hard reload is
 *   the one thing that goes past the worker, which is exactly the asymmetry
 *   that was reported. This path now removes the worker first, so the reload
 *   has nobody left to serve it and must go to the network.
 *
 *   AND THE HANDOVER HAD NO END. apply(true) posts SKIP_WAITING and reloads
 *   when the new worker takes control. If it never does — the worker was
 *   already activated by an earlier hard reload, or it failed to install —
 *   there was no timeout, no catch and no change on screen. A press that
 *   silently failed looked exactly like a press that did nothing, on the one
 *   control telling the shop an update exists.
 *
 * So: ask nicely, wait a bounded time, and if the worker has not taken over,
 * take the update the blunt way rather than leaving the counter stuck on a
 * version it has been told to move off.
 */
export async function applyUpdate(): Promise<void> {
  if (apply && workerWaiting) {
    const tookOver = await new Promise<boolean>((resolve) => {
      if (!("serviceWorker" in navigator)) return resolve(false);
      const sw = navigator.serviceWorker;
      let settled = false;
      const settle = (v: boolean) => {
        if (settled) return;
        settled = true;
        sw.removeEventListener("controllerchange", onSwap);
        resolve(v);
      };
      const onSwap = () => settle(true);
      sw.addEventListener("controllerchange", onSwap);
      window.setTimeout(() => settle(false), TAKEOVER_MS);
      // A rejection here is not a reason to give up — the fallback below is
      // what the press promised, and it runs either way.
      void apply!(true).catch(() => {});
    });
    // The new worker is in charge, so a reload now is served from ITS
    // precache. registerSW reloads too; calling it twice costs nothing and
    // not calling it at all is how a press comes to do nothing.
    if (tookOver) {
      window.location.reload();
      return;
    }
  }
  await reloadFromNetwork();
}

/**
 * A reload the service worker cannot answer.
 *
 * There is no way to ask for a hard reload from script, so the worker is
 * unregistered instead: with no registration left, the navigation has nobody
 * to intercept it and goes to the network, which is what Shift+Cmd+R does by
 * hand. The caches are left alone deliberately — they are only ever reached
 * THROUGH a worker, so an unregistered one makes them unreachable, and
 * deleting them would throw away every cached photograph for nothing.
 *
 * The till is without a worker for the length of one navigation. The new page
 * calls startUpdateWatch() and registers again, so it comes back offline-
 * capable on its own; and a till that cannot take an update is worse off than
 * one that is briefly online-only.
 */
async function reloadFromNetwork(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.unregister();
    }
  } catch {
    // Best effort. A browser that refuses to unregister still gets the reload
    // below, which is no worse than what this function replaced.
  }
  window.location.reload();
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
