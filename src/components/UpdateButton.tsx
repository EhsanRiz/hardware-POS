import { useState } from "react";
import { applyUpdate, useUpdateReady } from "../lib/appUpdate";

/**
 * "There is a newer version than the one you are looking at."
 *
 * One component rather than the identical eight lines in SellHeader and in
 * PhoneHome. They had already drifted in their wording, and this session has
 * spent most of its time on faults that were two copies of one rule
 * disagreeing — a button whose press is delicate is not a thing to keep two
 * of.
 *
 * Amber and pulsing, because a fix that reaches the shop on Friday for a bug
 * reported on Tuesday might as well not have been written. Drawn only when
 * something is actually waiting, and the cashier chooses the moment: between
 * sales is a moment, halfway through one is not, and only they know which
 * this is.
 *
 * IT SAYS WHEN IT IS WORKING. Reported from the shop: "I click on update and
 * it doesn't do anything." Part of that was appUpdate.ts, fixed there — but
 * part is that taking an update means unregistering a worker and reloading,
 * which is not instant, and a button that looks identical the whole time
 * teaches the person pressing it that it is broken. So it changes, and it
 * stops accepting presses while it works: pressing again mid-handover
 * restarts a wait that was about to finish.
 */
export default function UpdateButton({ title }: { title: string }) {
  const ready = useUpdateReady();
  const [busy, setBusy] = useState(false);
  if (!ready) return null;
  return (
    <button
      className="head-update"
      disabled={busy}
      aria-busy={busy}
      onClick={() => {
        setBusy(true);
        // Never reset: every path through applyUpdate ends in a reload, so
        // this component is on its way out. Clearing it would only flicker
        // the label back a moment before the page goes.
        void applyUpdate();
      }}
      title={title}
    >
      {busy ? "Updating…" : "↻ Update"}
    </button>
  );
}
