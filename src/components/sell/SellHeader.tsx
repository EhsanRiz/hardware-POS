import InnovaMark from "../InnovaMark";
import { CalcIcon, CheckIcon, CloudOffIcon, SyncIcon } from "./Icons";
import { applyUpdate, useUpdateReady } from "../../lib/appUpdate";
import { registerName } from "../../lib/device";
import { roleTitle } from "../../lib/permissions";
import { shopSettings } from "../../lib/settings";
import type { User } from "../../lib/types";

/**
 * The Sell screen's header bar — design_handoff_innovapos §1.1.
 *
 * Lockup, then the tabs, then a right cluster that answers the three questions
 * a cashier glances up to check: is my work safe, which till am I on, and who
 * am I signed in as.
 */
export default function SellHeader({
  user,
  online,
  pending,
  failed,
  canManage,
  section = "sell",
  canAccounts = false,
  canQuotes = false,
  canStock = false,
  onSection,
  onShowFailed,
  onManage,
  onSignOut,
  onCalculator,
}: {
  user: User | null;
  online: boolean;
  pending: number;
  failed: number;
  canManage: boolean;
  /** Which section is on screen; drives the highlighted tab. */
  section?: "sell" | "accounts" | "stock" | "quotes" | "deliveries";
  /** Whether this user may open Accounts at all. */
  canAccounts?: boolean;
  /** Whether this user may open Quotes (same right as selling). */
  canQuotes?: boolean;
  /** Whether this user may open Stock (manage_inventory). */
  canStock?: boolean;
  onSection?: (
    s: "sell" | "accounts" | "stock" | "quotes" | "deliveries"
  ) => void;
  onShowFailed: () => void;
  onManage: () => void;
  onSignOut: () => void;
  /** Open or close the floating calculator. */
  onCalculator?: () => void;
}) {
  const updateReady = useUpdateReady();

  return (
    <header className="sell-head">
      {/* The SHOP's name at the masthead, not the software's.
          This is the one screen whose whole audience already knows what they
          are looking at, and a counter serves more than one till: which shop,
          and which register, is the useful thing in the corner of the eye.
          InnovaPOS keeps the mark beside it, signs the footer, and is on every
          slip that leaves the building — nothing is lost by not spelling it
          out here, and the name of the shop costs no more width than the
          wordmark it replaces.
          Falls back to the wordmark when the settings have not arrived yet, so
          a till mid-boot never shows an empty corner. */}
      <div className="sell-lockup">
        <InnovaMark size={26} onGreen />
        <span className="sell-shop" title={registerName()}>
          {shopSettings().shop_name || "InnovaPOS"}
        </span>
      </div>

      {/* Every section lives on the till, because the people doing this work
          are standing at this tablet: the cashier quoting a builder, the
          bookkeeper's question about an account, the person checking a
          delivery at the back door. */}
      <nav className="sell-nav" aria-label="Sections">
        <button
          aria-current={section === "sell" ? "page" : undefined}
          onClick={() => onSection?.("sell")}
        >
          Sell
        </button>
        <button
          aria-current={section === "quotes" ? "page" : undefined}
          disabled={!canQuotes}
          title={canQuotes ? undefined : "Needs the take-payments permission"}
          onClick={() => onSection?.("quotes")}
        >
          Quotes
        </button>
        {/* No permission on it at all. Whoever is loading the bakkie needs to
            know what is on it, and that is not always the person who can open
            Accounts. */}
        <button
          aria-current={section === "deliveries" ? "page" : undefined}
          onClick={() => onSection?.("deliveries")}
        >
          Deliveries
        </button>
        <button
          aria-current={section === "accounts" ? "page" : undefined}
          disabled={!canAccounts}
          title={canAccounts ? undefined : "Needs the take-payments permission"}
          onClick={() => onSection?.("accounts")}
        >
          Accounts
        </button>
        {/* Not shown at all without the permission. A greyed tab a cashier
            can never open is a question asked on every shift; the tab is
            there for the people who can go through it. */}
        {canStock && (
          <button
            aria-current={section === "stock" ? "page" : undefined}
            onClick={() => onSection?.("stock")}
          >
            Stock
          </button>
        )}
      </nav>

      <div className="sell-head-right">
        {/* Quick sums — a builder's "3 sheets at 289 less 10%" worked out
            without touching the sale in progress. Floats over the till. */}
        {onCalculator && (
          <button
            className="head-calc-btn"
            aria-label="Calculator"
            title="Calculator"
            onClick={onCalculator}
          >
            <CalcIcon />
          </button>
        )}
        {/* Only when there is something to take. It is amber and it pulses,
            because a fix that reaches the shop on Friday for a bug reported on
            Tuesday might as well not have been written — and the cashier is
            the only one who knows whether this second is between sales or in
            the middle of one. */}
        {updateReady && (
          <button
            className="head-update"
            onClick={applyUpdate}
            title="A newer till is ready. Takes a few seconds."
          >
            ↻ Update
          </button>
        )}
        <SyncChip
          online={online}
          pending={pending}
          failed={failed}
          onShowFailed={onShowFailed}
        />

        {/* Which till this is — and only that. It carried the shop name too,
            which at 0.11em tracking in capitals came to 315px of header and
            was what pushed Sign out off a 1366 laptop. The shop's name is now
            at the masthead instead, where it costs nothing: this stays the
            register, because on a counter with two of them that is the part
            that differs. */}
        <span className="sell-till" title={shopSettings().shop_name}>
          {registerName()}
        </span>

        <span className="sell-divider-v" />

        {/* Who is serving, and in what capacity. The title sits under the name
            in a quieter colour because it is context rather than content: on a
            shared till the question at a glance is "whose shift is this", and
            the answer is only useful if the name is what carries. */}
        <span className="sell-cashier">
          <span className="sell-cashier-name">{user?.name}</span>
          <span className="sell-cashier-role">{roleTitle(user?.role)}</span>
        </span>

        {canManage && (
          <button className="btn-line" style={{ minHeight: 38 }} onClick={onManage}>
            Manage
          </button>
        )}
        <button className="btn-line quiet" style={{ minHeight: 38 }} onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}

/**
 * The one connection indicator on the screen, and it reports rather than gates.
 *
 * "Offline" is stated plainly, not dressed as an error: on a load-shedding day
 * it is the normal condition, and a cashier who is trained to fear the word
 * starts refusing sales the product can actually complete. Failures are the
 * exception that earns alarm — those are sales the server rejected, and they
 * need a person.
 */
function SyncChip({
  online,
  pending,
  failed,
  onShowFailed,
}: {
  online: boolean;
  pending: number;
  failed: number;
  onShowFailed: () => void;
}) {
  if (failed > 0) {
    return (
      <button className="sync-chip is-failed" onClick={onShowFailed}>
        {failed} need attention
      </button>
    );
  }
  if (!online) {
    return (
      <span className="sync-chip is-offline">
        <CloudOffIcon />
        {pending > 0 ? `Offline · ${pending} queued` : "Offline"}
      </span>
    );
  }
  if (pending > 0) {
    return (
      <span className="sync-chip">
        <SyncIcon />
        Syncing {pending}
      </span>
    );
  }
  return (
    <span className="sync-chip">
      <CheckIcon />
      Synced
    </span>
  );
}
