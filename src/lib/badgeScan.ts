import { useEffect, useRef } from "react";
import { asBadge } from "./auth";

/**
 * A staff badge scanned on a screen with nowhere to type it.
 *
 * The counter's scanner is a keyboard: it types the code and presses Enter.
 * The sign-in and lock screens have no text box for it to land in, so this
 * listens to the keys themselves and keeps the last burst. A burst is keys
 * less than GAP_MS apart — a scanner sends a whole code in a few milliseconds,
 * and nobody types that fast — so a person's stray keys never join one.
 *
 * Listens in the capture phase, ahead of the PIN pad's own keyboard handling:
 * the pad already treats a burst with letters in it as a scan and lets it go
 * (PinPad, SCAN_GAP_MS), so a badge costs nobody a PIN try.
 *
 * Only a well-formed badge reaches `onBadge`. Anything else scanned here — a
 * product, a slip — is ignored, as it always was.
 */
const GAP_MS = 120;

export function useBadgeScan(onBadge: (code: string) => void, enabled = true): void {
  const handler = useRef(onBadge);
  handler.current = onBadge;

  useEffect(() => {
    if (!enabled) return;
    let buf = "";
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const now = Date.now();
      if (now - last > GAP_MS) buf = "";
      last = now;
      if (e.key === "Enter") {
        const code = asBadge(buf);
        buf = "";
        if (code) {
          e.preventDefault();
          handler.current(code);
        }
        return;
      }
      if (e.key.length === 1) buf = (buf + e.key).slice(-40);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
