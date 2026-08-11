import { InnovaLockup } from "../InnovaMark";
import { CheckIcon, CloudOffIcon, SyncIcon } from "./Icons";
import { registerName } from "../../lib/device";
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
  onShowFailed,
  onManage,
  onSignOut,
}: {
  user: User | null;
  online: boolean;
  pending: number;
  failed: number;
  canManage: boolean;
  onShowFailed: () => void;
  onManage: () => void;
  onSignOut: () => void;
}) {
  return (
    <header className="sell-head">
      <InnovaLockup edition="Hardware" />

      {/* Quotes, Accounts and Stock are deliberately absent from this build —
          the handoff puts them in the sibling products (Book and Bin), and a
          counter screen that tries to hold every operational reality at once is
          precisely what shopkeepers dislike about existing hardware POS. They
          are shown disabled rather than hidden so the shape of the product is
          honest about what is coming. */}
      <nav className="sell-nav" aria-label="Sections">
        <button aria-current="page">Sell</button>
        <button disabled title="Quotes arrive with InnovaBook">Quotes</button>
        <button disabled title="Accounts arrive with InnovaBook">Accounts</button>
        <button disabled title="Stock arrives with InnovaBin">Stock</button>
      </nav>

      <div className="sell-head-right">
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

        <span className="sell-cashier">{user?.name}</span>

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
