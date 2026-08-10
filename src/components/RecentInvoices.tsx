import { useEffect, useState } from "react";
import { recentSales, type RecentSale } from "../lib/api";
import { money } from "../lib/format";
import { buildReceiptText } from "../lib/receipt";
import { printReceipt } from "../lib/print";

interface Props {
  cashierId: string;
  onClose: () => void;
}

const METHOD_LABEL: Record<string, string> = {
  cash: "💵 Cash",
  card: "💳 Card",
  account: "🧾 Account",
  split: "½ Split",
};

// Till-side quick reprint: the last few completed invoices, with a Print button
// on each. Available to any staff member who can take payments.
export default function RecentInvoices({ cashierId, onClose }: Props) {
  const [sales, setSales] = useState<RecentSale[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printedId, setPrintedId] = useState<string | null>(null);

  useEffect(() => {
    recentSales(cashierId, 5)
      .then(setSales)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Could not load invoices")
      );
  }, [cashierId]);

  const reprint = (s: RecentSale) => {
    const account =
      s.account_id && s.account_name != null
        ? { name: s.account_name, balance: s.account_balance ?? 0 }
        : null;
    printReceipt(buildReceiptText(s, s.items, account), "Tax Invoice");
    setPrintedId(s.id);
    setTimeout(() => setPrintedId((id) => (id === s.id ? null : id)), 2500);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-2xl w-full max-w-md animate-scale-in max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-stone-200">
          <h2 className="text-xl font-bold text-stone-800">Recent invoices</h2>
          <button onClick={onClose} className="text-stone-400 text-2xl leading-none">
            ×
          </button>
        </div>

        <div className="p-4 overflow-y-auto">
          {error && <p className="text-red-600">{error}</p>}
          {!sales && !error && <p className="text-stone-400">Loading…</p>}
          {sales && sales.length === 0 && (
            <p className="text-stone-400 text-center py-8">No invoices yet.</p>
          )}

          <div className="space-y-2">
            {sales?.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 p-3 rounded-xl border border-stone-200 animate-fade-in"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-stone-800">
                    #{s.id.slice(0, 8)}
                    <span className="ml-2 text-xs font-normal text-taupe">
                      {METHOD_LABEL[s.payment_method ?? ""] ?? s.payment_method}
                    </span>
                  </p>
                  <p className="text-xs text-taupe">
                    {new Date(s.created_at).toLocaleString([], {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {" · "}
                    {s.cashier_name}
                    {s.account_name ? ` · ${s.account_name}` : ""}
                  </p>
                </div>
                <span className="font-semibold text-stone-800 shrink-0">
                  {money(s.total)}
                </span>
                <button
                  onClick={() => reprint(s)}
                  className="h-9 px-3 rounded-lg bg-brand text-white text-sm font-semibold active:bg-brand-dark shrink-0"
                >
                  {printedId === s.id ? "Printed ✓" : "🖨 Print"}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
