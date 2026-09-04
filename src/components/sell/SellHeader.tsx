import { InnovaLockup } from "../InnovaMark";
import { CalcIcon, CheckIcon, CloudOffIcon, SyncIcon } from "./Icons";
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
  section?: "sell" | "accounts" | "stock" | "quotes";
  /** Whether this user may open Accounts at all. */
  canAccounts?: boolean;
  /** Whether this user may open Quotes (same right as selling). */
  canQuotes?: boolean;
  /** Whether this user may open Stock (manage_inventory). */
  canStock?: boolean;
  onSection?: (s: "sell" | "accounts" | "stock" | "quotes") => void;
  onShowFailed: () => void;
  onManage: () => void;
  onSignOut: () => void;
  /** Open or close the floating calculator. */
  onCalculator?: () => void;
}) {
  return (
    <header className="sell-head">
      <InnovaLockup edition="Hardware" onGreen />

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
        <SyncChip
          online={online}
          pending={pending}
          failed={failed}
          onShowFailed={onShowFailed}
        />

        <span className="sell-till">
          {registerName()} · {shopSettings().shop_name}
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
