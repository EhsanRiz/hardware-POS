import { useEffect, type ReactNode } from "react";
import type { MenuItem } from "../lib/menu";

/**
 * The app's menu on a phone: a compact card under the burger, not a screen
 * of its own. The page stays visible behind a light scrim — a menu that
 * swallows the display reads as "you have left", and losing sight of the
 * work in progress is the cost. Rows keep their full height; a menu you
 * mis-tap is worse than a menu that is a little tall.
 *
 * Rendered from lib/menu so the home and Manage can never drift into
 * offering different lists.
 */
export default function AppMenu({
  items, current, onPick, onClose, badges = {}, footer,
}: {
  items: MenuItem[];
  /** The destination already open, ticked and not worth tapping. */
  current?: string;
  onPick: (item: MenuItem) => void;
  onClose: () => void;
  /** A word beside a row, e.g. how many people are waiting on a PIN. */
  badges?: Record<string, string>;
  /**
   * Settings for THIS device, under the destinations.
   *
   * Not a MenuItem: those are places, drawn from lib/menu so the home and
   * Manage can never offer different lists, and a switch is neither a place
   * nor something Manage's tab strip should grow. The phone's home passes
   * one; Manage passes none.
   */
  footer?: ReactNode;
}) {
  // Escape closes it, as it closes every other overlay here. Without this a
  // menu opened by mistake could only be dismissed by tapping the scrim.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Not hidden above a phone's width. In Manage the burger that opens this
  // is itself under sm, with the tab strip above it, so this can only be
  // reached there on a narrow screen anyway — but the phone's HOME has no
  // other navigation at all, and a personal device that happens to be wide
  // (somebody's iPad) would have had a menu it could never see.
  return (
    <div>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div
        className="absolute left-2 top-16 z-50 w-72 bg-white border border-stone-200 rounded-2xl shadow-xl overflow-hidden"
        role="menu"
        aria-label="Sections"
      >
        {items.map((t) => (
          <button
            key={t.key}
            role="menuitem"
            onClick={() => onPick(t)}
            aria-current={current === t.key ? "page" : undefined}
            className={`w-full flex items-center gap-2 text-left px-4 py-3 text-[15px] border-b border-stone-100 last:border-b-0 ${
              current === t.key ? "bg-gold-100 font-medium" : "hover:bg-stone-50"
            }`}
          >
            {t.label}
            {badges[t.key] && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                {badges[t.key]}
              </span>
            )}
            {current === t.key && (
              <span aria-hidden="true" className="ml-auto">
                ✓
              </span>
            )}
          </button>
        ))}
        {footer && <div className="border-t border-stone-200 p-3">{footer}</div>}
      </div>
    </div>
  );
}
