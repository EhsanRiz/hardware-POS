import { useEffect, useRef, useState } from "react";
import { BellIcon } from "./sell/Icons";
import { cacheGet, cacheSet } from "../lib/localCache";
import { pushState, turnPushOff, turnPushOn, type PushState } from "../lib/push";
import {
  dayOf, notToday, putAside, signature, stillWaiting, type Notice,
} from "../lib/notices";

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
  notices: all,
  onGo,
  onOpen,
  canPush = false,
}: {
  notices: Notice[];
  /** A menu key — the same router the menu goes through. */
  onGo: (goes: Notice["goes"]) => void;
  /**
   * Opening the bell asks the shop again.
   *
   * Without this a notice stayed on the list for up to two minutes after it
   * was dealt with — approve the sale, come back, and it is still there —
   * which is exactly how somebody learns the bell is not to be trusted.
   */
  onOpen?: () => void;
  /**
   * Whether to offer being told with the app shut.
   *
   * A phone only. The till is a machine somebody is already standing at, and
   * a notification on a screen the customer can read is a worse idea than no
   * notification at all.
   */
  canPush?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string>(() => cacheGet<string>(SEEN_KEY, ""));
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  /**
   * Where the panel hangs, measured rather than guessed.
   *
   * Hung off the button's own right edge it ran off the left of a phone: the
   * bell is nowhere near the screen's edge (Sign out is beyond it), so a
   * 22rem panel ending at the bell starts at about minus sixty. On a phone it
   * spans the screen instead, between the same gutters as everything else;
   * on a wide screen it still hangs under the bell where it was pressed.
   */
  const [where, setWhere] = useState<React.CSSProperties>({});
  // Whether this phone will be told when the app is shut. Asked for only
  // when the panel is opened: the browser's own answer needs the service
  // worker, and it is nobody's business at boot.
  const [push, setPush] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  // What has been waved away today, and therefore what is actually on the
  // list. Held in state so pressing "Not today" redraws at once.
  const [aside, setAside] = useState(putAside);
  const notices = stillWaiting(all, aside, dayOf(new Date()));

  const now = signature(notices);
  const fresh = notices.length > 0 && now !== seen;

  // Opening it IS reading it. Stored, so the dot does not come back on the
  // next load for a list somebody has already looked at.
  useEffect(() => {
    if (!open) return;
    setSeen(now);
    cacheSet(SEEN_KEY, now);
  }, [open, now]);

  // And asks the shop for the current state of things while it is at it.
  useEffect(() => {
    if (open) onOpen?.();
  }, [open, onOpen]);

  useEffect(() => {
    if (!open || !canPush) return;
    let dead = false;
    void pushState().then((s) => !dead && setPush(s));
    return () => {
      dead = true;
    };
  }, [open, canPush]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r) return;
      const gutter = 12;
      setWhere(
        window.innerWidth < 600
          ? { top: r.bottom + 6, left: gutter, right: gutter }
          : { top: r.bottom + 6, right: Math.max(gutter, window.innerWidth - r.right), width: "22rem" }
      );
    };
    place();
    // A phone turned on its side, or a till window dragged narrower.
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

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
        ref={btn}
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
        {/* Drawn rather than an emoji: 🔔 is a yellow picture that ignores
            the colour around it, and this button sits on the green bar. */}
        <BellIcon size={20} />
        {fresh && <span className="bell-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="bell-panel" role="dialog" aria-label="What needs you" style={where}>
          {notices.length === 0 ? (
            <p className="bell-none">Nothing needs you.</p>
          ) : (
            <ul className="bell-list">
              {notices.map((n) => (
                <li key={n.kind}>
                  <div className="bell-item">
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
                    {/* Not "dismiss": the thing is still true. This says "I
                        know", and it comes back tomorrow — or sooner, if more
                        of them pile up. */}
                    <button
                      type="button"
                      className="bell-later"
                      aria-label={`Not today: ${n.line}`}
                      onClick={() => {
                        notToday(n.kind, n.count, new Date());
                        setAside(putAside());
                      }}
                    >
                      Not today
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {notices.length > 0 && (
            <p className="bell-foot">
              A line goes when the thing is done. “Not today” puts one aside
              until tomorrow.
            </p>
          )}

          {/* Being told with the app shut. Only two things are ever sent —
              a sale waiting for a manager, a load that should have gone —
              because a phone that buzzes about the reorder level at nine at
              night is a phone with notifications switched off. */}
          {canPush && push && push !== "unsupported" && (
            <div className="bell-push">
              {push === "blocked" ? (
                <p className="bell-foot">
                  This phone is set to block notifications from the app. Its
                  own settings are the only place that can be undone.
                </p>
              ) : (
                <button
                  type="button"
                  // Its own class, NOT btn-line: the header this panel hangs
                  // from paints .btn-line.quiet for a dark green bar, and the
                  // panel is cream — which came out pale on pale, and white
                  // on hover.
                  className="bell-switch"
                  disabled={pushBusy}
                  onClick={() => {
                    setPushBusy(true);
                    const change = push === "on" ? turnPushOff() : turnPushOn();
                    void change
                      .then(setPush)
                      .catch(() => setPush("off"))
                      .finally(() => setPushBusy(false));
                  }}
                >
                  {push === "on"
                    ? "Stop telling me when the app is shut"
                    : "Tell me when the app is shut"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
