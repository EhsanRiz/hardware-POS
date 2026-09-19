import { useEffect, useState } from "react";
import { phoneSummary, type PhoneSummary } from "../lib/api";
import { money } from "../lib/money";
import { rangeBounds } from "../lib/sales";
import { menuItems, type MenuItem } from "../lib/menu";
import { useCamera } from "../lib/useCamera";
import { useShopSettings } from "../lib/settings";
import InnovaMark from "./InnovaMark";
import InstallButton from "./InstallButton";
import AppMenu from "./AppMenu";
import BiometricSwitch from "./BiometricSwitch";
import NoticeBell from "./NoticeBell";
import { applyUpdate, useUpdateReady } from "../lib/appUpdate";
import { can } from "../lib/permissions";
import type { Notice } from "../lib/notices";
import type { User } from "../lib/types";

/**
 * What a phone is for.
 *
 * The counter is a 17" touch screen and always will be. A phone is the work
 * that happens away from it — photographing a supplier's quotation at the
 * trade counter, approving a discount down the line, deciding what to buy
 * while standing in front of the shelf that is empty.
 *
 * It opens on the DAY, not on a launcher. Nine tiles filled the screen with
 * nine doors and answered nothing, so whoever opened the app in the evening
 * had to guess which door had the figure they came for. Now the figures are
 * the screen and each one is the way into what it summarises; everything
 * else is behind one menu (lib/menu), the same menu Manage shows, so a
 * destination is the same two taps from wherever you are.
 *
 * Only what this person may see comes back from the server (0098), and with
 * the line down none of it shows rather than yesterday's — a figure that is
 * quietly stale is worse than no figure at all.
 */
