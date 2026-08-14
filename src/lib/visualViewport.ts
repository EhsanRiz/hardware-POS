/**
 * Where the screen actually is, once the on-screen keyboard has taken its half.
 *
 * iOS Safari does not shrink the LAYOUT viewport when a keyboard opens — it
 * shrinks only what you can see. A dialog pinned with `inset: 0` and centred
 * therefore centres itself on a full-height page that is mostly hidden, and the
 * keyboard covers its lower half. On an iPad, tapping Discount showed the title
 * and nothing else: no amount box, no Apply, no way back except dismissing the
 * keyboard by hand.
 *
 * So the visible rectangle is published as two custom properties and the
 * dialogs pin themselves to that instead. `visualViewport` is the only thing
 * that reports it; `100dvh` tracks the keyboard on some browsers and not on
 * others, and is the fallback here rather than the mechanism.
 *
 * Android Chrome is handled by `interactive-widget=resizes-content` in the
 * viewport meta, which makes the layout viewport shrink properly. Safari
 * ignores that today, which is why this exists as well and not instead.
 */
export function trackVisualViewport(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};

  const root = document.documentElement;
  const apply = () => {
    root.style.setProperty("--vv-height", `${vv.height}px`);
    // How far the visible rectangle has slid down the page. A fixed element
    // that ignores this sits above the top of the screen once iOS scrolls the
    // page to bring a focused field into view.
    root.style.setProperty("--vv-top", `${vv.offsetTop}px`);
  };

  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
  };
}
