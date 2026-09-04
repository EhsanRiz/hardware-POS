import { useCallback, useEffect, useState } from "react";
import {
  customerLedger,
  takeAccountPayment,
  voidAccountPayment,
} from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/money";
import { useOnline } from "../../lib/offline";
import { can } from "../../lib/permissions";
import { formatPhone } from "../../lib/phone";
import { printReceipt } from "../../lib/print";
import { buildStatementText } from "../../lib/receipt";
import type { AccountRow, LedgerEntry, User } from "../../lib/types";
import ManagerPinModal from "../ManagerPinModal";
import { fmtDate } from "../../lib/dates";

const METHODS = [
  { key: "cash", label: "Cash" },
  { key: "card", label: "Card" },
  { key: "eft", label: "EFT" },
  { key: "zapper", label: "Zapper" },
] as const;

/**
 * One account: what they were charged, what they paid, and taking money off it.
 *
 * Taking a payment is deliberately the most prominent thing on the screen. It
 * is the action that was missing entirely until now, and it is what someone
 * standing at the counter with cash in their hand is waiting for.
 */
export default function AccountDetail({
  account,
  user,
  onBack,
}: {
  account: AccountRow;
  user: User;
  onBack: () => void;
}) {
  const online = useOnline();
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [balance, setBalance] = useState(account.balance);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("cash");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState<LedgerEntry | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await customerLedger(account.id));
    } catch (e) {
      setError(errorMessage(e, "Could not load the account"));
    }
  }, [account.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const due = Number(amount.replace(/[^\d.]/g, "")) || 0;

  async function take() {
    if (due <= 0) return;
    setBusy(true);
    setError(null);
    setBanner(null);
    try {
      // The replay guard travels with the payment: one tap, one credit, even if
      // the tablet fires twice or the reply is lost on a bad line.
      const res = await takeAccountPayment(
        user.id,
        account.id,
        due,
        method,
        reference || null,
        null,
        crypto.randomUUID()
      );
      setBalance(res.balance);
      setBanner(
        `${money(due)} received. ${
          res.balance > 0
            ? `${money(res.balance)} still owing.`
            : res.balance < 0
              ? `${money(-res.balance)} in credit.`
              : "Account settled."
        }`
      );
      setAmount("");
      setReference("");
      await load();
    } catch (e) {
      setError(errorMessage(e, "That payment could not be recorded"));
    } finally {
      setBusy(false);
    }
  }

  function printStatement() {
    if (!entries) return;
    printReceipt(
      buildStatementText(
        { name: account.name, phone: account.phone, code: account.code },
        entries,
        balance,
        {
          current: account.current_due,
          days30: account.days30,
          days60: account.days60,
          days90: account.days90,
        }
      ),
      "Statement"
    );
  }

  return (
    <div className="acc">
      <div className="acc-head">
        <button className="btn-line" onClick={onBack}>
          ← All accounts
        </button>
        <div className="acc-head-who">
          <h2>{account.name}</h2>
          <span className="acc-sub">
            {[account.code,
              account.phone ? formatPhone(account.phone) || account.phone : null,
              account.is_trade ? "trade price" : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="acc-head-owed">
          <span className="acc-figure-label">
            {balance < 0 ? "In credit" : "Owing"}
          </span>
          <span className={`acc-owed${balance > 0 ? " is-owing" : ""}`}>
            {money(Math.abs(balance))}
          </span>
        </div>
      </div>

      <div className="acc-panels">
        <section className="acc-take">
          <h3>Take a payment</h3>

          <label className="acc-label" htmlFor="acc-amount">Amount</label>
          <input
            id="acc-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="acc-amount-input"
            disabled={busy || !online}
          />
          {balance > 0 && (
            <button
              type="button"
              className="btn-line quiet"
              onClick={() => setAmount(balance.toFixed(2))}
              disabled={busy || !online}
            >
              Settle the lot · {money(balance)}
            </button>
          )}

          <label className="acc-label">How</label>
          <div className="acc-methods">
            {METHODS.map((m) => (
              <button
                key={m.key}
                className={`btn-line${method === m.key ? " is-on" : ""}`}
                onClick={() => setMethod(m.key)}
                disabled={busy || !online}
              >
                {m.label}
              </button>
            ))}
          </div>

          <label className="acc-label" htmlFor="acc-ref">
            Reference {method === "cash" ? "(optional)" : "— cheque or EFT number"}
          </label>
          <input
            id="acc-ref"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={method === "cash" ? "" : "e.g. CHQ 4471"}
            className="modal-input"
            disabled={busy || !online}
          />

          <button
            className="btn-fill acc-take-go"
            onClick={() => void take()}
            disabled={busy || !online || due <= 0}
          >
            {busy ? "Recording…" : `Receive ${due > 0 ? money(due) : "payment"}`}
          </button>

          {due > balance && balance > 0 && due > 0 && (
            <p className="acc-note">
              {money(due - balance)} more than the balance — the difference
              stays on the account as credit.
            </p>
          )}
          {!online && (
            <p className="acc-note">
              Taking a payment needs a connection. The balance shown may be out
              of date, and crediting the wrong figure is worse than waiting.
            </p>
          )}
          {banner && <p className="acc-note is-good">{banner}</p>}
          {error && <p className="acc-note is-bad">{error}</p>}
        </section>

        <section className="acc-ledger">
          <div className="acc-ledger-head">
            <h3>Account history</h3>
            <button
              className="btn-line"
              onClick={printStatement}
              disabled={!entries?.length}
            >
              Print statement
            </button>
          </div>

          <div className="acc-scroll">
            <table className="acc-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Detail</th>
                  <th className="num">Charge</th>
                  <th className="num">Paid</th>
                  <th className="num">Balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries === null && (
                  <tr><td colSpan={6} className="acc-empty">Looking…</td></tr>
                )}
                {entries?.length === 0 && (
                  <tr>
                    <td colSpan={6} className="acc-empty">
                      Nothing on this account yet.
                    </td>
                  </tr>
                )}
                {entries?.map((e) => (
                  <tr key={e.entry_id + e.kind} className={e.voided ? "is-void" : ""}>
                    <td className="quiet">{shortDate(e.entry_at)}</td>
                    <td>
                      <span className="acc-name">{e.ref || e.detail}</span>
                      {e.ref && <span className="acc-sub">{e.detail}</span>}
                      {e.voided && <span className="acc-sub">voided</span>}
                    </td>
                    <td className="num">{e.charge ? money(e.charge) : "—"}</td>
                    <td className="num">{e.payment ? money(e.payment) : "—"}</td>
                    <td className="num">{money(e.balance)}</td>
                    <td className="num">
                      {e.kind === "payment" && !e.voided && can(user, "void_refund") && (
                        <button
                          className="btn-line quiet"
                          onClick={() => setVoiding(e)}
                        >
                          Void
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {voiding && (
        <ManagerPinModal
          title="Void this payment"
          subtitle={`${money(voiding.payment)} on ${shortDate(voiding.entry_at)}. It stays on the ledger, marked void.`}
          onApprove={async (pin) => {
            const next = await voidAccountPayment(
              pin,
              voiding.entry_id,
              "Voided at the counter"
            );
            setBalance(next);
            setVoiding(null);
            await load();
          }}
          onCancel={() => setVoiding(null)}
        />
      )}
    </div>
  );
}

/** "12 Mar 2026" — the form a person reads on a statement. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return fmtDate(d);
}