export default function PhoneHome({
  user, online, deviceName, notices = [], onNotice, onReadNotices,
  onPick, onSignOut,
}: {
  user: User;
  online: boolean;
  deviceName: string;
  /** What needs somebody, for the bell beside the burger. */
  notices?: Notice[];
  onNotice?: (goes: Notice["goes"]) => void;
  /** Opening the bell asks the shop again. */
  onReadNotices?: () => void;
  onPick: (key: string) => void;
  onSignOut: () => void;
}) {
  const camera = useCamera();
  const shop = useShopSettings();
  const items = menuItems(user, camera);
  const [menuOpen, setMenuOpen] = useState(false);
  // A phone is installed to a home screen and then never navigated, exactly
  // like the till — so it goes just as stale, and the same button fixes it.
  const updateReady = useUpdateReady();

  const [figures, setFigures] = useState<PhoneSummary | null>(null);
  useEffect(() => {
    if (!online) return;
    let dead = false;
    const load = () => {
      const { from, to } = rangeBounds("today");
      // The shop's own day for "due today", not the server's: a delivery
      // due today must not read as late because the server is two hours on.
      const today = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")}`;
      phoneSummary(from, to, today)
        .then((f) => !dead && setFigures(f))
        .catch(() => undefined);
    };
    load();
    // A phone sits on a counter for an hour between glances.
    const timer = setInterval(load, 120_000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [online]);

  const open = (item: MenuItem) => {
    setMenuOpen(false);
    onPick(item.key);
  };
  /** A figure is a way in: tapping it opens the screen it is about. */
  const go = (key: string) => {
    if (items.some((i) => i.key === key)) onPick(key);
  };
  const f = figures;
  const waiting = f?.waiting_approval ?? 0;
  const late = f?.deliveries_late ?? 0;

  return (
    <div className="phone-home">
      <header className="phone-home-head">
        <div className="flex items-center gap-2">
          <button
            className="phone-burger"
            aria-label="Sections"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
          <InnovaMark size={22} />
          <span className="sell-wordmark">Innova<span>POS</span></span>
        </div>
        <div className="flex items-center gap-2">
          {/* What needs somebody, in the corner the eye already checks. The
              figures below say how the day is going; this says what is stuck. */}
          {onNotice && (
            <NoticeBell notices={notices} onGo={onNotice} onOpen={onReadNotices} canPush />
          )}
          {updateReady && (
            <button
              className="head-update"
              onClick={applyUpdate}
              title="A newer app is ready. Takes a few seconds."
            >
              ↻ Update
            </button>
          )}
          <button className="btn-line quiet" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      {menuOpen && (
        <AppMenu
          items={items}
          onPick={open}
          onClose={() => setMenuOpen(false)}
          footer={<BiometricSwitch user={user} />}
        />
      )}

      <div className="phone-home-who">
        <h1>{user.name}</h1>
        <p>
          {deviceName}
          {!online && <> · <span className="is-bad">no line</span></>}
        </p>
        {/* On the phone itself, where the person is: an app on the home
            screen is what makes it "their phone" rather than a web page. */}
        <InstallButton className="mt-3" />
      </div>

      {online && f && (
        <div className="phone-figures" aria-label="The day so far">
          {/* Whatever is standing still because nobody has looked. First,
              because it is why the app was opened at all, and absent
              entirely when there is nothing waiting. */}
          {(waiting > 0 || late > 0) && (
            <div className="phone-figure is-big is-urgent">
              <span className="phone-figure-label">Needs you now</span>
              {waiting > 0 && (
                <button className="phone-figure-line" onClick={() => go("approvals")}>
                  {waiting} {waiting === 1 ? "sale" : "sales"} waiting for a manager
                </button>
              )}
              {late > 0 && (
                <button className="phone-figure-line" onClick={() => go("deliveries")}>
                  {late} {late === 1 ? "delivery" : "deliveries"} past the day promised
                </button>
              )}
            </div>
          )}

          {f.taken != null && (
            <button className="phone-figure is-big is-tap" onClick={() => go("sales")}>
              <span className="phone-figure-label">Taken today</span>
              <span className="phone-figure-value">{money(f.taken)}</span>
              <span className="phone-figure-sub">
                {f.sales_count} {f.sales_count === 1 ? "sale" : "sales"}
                {f.cash_taken != null && f.card_taken != null && (
                  <> · cash {money(f.cash_taken)} · card {money(f.card_taken)}</>
                )}
              </span>
            </button>
          )}

          {/* What the drawer should be holding, by the till's own name. The
              same figure the cash-up screen counts against. */}
          {f.drawers != null && (
            <button className="phone-figure is-big is-tap" onClick={() => go("cashup")}>
              <span className="phone-figure-label">Money in the till</span>
              {f.drawers.length === 0 ? (
                <span className="phone-figure-sub">No drawer is open.</span>
              ) : (
                f.drawers.map((d, i) => (
                  <span className="phone-figure-row" key={i}>
                    <span>{d.till}</span>
                    <span className="phone-figure-amt">{money(d.expected)}</span>
                  </span>
                ))
              )}
            </button>
          )}

          {f.deliveries_out > 0 && (
            <button className="phone-figure is-tap" onClick={() => go("deliveries")}>
              <span className="phone-figure-label">Still to go</span>
              <span className="phone-figure-value">{f.deliveries_out}</span>
              <span className="phone-figure-sub">
                {f.deliveries_today} today{late > 0 ? ` · ${late} late` : ""}
              </span>
            </button>
          )}

          {f.low_stock != null && f.low_stock > 0 && (
            <button className="phone-figure is-tap" onClick={() => go("buying")}>
              <span className="phone-figure-label">Running low</span>
              <span className="phone-figure-value">{f.low_stock}</span>
              <span className="phone-figure-sub">
                {(f.low_names ?? []).join(", ")}
              </span>
            </button>
          )}

          {f.owed != null && f.owed > 0 && (
            <button className="phone-figure is-tap" onClick={() => go("reports")}>
              <span className="phone-figure-label">Owed to the shop</span>
              <span className="phone-figure-value">{money(f.owed)}</span>
            </button>
          )}
        </div>
      )}

      {!online && (
        <p className="phone-home-note" role="status">
          The line is down. Today's figures need a connection; what this phone
          already has is still in the menu.
        </p>
      )}

      {items.length === 0 && (
        <p className="phone-home-note">
          Nothing on this phone is yours to do yet. Whoever manages staff can
          give you what you need.
        </p>
      )}

      {/* A phone cannot take money. Said out loud, once, so nobody hunts for
          the till on it. */}
      {can(user, "take_payments") && (
        <p className="phone-home-foot">
          Selling happens at the counter — a phone cannot take money.
        </p>
      )}

      <footer className="phone-home-colophon">
        <p className="phone-home-shop">{shop.shop_name}</p>
        <p>
          InnovaPOS · a product of InnovaEarth
          <br />© {new Date().getFullYear()} InnovaEarth · All rights reserved
        </p>
      </footer>
    </div>
  );
}
