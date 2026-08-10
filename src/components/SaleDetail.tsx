import { useEffect, useState } from "react";
import type { Sale, SaleItem, User } from "../lib/types";
import { managerSaleItems, voidSale } from "../lib/api";
import { can } from "../lib/permissions";
import { buildReceiptText } from "../lib/receipt";
import { printReceipt, saveReceipt } from "../lib/print";
import { money } from "../lib/format";

interface Props {
  managerPin: string;
  actor: User;
  sale: Sale;
  onClose: () => void;
  onVoided?: () => void;
}

export default function SaleDetail({
  managerPin,
  actor,
  sale,
  onClose,
  onVoided,
}: Props) {
  const [items, setItems] = useState<SaleItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [voided, setVoided] = useState(sale.status === "voided");

  const doVoid = async () => {
    setBusy(true);
    setError(null);
    try {
      await voidSale(managerPin, sale.id, voidReason);
      setVoided(true);
      setVoiding(false);
      onVoided?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Void failed");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    managerSaleItems(managerPin, sale.id)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [managerPin, sale.id]);

  const receiptText =
    items &&
    buildReceiptText(
      sale,
      items.map((i) => ({ name: i.name, price: i.unit_price, qty: i.qty }))
    );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[60] animate-fade-in">
      <div className="bg-white rounded-2xl w-full max-w-sm animate-scale-in max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-stone-200">
          <h2 className="text-lg font-bold text-stone-800">Receipt</h2>
          <p className="text-sm text-taupe">
            {new Date(sale.created_at).toLocaleString()} · {sale.cashier_name}
          </p>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          {error && <p className="text-red-600">{error}</p>}
          {!items && !error && <p className="text-stone-400">Loading…</p>}
          {receiptText && (
            <pre className="font-mono text-xs leading-relaxed bg-stone-50 border border-stone-200 rounded-lg p-3 whitespace-pre-wrap text-stone-800">
              {receiptText}
            </pre>
          )}

          {sale.discount_amount > 0 && (
            <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
              <p className="font-medium text-amber-800">
                Discount {money(sale.discount_amount)}
                {sale.discount_reason ? ` · ${sale.discount_reason}` : ""}
              </p>
              {sale.approved_by_name && (
                <p className="text-amber-700">
                  Approved by {sale.approved_by_name}
                </p>
              )}
            </div>
          )}

          {voided && (
            <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 font-medium">
              This sale has been voided / refunded.
            </div>
          )}

          {error && <p className="mt-3 text-red-600 text-sm">{error}</p>}

          {/* Void / refund */}
          {!voided && can(actor, "void_refund") && (
            <div className="mt-3">
              {!voiding ? (
                <button
                  onClick={() => setVoiding(true)}
                  className="text-red-600 text-sm font-medium underline"
                >
                  Void / refund this sale
                </button>
              ) : (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <input
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    placeholder="Reason (optional)"
                    className="w-full h-10 px-3 rounded-lg border border-red-200 mb-2 outline-none focus:border-red-400"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => setVoiding(false)}
                      disabled={busy}
                      className="flex-1 h-10 rounded-lg bg-white text-stone-600 font-medium border border-stone-200"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={doVoid}
                      disabled={busy}
                      className="flex-1 h-10 rounded-lg bg-red-600 text-white font-semibold active:bg-red-700 disabled:opacity-50"
                    >
                      {busy ? "Voiding…" : "Confirm void"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-stone-200 grid grid-cols-3 gap-2">
          <button
            onClick={onClose}
            className="h-12 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200"
          >
            Close
          </button>
          <button
            onClick={() => receiptText && saveReceipt(receiptText, sale.id)}
            disabled={!receiptText}
            className="h-12 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200 disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={() => receiptText && printReceipt(receiptText, "Tax Invoice")}
            disabled={!receiptText}
            className="h-12 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
          >
            Reprint
          </button>
        </div>
      </div>
    </div>
  );
}
