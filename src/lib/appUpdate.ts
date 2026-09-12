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

/** A till left open all week still wants Tuesday's fix on Tuesday. */
const CHECK_EVERY_MS = 15 * 60 * 1000;

let apply: ((reload?: boolean) => Promise<void>) | null = null;

export function startUpdateWatch(): void {
  if (typeof window === "undefined") return;
  apply = registerSW({
    onNeedRefresh() {
      window.dispatchEvent(new Event(READY));
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      window.setInterval(() => void registration.update(), CHECK_EVERY_MS);
    },
  });
}

/** Take the update: activate the waiting worker and reload onto it. */
export function applyUpdate(): void {
  if (apply) void apply(true);
  // No worker registered (a dev build, or a browser that refused one) — a
  // plain reload still fetches the new files rather than doing nothing.
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
