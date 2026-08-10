import { useMemo, useState } from "react";
import { money } from "../lib/format";
import type { Customer, PaymentMethod } from "../lib/types";

/**
 * Taking the money.
 *
 * No tips — this is a hardware counter, not a cafe. What replaces them is the
 * account path: a contractor's sale goes on the books, and the till has to show
 * their remaining credit *before* the sale is rung up, because an over-limit
 * charge is refused server-side and finding that out after the bakkie is loaded
 * helps nobody.
 */
export default function PaymentModal({
  total,
  customers,
  customer,
  onPickCustomer,
  onCancel,
  onConfirm,
  busy,
}: {
  total: number;
  customers: Customer[];
  customer: Customer | null;
  onPickCustomer: (c: Customer | null) => void;
  onCancel: () => void;
  onConfirm: (p: {
    method: PaymentMethod;
    amountTendered: number | null;
    paidCash: number | null;
    paidCard: number | null;
  }) => void;
  busy: boolean;
}) {
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [tendered, setTendered] = useState("");
  const [cashPart, setCashPart] = useState("");
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");

  const tenderedNum = Number(tendered.replace(",", ".")) || 0;
  const change = Math.max(0, tenderedNum - total);
  const cashNum = Number(cashPart.replace(",", ".")) || 0;
  const cardPart = Math.max(0, total - cashNum);

  const overLimit =
    method === "account" &&
    customer?.available != null &&
    total > customer.available;

  const canConfirm = useMemo(() => {
    if (busy) return false;
    if (method === "cash") return tenderedNum >= total;
    if (method === "account") return !!customer && !overLimit;
    if (method === "split") return cashNum > 0 && cashNum < total;
    return true;
  }, [busy, method, tenderedNum, total, customer, overLimit, cashNum]);

  const shown = customers.filter((c) =>
    c.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  if (picking) {
    return (
      <Backdrop>
        <div className="bg-white rounded-2xl w-full max-w-md p-4 max-h-[80vh] flex flex-col">
          <h2 className="text-lg font-semibold mb-2">Charge to account</h2>
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers…"
            className="w-full rounded-xl border border-stone-300 px-3 py-2 mb-3"
          />
          <ul className="flex-1 overflow-y-auto divide-y divide-stone-100">
            {shown.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => {
                    onPickCustomer(c);
                    setPicking(false);
                  }}
                  className="w-full text-left py-2.5 px-1 hover:bg-stone-50"
                >
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-stone-500">
                    balance {money(c.balance)}
                    {c.available != null
                      ? ` · ${money(c.available)} available`
                      : " · no limit"}
                    {c.is_trade && " · trade"}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <button
            onClick={() => setPicking(false)}
            className="mt-3 py-2 text-stone-600"
          >
            Back
          </button>
        </div>
      </Backdrop>
    );
  }

  return (
    <Backdrop>
      <div className="bg-white rounded-2xl w-full max-w-md p-4">
        <div className="text-center mb-4">
          <div className="text-sm text-stone-500">Amount due</div>
          <div className="text-4xl font-bold tabular-nums">{money(total)}</div>
        </div>

        <div className="grid grid-cols-4 gap-2 mb-4">
          {(["cash", "card", "account", "split"] as PaymentMethod[]).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMethod(m);
                if (m === "account" && !customer) setPicking(true);
              }}
              className={`py-2.5 rounded-xl text-sm capitalize ${
                method === m
                  ? "bg-stone-800 text-white"
                  : "bg-stone-100 text-stone-700"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {method === "cash" && (
          <div className="space-y-3">
            <input
              autoFocus
              inputMode="decimal"
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
              placeholder="Cash received"
              className="w-full rounded-xl border border-stone-300 px-4 py-3 text-2xl
                         text-center tabular-nums"
            />
            <div className="flex gap-2">
              {[total, 100, 200, 500].map((v, i) => (
                <button
                  key={i}
                  onClick={() => setTendered(String(v))}
                  className="flex-1 py-2 rounded-lg bg-stone-100 text-sm tabular-nums"
                >
                  {i === 0 ? "Exact" : money(v)}
                </button>
              ))}
            </div>
            {tenderedNum > 0 && (
              <div className="text-center text-lg">
                Change{" "}
                <span className="font-bold tabular-nums">{money(change)}</span>
              </div>
            )}
          </div>
        )}

        {method === "account" && (
          <div className="space-y-2">
            <button
              onClick={() => setPicking(true)}
              className="w-full rounded-xl border border-stone-300 px-4 py-3 text-left"
            >
              {customer ? (
                <>
                  <div className="font-medium">{customer.name}</div>
                  <div className="text-xs text-stone-500">
                    balance {money(customer.balance)}
                    {customer.available != null &&
                      ` · ${money(customer.available)} available`}
                  </div>
                </>
              ) : (
                <span className="text-stone-500">Choose a customer…</span>
              )}
            </button>
            {overLimit && (
              <p className="text-sm text-red-600">
                Over the credit limit — {money(customer!.available!)} available.
                Take payment another way, or raise the limit in Customers.
              </p>
            )}
          </div>
        )}

        {method === "split" && (
          <div className="space-y-2">
            <input
              autoFocus
              inputMode="decimal"
              value={cashPart}
              onChange={(e) => setCashPart(e.target.value)}
              placeholder="Cash portion"
              className="w-full rounded-xl border border-stone-300 px-4 py-3
                         text-xl text-center tabular-nums"
            />
            <div className="text-center text-sm text-stone-600">
              Card takes the rest:{" "}
              <span className="font-semibold tabular-nums">{money(cardPart)}</span>
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-5">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 py-3 rounded-xl bg-stone-100 text-stone-700"
          >
            Cancel
          </button>
          <button
            disabled={!canConfirm}
            onClick={() =>
              onConfirm({
                method,
                amountTendered: method === "cash" ? tenderedNum : null,
                paidCash: method === "split" ? cashNum : null,
                paidCard: method === "split" ? cardPart : null,
              })
            }
            className="flex-[2] py-3 rounded-xl bg-emerald-600 text-white
                       font-semibold disabled:opacity-40"
          >
            {busy ? "Working…" : "Complete sale"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function Backdrop({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      {children}
    </div>
  );
}
