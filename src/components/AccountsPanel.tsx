import { useCallback, useEffect, useMemo, useState } from "react";
import {
  accountLedger,
  listAccounts,
  recordAccountPayment,
} from "../lib/api";
import type { AccountLedger, AccountListItem } from "../lib/types";
import { money } from "../lib/format";
import { buildAccountPaymentSlip } from "../lib/receipt";
import { printReceipt } from "../lib/print";
import { useOnline } from "../lib/offline";

// Till-side accounts: any staff who take payments can look up a customer's
// balance, see their ledger, and record a repayment when they settle up.
export default function AccountsPanel({
  cashierId,
  cashierName,
  onClose,
}: {
  cashierId: string;
  cashierName: string;
  onClose: () => void;
}) {
  const online = useOnline();
  const [accounts, setAccounts] = useState<AccountListItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AccountLedger | null>(null);

  const loadList = useCallback(() => {
    setLoading(true);
    listAccounts(cashierId)
      .then((a) => {
        setAccounts(a);
        setError(null);
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Could not load accounts")
      )
      .finally(() => setLoading(false));
  }, [cashierId]);
  useEffect(loadList, [loadList]);

  const openAccount = async (id: string) => {
    try {
      setSelected(await accountLedger(cashierId, id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open account");
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? accounts.filter((a) => a.name.toLowerCase().includes(q)) : accounts;
  }, [accounts, query]);

  return (
    <div className="fixed inset-0 bg-stone-50 z-40 flex flex-col animate-fade-in">
      <header className="h-14 shrink-0 bg-white border-b border-stone-200 flex items-center justify-between px-4">
        <h1 className="text-lg font-bold text-stone-800">
          {selected ? selected.name : "Customer accounts"}
        </h1>
        <button
          onClick={selected ? () => setSelected(null) : onClose}
          className="h-9 px-3 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
        >
          {selected ? "← Accounts" : "← Back to till"}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-2xl mx-auto">
          {!selected && (
            <>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search accounts…"
                className="w-full h-11 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none mb-3"
              />
              {loading && <p className="text-stone-400">Loading…</p>}
              {error && <p className="text-red-600">{error}</p>}
              {!loading && filtered.length === 0 && !error && (
                <p className="text-stone-400">
                  No accounts yet. An admin can add them under Manage → Accounts.
                </p>
              )}
              <div className="space-y-2">
                {filtered.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => openAccount(a.id)}
                    className="w-full flex items-center justify-between bg-white border border-stone-200 rounded-xl px-4 h-14 text-left active:bg-stone-50"
                  >
                    <span>
                      <span className="font-semibold text-stone-800">
                        {a.name}
                      </span>
                      {a.phone && (
                        <span className="text-taupe text-sm"> · {a.phone}</span>
                      )}
                    </span>
                    <span
                      className={`font-semibold ${
                        a.balance > 0 ? "text-stone-900" : "text-stone-400"
                      }`}
                    >
                      {money(a.balance)}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {selected && (
            <AccountDetail
              ledger={selected}
              cashierId={cashierId}
              cashierName={cashierName}
              online={online}
              onPaid={async () => {
                await openAccount(selected.id);
                loadList();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function AccountDetail({
  ledger,
  cashierId,
  cashierName,
  online,
  onPaid,
}: {
  ledger: AccountLedger;
  cashierId: string;
  cashierName: string;
  online: boolean;
  onPaid: () => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amt = Number(amount);
  const valid = amount !== "" && amt > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await recordAccountPayment({
        cashierId,
        accountId: ledger.id,
        amount: amt,
        method,
        note: note.trim() || null,
      });
      printReceipt(
        buildAccountPaymentSlip({
          accountName: ledger.name,
          amount: res.amount,
          method: res.method,
          newBalance: res.balance,
          receivedBy: cashierName,
        }),
        "Account payment"
      );
      setAmount("");
      setNote("");
      await onPaid();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record payment");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Balance */}
      <div className="bg-white border border-stone-200 rounded-xl p-5">
        <div className="flex items-center justify-between">
          <span className="text-stone-600">Balance owing</span>
          <span className="text-2xl font-bold text-stone-900">
            {money(ledger.balance)}
          </span>
        </div>
        {ledger.credit_limit != null && (
          <p className="text-sm text-taupe mt-1">
            Credit limit {money(ledger.credit_limit)}
          </p>
        )}
      </div>

      {/* Record repayment */}
      <div className="bg-white border border-stone-200 rounded-xl p-5">
        <h3 className="font-semibold text-stone-800 mb-3">Record a repayment</h3>
        {!online ? (
          <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
            Repayments need an internet connection so the balance stays accurate.
          </p>
        ) : (
          <>
            <div className="flex gap-2 mb-3">
              <input
                type="number"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Amount"
                className="flex-1 h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
              />
              {(["cash", "card"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  className={`h-12 px-4 rounded-lg font-semibold capitalize ${
                    method === m
                      ? "bg-brand text-white"
                      : "bg-stone-100 text-stone-700"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              className="w-full h-11 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none mb-3"
            />
            {error && <p className="text-red-600 text-sm mb-2">{error}</p>}
            <button
              onClick={submit}
              disabled={!valid || busy}
              className="w-full h-12 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
            >
              {busy ? "…" : "Record payment & print"}
            </button>
          </>
        )}
      </div>

      {/* Ledger */}
      <div>
        <h3 className="font-semibold text-stone-700 mb-2">History</h3>
        <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
          {ledger.entries.length === 0 && (
            <p className="p-4 text-stone-400">No activity yet.</p>
          )}
          {ledger.entries.map((e) => (
            <div
              key={e.ref}
              className="flex items-center justify-between px-4 py-3"
            >
              <div className="min-w-0">
                <p className="font-medium text-stone-800">
                  {e.kind === "charge"
                    ? "Charge"
                    : e.method === "writeoff"
                    ? "Write-off (cleared)"
                    : "Repayment"}
                  {e.method && e.method !== "writeoff" ? ` · ${e.method}` : ""}
                </p>
                <p className="text-xs text-taupe">
                  {new Date(e.at).toLocaleString()}
                  {e.by ? ` · ${e.by}` : ""}
                  {e.note ? ` · ${e.note}` : ""}
                </p>
              </div>
              <span
                className={`font-semibold shrink-0 ml-2 ${
                  e.kind === "charge"
                    ? "text-stone-900"
                    : e.method === "writeoff"
                    ? "text-amber-700"
                    : "text-green-700"
                }`}
              >
                {e.kind === "charge" ? "+" : "−"}
                {money(e.amount)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
