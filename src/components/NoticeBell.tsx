import { useEffect, useRef, useState } from "react";
import { cacheGet, cacheSet } from "../lib/localCache";
import { signature, type Notice } from "../lib/notices";

const SEEN_KEY = "notices.seen";

/**
 * The bell, and the short list behind it.
 *
 * It carries a dot, not a number. A number invites arithmetic nobody does —
 * is 7 worse than 5? — while the dot answers the only question the counter
 * asks in passing: is there anything new since I looked. What is actually
 * waiting is one tap away and written in words.
 *
 * Nothing here is "dismissed". Every row is a live condition (lib/notices),
 * so the way to clear one is to go and do it; the bell offers the way rather
 * than a tick box. A bell you can silence without fixing anything is a bell
 * that gets silenced.
 */
export default function NoticeBell({
  notices,
  onGo,
}: {
  notices: Notice[];
  /** A menu key — the same router the menu goes through. */
  onGo: (goes: Notice["goes"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string>(() => cacheGet<string>(SEEN_KEY, ""));
  const box = useRef<HTMLDivElement>(null);

  const now = signature(notices);
  const fresh = notices.length > 0 && now !== seen;

  // Opening it IS reading it. Stored, so the dot does not come back on the
  // next load for a list somebody has already looked at.
  useEffect(() => {
    if (!open) return;
    setSeen(now);
    cacheSet(SEEN_KEY, now);
  }, [open, now]);

  // Escape, and a tap anywhere else. A panel that can only be closed by the
  // button that opened it is a panel in the way.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", away);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", away);
    };
  }, [open]);

  return (
    <div className="bell-wrap" ref={box}>
      <button
        type="button"
        className={`bell${fresh ? " is-fresh" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={
          notices.length === 0
            ? "Nothing needs you"
            : notices.length === 1
            ? "1 thing needs you"
            : `${notices.length} things need you`
        }
      >
        <span aria-hidden="true">🔔</span>
        {fresh && <span className="bell-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="bell-panel" role="dialog" aria-label="What needs you">
          {notices.length === 0 ? (
            <p className="bell-none">Nothing needs you.</p>
          ) : (
            <ul className="bell-list">
              {notices.map((n) => (
                <li key={n.kind}>
                  <button
                    type="button"
                    className="bell-row"
                    onClick={() => {
                      setOpen(false);
                      onGo(n.goes);
                    }}
                  >
                    <span className="bell-count tabular">{n.count}</span>
                    <span className="bell-line">{n.line}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
