import { useCallback, useEffect, useState } from "react";
import {
  managerClearAccount,
  managerListAccounts,
  managerUpsertAccount,
} from "../lib/api";
import type { Account } from "../lib/types";
import { money } from "../lib/format";
import { CURRENCY } from "../lib/config";

// Admin: create and manage customer house accounts.
export default function AccountManager({ managerPin }: { managerPin: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Account | "new" | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    managerListAccounts(managerPin)
      .then((a) => {
        setAccounts(a);
        setError(null);
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Could not load accounts")
      )
      .finally(() => setLoading(false));
  }, [managerPin]);
  useEffect(load, [load]);

  return (
    <div className="p-4">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-taupe text-sm">
            Customers who pay later. Charges add to their balance; repayments are
            taken at the till.
          </p>
          <button
            onClick={() => setEditing("new")}
            className="h-10 px-4 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark shrink-0"
          >
            + New account
          </button>
        </div>

        {loading && <p className="text-stone-400">Loading…</p>}
        {error && <p className="text-red-600">{error}</p>}

        <div className="space-y-2">
          {accounts.map((a) => (
            <button
              key={a.id}
              onClick={() => setEditing(a)}
              className={`w-full flex items-center justify-between bg-white border rounded-xl px-4 h-16 text-left active:bg-stone-50 ${
                a.active ? "border-stone-200" : "border-stone-200 opacity-60"
              }`}
            >
              <span className="min-w-0">
                <span className="font-semibold text-stone-800">{a.name}</span>
                {!a.active && (
                  <span className="ml-2 text-xs bg-stone-200 text-stone-600 px-1.5 py-0.5 rounded">
                    inactive
                  </span>
                )}
                <span className="block text-sm text-taupe truncate">
                  {a.phone || a.email || "—"}
                  {a.credit_limit != null
                    ? ` · limit ${money(a.credit_limit)}`
                    : ""}
                </span>
              </span>
              <span className="font-semibold text-stone-900 shrink-0 ml-2">
                {money(a.balance)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {editing && (
        <AccountForm
          managerPin={managerPin}
          initial={editing === "new" ? null : editing}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function AccountForm({
  managerPin,
  initial,
  onSaved,
  onCancel,
}: {
  managerPin: string;
  initial: Account | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [limit, setLimit] = useState(
    initial?.credit_limit != null ? String(initial.credit_limit) : ""
  );
  const [opening, setOpening] = useState(
    initial && initial.opening_balance ? String(initial.opening_balance) : ""
  );
  const [active, setActive] = useState(initial?.active ?? true);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Write-off ("clear balance") state.
  const [balance, setBalance] = useState(initial?.balance ?? 0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const valid = name.trim() !== "";

  const clearBalance = async () => {
    if (!initial) return;
    setClearing(true);
    setError(null);
    try {
      const res = await managerClearAccount(managerPin, initial.id);
      setBalance(res.balance);
      setConfirmClear(false);
      onSaved(); // refresh the list balances behind the modal
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not clear balance");
    } finally {
      setClearing(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await managerUpsertAccount(managerPin, {
        id: initial?.id ?? null,
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        credit_limit: limit.trim() === "" ? null : Math.max(0, Number(limit)),
        opening_balance: opening.trim() === "" ? 0 : Number(opening),
        active,
        notes: notes.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md animate-scale-in max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-stone-800 mb-4">
          {initial ? "Edit account" : "New account"}
        </h2>

        {initial && (
          <div className="mb-4 rounded-xl border border-stone-200 bg-stone-50 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-stone-600">Balance owing</span>
              <span className="text-xl font-bold text-stone-900">
                {money(balance)}
              </span>
            </div>
            {balance > 0 ? (
              confirmClear ? (
                <div className="mt-3">
                  <p className="text-sm text-stone-700 mb-2">
                    Write off {money(balance)} and set the balance to zero? This
                    is recorded in the ledger but takes no payment.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmClear(false)}
                      disabled={clearing}
                      className="flex-1 h-10 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={clearBalance}
                      disabled={clearing}
                      className="flex-1 h-10 rounded-lg bg-red-600 text-white font-semibold active:bg-red-700 disabled:opacity-50"
                    >
                      {clearing ? "Clearing…" : "Yes, clear it"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmClear(true)}
                  className="mt-3 w-full h-10 rounded-lg bg-white border border-red-300 text-red-700 font-medium active:bg-red-50"
                >
                  Clear balance (write-off)
                </button>
              )
            ) : (
              <p className="mt-1 text-sm text-taupe">Nothing owing.</p>
            )}
          </div>
        )}

        <label className="block text-sm font-medium text-stone-600 mb-1">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-4 focus:border-brand outline-none"
          placeholder="e.g. John Smith / Acme Ltd"
        />

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">
              Phone
            </label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">
              Email
            </label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">
              Credit limit ({CURRENCY})
            </label>
            <input
              type="number"
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="blank = none"
              className="w-full h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">
              Opening balance ({CURRENCY})
            </label>
            <input
              type="number"
              inputMode="decimal"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              placeholder="0.00"
              disabled={!!initial}
              className="w-full h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none disabled:bg-stone-100 disabled:text-stone-400"
            />
          </div>
        </div>
        {initial && (
          <p className="-mt-2 mb-4 text-xs text-taupe">
            Opening balance can only be set when creating an account.
          </p>
        )}

        <label className="block text-sm font-medium text-stone-600 mb-1">
          Notes
        </label>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-4 focus:border-brand outline-none"
        />

        <label className="flex items-center gap-2 mb-4 select-none">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="w-5 h-5 accent-brand"
          />
          <span className="text-stone-700">
            Active (can be charged at the till)
          </span>
        </label>

        {error && <p className="text-red-600 text-sm mb-3">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 h-12 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!valid || busy}
            className="flex-1 h-12 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
