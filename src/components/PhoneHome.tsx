import type { ReactNode } from "react";
import InnovaMark from "./InnovaMark";
import { can, canAny } from "../lib/permissions";
import type { PermKey } from "../lib/permissions";
import type { User } from "../lib/types";

/**
 * What a phone is for.
 *
 * The counter is a 17" touch screen and always will be. A phone is the work
 * that happens away from it — photographing a supplier's quotation at the
 * trade counter, approving a discount down the line, deciding what to buy
 * while standing in front of the shelf that is empty.
 *
 * So this is not the till with smaller buttons, and it is not the section nav
 * rearranged. It is a short, curated list of the things somebody actually
 * reaches for when they are NOT at the counter, biggest first, sized for one
 * thumb. Curated is the operative word: every feature added from here on has
 * to earn its place on this screen rather than being appended to it, or in a
 * year it is a launcher with twenty tiles and no one can find anything.
 *
 * Nothing here grants anything. Every tile leads to a screen that checks the
 * same permission server-side it always did, and the database refuses money on
 * a personal device outright (0074). Hiding a tile is a courtesy, not a lock.
 */

export interface Tile {
  key: string;
  label: string;
  hint: string;
  icon: ReactNode;
  /** Shown only if the signer holds at least one of these. */
  perms: PermKey[];
  /** Needs the line up — greyed and explained when there is none. */
  online?: boolean;
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="30" height="30" fill="none"
    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d={d} />
  </svg>
);

export const PHONE_TILES: Tile[] = [
  {
    key: "scan",
    label: "Scan a document",
    hint: "A supplier's quote or invoice, photographed and filed",
    perms: ["manage_purchasing"],
    online: true,
    icon: <Icon d="M3 9V6a3 3 0 0 1 3-3h3M21 9V6a3 3 0 0 0-3-3h-3M3 15v3a3 3 0 0 0 3 3h3M21 15v3a3 3 0 0 1-3 3h-3M7 12h10" />,
  },
  {
    key: "approvals",
    label: "Approve a discount",
    hint: "Issue a code down the phone",
    perms: ["approve_discount"],
    online: true,
    icon: <Icon d="M9 12l2 2 4-4M12 3l7 4v5c0 4.4-3 8.3-7 9-4-.7-7-4.6-7-9V7l7-4z" />,
  },
  {
    key: "buying",
    label: "Buying",
    hint: "What to order, orders out, what you owe",
    perms: ["manage_purchasing"],
    online: true,
    icon: <Icon d="M3 4h2l2.7 11.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 8H6M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" />,
  },
  {
    key: "lookup",
    label: "Look it up",
    hint: "Price, what's on the shelf, and where",
    // Anybody who can be signed in at all can answer "have you got it".
    perms: [],
    icon: <Icon d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3" />,
  },
  {
    key: "tillai",
    label: "Ask TillAI",
    hint: "Stock, prices, who bought what — and the day's takings if they are yours to see",
    // The same assistant as the bubble on the till, and the same rule: it
    // sees what this person can already see, nothing more.
    perms: [],
    online: true,
    icon: <Icon d="M4 5h16v11H9l-5 4V5zM8 9h8M8 12h5" />,
  },
  {
    key: "shelf",
    label: "Photograph shelf items",
    hint: "Barcodes and pictures, from the aisle",
    perms: ["shelf_capture", "manage_catalogue"],
    online: true,
    icon: <Icon d="M4 7h3l2-2h6l2 2h3v12H4V7zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />,
  },
  {
    key: "low",
    label: "What's low",
    hint: "Everything at or below its reorder level",
    perms: ["manage_inventory", "manage_purchasing"],
    online: true,
    icon: <Icon d="M12 9v5M12 17.5v.5M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" />,
  },
  {
    key: "today",
    label: "Today",
    hint: "What the shop has taken so far",
    perms: ["view_reports"],
    online: true,
    icon: <Icon d="M3 20V10M9 20V4M15 20v-7M21 20V8" />,
  },
];

export default function PhoneHome({
  user, online, deviceName, onPick, onSignOut,
}: {
  user: User;
  online: boolean;
  deviceName: string;
  onPick: (key: string) => void;
  onSignOut: () => void;
}) {
  const tiles = PHONE_TILES.filter(
    (t) => t.perms.length === 0 || canAny(user, t.perms)
  );

  return (
    <div className="phone-home">
      <header className="phone-home-head">
        <div className="flex items-center gap-2">
          <InnovaMark size={22} />
          <span className="sell-wordmark">Innova<span>POS</span></span>
        </div>
        <button className="btn-line quiet" onClick={onSignOut}>Sign out</button>
      </header>

      <div className="phone-home-who">
        <h1>{user.name}</h1>
        <p>
          {deviceName}
          {!online && <> · <span className="is-bad">no line</span></>}
        </p>
      </div>

      {tiles.length === 0 ? (
        <p className="acc-note">
          Nothing on this phone is yours to do yet. Whoever manages staff can
          give you what you need.
        </p>
      ) : (
        <div className="phone-tiles">
          {tiles.map((t) => {
            const off = t.online && !online;
            return (
              <button
                key={t.key}
                className="phone-tile"
                disabled={off}
                onClick={() => onPick(t.key)}
              >
                <span className="phone-tile-icon">{t.icon}</span>
                <span className="phone-tile-label">{t.label}</span>
                <span className="phone-tile-hint">
                  {/* A tile that needs the line says so, rather than looking
                      broken or — worse — showing yesterday's figure as today's. */}
                  {off ? "Needs a connection" : t.hint}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* A phone cannot take money. Said out loud, once, so nobody hunts for
          the till on it. */}
      {can(user, "take_payments") && (
        <p className="phone-home-foot">
          Selling happens at the counter — a phone cannot take money.
        </p>
      )}
    </div>
  );
}
