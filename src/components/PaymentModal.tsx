import { useMemo, useState } from "react";
import type { AccountListItem, PaymentMethod } from "../lib/types";
import { money } from "../lib/format";
import { CURRENCY, TIP_PERCENTS } from "../lib/config";

interface Props {
  baseTotal: number; // subtotal - discount, before tip
  needsApproval: boolean; // discount applied but cashier can't approve
  accounts: AccountListItem[];
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (p: {
    tipAmount: number;
    method: PaymentMethod;
    tendered: number | null;
    approverPin: string | null;
    accountId: string | null;
    paidCash: number | null;
    paidCard: number | null;
  }) => void;
}

export default function PaymentModal({
  baseTotal,
  needsApproval,
  accounts,
  busy,
  error,
  onCancel,
  onConfirm,
}: Props) {
  const [tip, setTip] = useState("");
  const [activePct, setActivePct] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [tendered, setTendered] = useState("");
  const [approverPin, setApproverPin] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [accountQuery, setAccountQuery] = useState("");
  const [splitCash, setSplitCash] = useState("");

  const tipAmount = Math.max(0, Number(tip) || 0);
  const grandTotal = baseTotal + tipAmount;
  const tenderedNum = tendered === "" ? null : Number(tendered);
  const change =
    method === "cash" && tenderedNum != null ? tenderedNum - grandTotal : null;

  // Split: the cash portion is entered, the card portion is the remainder.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const splitCashNum = round2(
    Math.min(Math.max(splitCash === "" ? 0 : Number(splitCash), 0), grandTotal)
  );
  const splitCardNum = round2(grandTotal - splitCashNum);
  const splitInvalid =
    method === "split" &&
    (splitCash === "" ||
      Number.isNaN(Number(splitCash)) ||
      Number(splitCash) < 0 ||
      Number(splitCash) > grandTotal);

  const selectedAccount = accounts.find((a) => a.id === accountId) ?? null;
  const filteredAccounts = useMemo(() => {
    const q = accountQuery.trim().toLowerCase();
    return q
      ? accounts.filter((a) => a.name.toLowerCase().includes(q))
      : accounts;
  }, [accounts, accountQuery]);
  // Hard credit-limit check: a charge that would push the balance past the
  // account's limit is blocked (the Charge button is disabled below).
  const overLimit =
    selectedAccount?.credit_limit != null &&
    selectedAccount.balance + grandTotal > selectedAccount.credit_limit;

  const setPct = (pct: number) => {
    setActivePct(pct);
    setTip(((baseTotal * pct) / 100).toFixed(2));
  };

  const blocked =
    busy ||
    grandTotal <= 0 ||
    (needsApproval && approverPin.trim().length < 4) ||
    (method === "cash" && tenderedNum != null && tenderedNum < grandTotal) ||
    (method === "account" && !accountId) ||
    (method === "account" && overLimit) ||
    (method === "split" && splitInvalid);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md animate-scale-in max-h-[92vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-stone-800 mb-1">Payment</h2>
        <p className="text-taupe mb-4">Total before tip {money(baseTotal)}</p>

        {/* Tip */}
        <label className="block text-sm font-medium text-stone-600 mb-1">Tip</label>
        <div className="flex gap-2 mb-2">
          {TIP_PERCENTS.map((pct) => (
            <button
              key={pct}
              onClick={() => setPct(pct)}
              className={`flex-1 h-11 rounded-lg font-medium ${
                activePct === pct
                  ? "bg-brand text-white"
                  : "bg-stone-100 text-stone-700"
              }`}
            >
              {pct}%
            </button>
          ))}
          <button
            onClick={() => {
              setActivePct(0);
              setTip("");
            }}
            className={`flex-1 h-11 rounded-lg font-medium ${
              activePct === 0 ? "bg-brand text-white" : "bg-stone-100 text-stone-700"
            }`}
          >
            None
          </button>
        </div>
        <div className="relative mb-4">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400">
            {CURRENCY}
          </span>
          <input
            type="number"
            inputMode="decimal"
            value={tip}
            onChange={(e) => {
              setTip(e.target.value);
              setActivePct(null);
            }}
            placeholder="0.00"
            className="w-full h-12 pl-8 pr-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
          />
        </div>

        {/* Grand total */}
        <div className="flex justify-between text-2xl font-bold text-stone-900 mb-4">
          <span>To pay</span>
          <span>{money(grandTotal)}</span>
        </div>

        {/* Method */}
        <div className="grid grid-cols-2 gap-2 mb-2">
          {(["cash", "card"] as PaymentMethod[]).map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`h-14 rounded-xl font-semibold capitalize text-lg ${
                method === m
                  ? "bg-brand text-white"
                  : "bg-stone-100 text-stone-700"
              }`}
            >
              {m === "cash" ? "💵 Cash" : "💳 Card"}
            </button>
          ))}
        </div>
        <button
          onClick={() => setMethod("split")}
          className={`w-full h-12 rounded-xl font-semibold mb-2 ${
            method === "split"
              ? "bg-brand text-white"
              : "bg-stone-100 text-stone-700"
          }`}
        >
          ½ Split cash + card
        </button>
        {accounts.length > 0 && (
          <button
            onClick={() => setMethod("account")}
            className={`w-full h-12 rounded-xl font-semibold mb-4 ${
              method === "account"
                ? "bg-brand text-white"
                : "bg-stone-100 text-stone-700"
            }`}
          >
            🧾 Charge to account
          </button>
        )}

        {/* Split amounts */}
        {method === "split" && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-stone-600 mb-1">
              Cash portion
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400">
                {CURRENCY}
              </span>
              <input
                type="number"
                inputMode="decimal"
                value={splitCash}
                onChange={(e) => setSplitCash(e.target.value)}
                placeholder="0.00"
                autoFocus
                className="w-full h-12 pl-8 pr-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-stone-600">
                💵 Cash <b>{money(splitCashNum)}</b>
              </span>
              <span className="text-stone-600">
                💳 Card <b>{money(splitCardNum)}</b>
              </span>
            </div>
            {splitInvalid ? (
              <p className="mt-1 text-xs text-red-600">
                Enter a cash amount between {money(0)} and {money(grandTotal)}.
              </p>
            ) : (
              <p className="mt-1 text-xs text-taupe">
                Card takes the rest. Together they make {money(grandTotal)}.
              </p>
            )}
          </div>
        )}

        {/* Account picker */}
        {method === "account" && (
          <div className="mb-4">
            <input
              value={accountQuery}
              onChange={(e) => setAccountQuery(e.target.value)}
              placeholder="Search accounts…"
              className="w-full h-11 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none mb-2 text-sm"
            />
            <div className="max-h-44 overflow-y-auto rounded-lg border border-stone-200 divide-y divide-stone-100">
              {filteredAccounts.length === 0 && (
                <p className="p-3 text-sm text-stone-400">No accounts found.</p>
              )}
              {filteredAccounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setAccountId(a.id)}
                  className={`w-full flex items-center justify-between px-3 h-12 text-left ${
                    accountId === a.id ? "bg-brand-light" : "active:bg-stone-50"
                  }`}
                >
                  <span className="font-medium text-stone-800 truncate">
                    {a.name}
                  </span>
                  <span className="text-sm text-taupe shrink-0 ml-2">
                    bal {money(a.balance)}
                  </span>
                </button>
              ))}
            </div>
            {selectedAccount && (
              <p className="mt-2 text-sm text-stone-600">
                New balance after this charge:{" "}
                <b>{money(selectedAccount.balance + grandTotal)}</b>
              </p>
            )}
            {overLimit && (
              <p className="mt-1 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">
                🚫 This exceeds {selectedAccount?.name}'s credit limit of{" "}
                {money(selectedAccount!.credit_limit as number)}. The charge is
                blocked — take a different payment or reduce the order.
              </p>
            )}
          </div>
        )}

        {/* Cash tendered + change */}
        {method === "cash" && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-stone-600 mb-1">
              Cash received <span className="text-taupe-light">(optional)</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400">
                {CURRENCY}
              </span>
              <input
                type="number"
                inputMode="decimal"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                placeholder={grandTotal.toFixed(2)}
                className="w-full h-12 pl-8 pr-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
              />
            </div>
            {change != null && change >= 0 && (
              <p className="mt-2 text-brand-dark font-semibold">
                Change due {money(change)}
              </p>
            )}
            {change != null && change < 0 && (
              <p className="mt-2 text-red-600">
                Short by {money(-change)}
              </p>
            )}
          </div>
        )}

        {/* Inline discount approval */}
        {needsApproval && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
            <label className="block text-sm font-medium text-amber-800 mb-1">
              Manager PIN to approve discount
            </label>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={approverPin}
              onChange={(e) => setApproverPin(e.target.value.replace(/\D/g, ""))}
              maxLength={6}
              className="w-full h-12 px-3 rounded-lg border border-amber-300 tracking-widest outline-none focus:border-amber-500"
              placeholder="••••"
            />
          </div>
        )}

        {error && <p className="text-red-600 text-sm mb-3 animate-fade-in">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 h-14 rounded-xl bg-stone-100 text-stone-600 font-medium active:bg-stone-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              onConfirm({
                tipAmount,
                method,
                tendered: method === "cash" ? tenderedNum : null,
                approverPin: needsApproval ? approverPin.trim() : null,
                accountId: method === "account" ? accountId : null,
                paidCash: method === "split" ? splitCashNum : null,
                paidCard: method === "split" ? splitCardNum : null,
              })
            }
            disabled={blocked}
            className="flex-[2] h-14 rounded-xl bg-gradient-to-b from-brand to-brand-dark text-white font-semibold shadow-md disabled:opacity-40"
          >
            {busy
              ? "…"
              : method === "account"
              ? `Charge ${money(grandTotal)} to account`
              : `Charge ${money(grandTotal)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
