/**
 * A number field selects what is in it when you tap it.
 *
 * Tapping the quantity on a purchase order put the caret in front of the
 * figure, so typing a new count prepended to the old one and correcting it
 * meant backspacing through it first. On a number you are almost always
 * replacing the whole thing, which is what a till's own keypad does and what
 * every stocktake sheet assumes.
 *
 * Installed once at boot rather than as an onFocus on each of the three
 * dozen numeric inputs in the app: this is a rule about what a number field
 * IS here, and the one that gets forgotten is the one somebody is standing
 * in an aisle fighting with. A second tap still puts the caret where the
 * finger is, so editing one digit is not taken away.
 */
export function installNumberSelect(): void {
  if (typeof document === "undefined") return;
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target as HTMLInputElement | null;
      if (!el || el.tagName !== "INPUT") return;
      const mode = el.getAttribute("inputmode");
      if (mode !== "decimal" && mode !== "numeric") return;
      if (el.readOnly || el.disabled || !el.value) return;
      // After the browser has placed its own caret, or it wins.
      requestAnimationFrame(() => {
        // Still the field being typed in, and still holding what we saw.
        if (document.activeElement === el) el.select();
      });
    },
    true
  );
}
