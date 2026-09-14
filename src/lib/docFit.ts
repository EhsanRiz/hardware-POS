import { useCallback, useEffect, useRef } from "react";

/**
 * An A4 document, shrunk to fit the screen it is being read on.
 *
 * `.doc-a4` is 210mm wide because it IS a page: it prints, and what prints
 * has to be the paper. On a phone that is about 794px inside a 390px screen,
 * so the sheet sat in a sideways scroller with its row labels off the left
 * edge and its figures stranded on the right — and the box it scrolled in
 * kept the full page height, which is where the acre of white came from.
 *
 * Reflowing it into cards was the other option and it is the wrong one: this
 * is the document that goes to the customer, and a preview that does not
 * look like the paper is not a preview. So it is zoomed instead, the way
 * every PDF reader does it. `zoom` rather than `transform: scale` because
 * zoom takes the layout with it — a transform leaves the original box
 * behind, which is the white space again.
 */
export function useDocFit() {
  const el = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const box = el.current;
    if (!box) return;
    // The page's own width in px, read from the element rather than assumed:
    // 210mm is a physical unit and the browser decides what that is.
    const page = box.querySelector<HTMLElement>(".doc-a4");
    if (!page) return;
    const paper = page.getBoundingClientRect().width / (currentZoom(box) || 1);
    const room = box.clientWidth - 8;
    const zoom = paper > 0 && room > 0 ? Math.min(1, room / paper) : 1;
    box.style.setProperty("--doc-zoom", String(Math.round(zoom * 1000) / 1000));
  }, []);

  const ref = useCallback((node: HTMLElement | null) => {
    el.current = node;
    if (node) measure();
  }, [measure]);

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    if (el.current) ro.observe(el.current);
    return () => ro.disconnect();
  }, [measure]);

  return ref;
}

/** What the box is zoomed by now, so a re-measure is not measuring itself. */
function currentZoom(box: HTMLElement): number {
  const v = Number(getComputedStyle(box).getPropertyValue("--doc-zoom"));
  return Number.isFinite(v) && v > 0 ? v : 1;
}
