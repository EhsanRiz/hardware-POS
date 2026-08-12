import { useCallback, useEffect, useMemo, useState } from "react";
import { accountsOverview } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/money";
import { useOnline } from "../../lib/offline";
import { formatPhone } from "../../lib/phone";
import type { AccountRow, User } from "../../lib/types";
import AccountDetail from "./AccountDetail";

/**
 * Accounts — who owes the shop money, and how old that money is.
 *
 * The organising idea is age, not total. A single balance cannot tell a
 * shopkeeper whether R4 000 is last week's delivery or a debt from March, and
 * that difference is the entire decision: chase it, stop supplying, or leave it
 * alone. So the aging columns are the point of the screen and the balance is
 * almost incidental.
 *
 * Payments are allocated to charges oldest first, in the database — see
 * customer_aging() in migration 0024. Doing it in the client would mean the
 * screen and a printed statement could drift apart.
 */
export default function Accounts({ user }: { user: User }) {
  const online = useOnline();
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState<AccountRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await accountsOverview());
    } catch (e) {
      setError(errorMessage(e, "Could not load the accounts"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q || !rows) return rows ?? [];
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.code ?? "").toLowerCase().includes(q) ||
        (r.phone ?? "").replace(/\D/g, "").includes(q.replace(/\D/g, ""))
    );
  }, [rows, term]);

  // The totals a shopkeeper actually wants on opening the screen: not "how many
  // accounts" but "how much is out there, and how much of it is late".
  const totals = useMemo(() => {
    const t = { owed: 0, current: 0, d30: 0, d60: 0, d90: 0 };
    for (const r of rows ?? []) {
      t.owed += r.balance;
      t.current += r.current_due;
      t.d30 += r.days30;
      t.d60 += r.days60;
      t.d90 += r.days90;
    }
    return t;
  }, [rows]);

  const overdue = totals.d30 + totals.d60 + totals.d90;

  if (open) {
    return (
      <AccountDetail
        account={open}
        user={user}
        onBack={() => {
          setOpen(null);
          void load();
        }}
      />
    );
  }

  return (
    <div className="acc">
      <div className="acc-summary">
        <Figure label="Owed to the shop" value={money(totals.owed)} big />
        <Figure label="Not yet due" value={money(totals.current)} />
        <Figure label="30 days" value={money(totals.d30)} warn={totals.d30 > 0} />
        <Figure label="60 days" value={money(totals.d60)} warn={totals.d60 > 0} />
        <Figure label="90+ days" value={money(totals.d90)} bad={totals.d90 > 0} />
      </div>

      {overdue > 0 && (
        <p className="acc-note">
          {money(overdue)} of {money(totals.owed)} is past 30 days.
        </p>
      )}

      <div className="acc-tools">
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Find an account by name, code or phone…"
          className="modal-input"
          style={{ marginBottom: 0, maxWidth: 420 }}
        />
        <button className="btn-line" onClick={() => void load()} disabled={!online}>
          Refresh
        </button>
      </div>

      {!online && (
        <p className="acc-note">
          Balances need a connection — what is shown was fetched when the line
          was last up.
        </p>
      )}
      {error && <p className="acc-note is-bad">{error}</p>}

      <div className="acc-scroll">
        <table className="acc-table">
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Balance</th>
              <th className="num">Not due</th>
              <th className="num">30</th>
              <th className="num">60</th>
              <th className="num">90+</th>
              <th className="num">Limit left</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={7} className="acc-empty">Looking…</td>
              </tr>
            )}
            {rows !== null && shown.length === 0 && (
              <tr>
                <td colSpan={7} className="acc-empty">
                  {term
                    ? `No account matches “${term}”.`
                    : "No accounts yet. A customer gets one when the back office gives them a credit limit."}
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} onClick={() => setOpen(r)} className="acc-row">
                <td>
                  <span className="acc-name">{r.name}</span>
                  <span className="acc-sub">
                    {[r.code, r.phone ? formatPhone(r.phone) || r.phone : null,
                      r.is_trade ? "trade" : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </td>
                <td className={`num ${r.balance > 0 ? "is-owing" : ""}`}>
                  {money(r.balance)}
                </td>
                <td className="num quiet">{money(r.current_due)}</td>
                <td className={`num ${r.days30 > 0 ? "is-late" : "quiet"}`}>
                  {r.days30 ? money(r.days30) : "—"}
                </td>
                <td className={`num ${r.days60 > 0 ? "is-late" : "quiet"}`}>
                  {r.days60 ? money(r.days60) : "—"}
                </td>
                <td className={`num ${r.days90 > 0 ? "is-bad" : "quiet"}`}>
                  {r.days90 ? money(r.days90) : "—"}
                </td>
                <td className="num quiet">
                  {r.available == null ? "no limit" : money(r.available)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  big,
  warn,
  bad,
}: {
  label: string;
  value: string;
  big?: boolean;
  warn?: boolean;
  bad?: boolean;
}) {
  return (
    <div className={`acc-figure${big ? " is-big" : ""}`}>
      <span className="acc-figure-label">{label}</span>
      <span className={`acc-figure-value${warn ? " is-late" : ""}${bad ? " is-bad" : ""}`}>
        {value}
      </span>
    </div>
  );
}
