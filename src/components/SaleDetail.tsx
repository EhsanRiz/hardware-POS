import { useEffect, useState } from "react";
import { saleItems, salePayments } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { money } from "../lib/money";
import { printReceipt } from "../lib/print";
import { buildReceiptText } from "../lib/receipt";
import type { SaleRow } from "../lib/sales";
import type { Payment, Sale, SaleItem } from "../lib/types";
import CancelSale from "./CancelSale";
import DocumentSheet from "./DocumentSheet";
import ManagerPinModal from "./ManagerPinModal";
import type { Sheet } from "../lib/sheet";
import ReturnSheet from "./admin/ReturnSheet";
import { fmtDate, fmtDateTime } from "../lib/dates";

/**
 * One sale, opened. The same window whether the counter scanned the slip a
 * customer brought back, or a manager tapped a row on the Sales screen: what
 * was sold, how it was paid, a reprint, and a return.
 *
 * A return needs a manager. Opened from Manage the PIN is already in hand;
 * opened from the till it is asked for here, and the server checks it again.
 */
export interface SaleLike {
  id: string;
  doc_number: string | null;
  created_at: string;
  cashier_name: string;
  customer_name: string | null;
  total: number;
  tax_amount: number;
  status: string;
  payment_method: string | null;
}

const TENDER_LABEL: Record<string, string> = {
  cash: "Cash", card: "Card", eft: "EFT", zapper: "Zapper", account: "On account", split: "Split",
};

export default function SaleDetail({
  sale,
  pin,
  cashierId,
  onClose,
  onChanged,
}: {
  sale: SaleLike;
  /** A manager's PIN if one is already held (Manage); null asks for it. */
  pin: string | null;
  /** Who is at the till, for a cancel approved by a phoned code. */
  cashierId?: string | null;
  onClose: () => void;
  onChanged?: () => Promise<void> | void;
}) {
  const [items, setItems] = useState<SaleItem[] | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askPin, setAskPin] = useState(false);
  // The A4 tax invoice: what a customer's bookkeeper files.
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [returnPin, setReturnPin] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([saleItems(sale.id), salePayments(sale.id)])
      .then(([i, p]) => {
        if (cancelled) return;
        setItems(i);
        setPayments(p);
      })
      .catch((e) => !cancelled && setError(errorMessage(e, "Could not load the sale")));
    return () => {
      cancelled = true;
    };
  }, [sale.id]);

  function reprint() {
    if (!items) return;
    printReceipt(
      buildReceiptText(
        sale as unknown as Sale,
        items.map((i) => ({
          name: i.name, unit_code: i.unit_code, qty: i.qty, unit_price: i.unit_price,
          line_total: i.line_total, discount_amount: i.discount_amount,
          discount_percent: i.discount_percent, discount_reason: i.discount_reason,
        })),
        sale.customer_name ? { name: sale.customer_name, balance: 0 } : null,
        payments
      ),
      `Tax Invoice ${sale.doc_number ?? ""}`.trim()
    );
  }

  const when = fmtDateTime(sale.created_at);

  /**
   * The same sale as an A4 tax invoice.
   *
   * A till slip is an abridged tax invoice and serves a walk-in. Above a few
   * thousand rand SARS wants the customer's own name, address and VAT number
   * on it too, which is exactly the account and trade sales whose paperwork
   * somebody actually files. This is that document.
   */
  function asSheet(): Sheet | null {
    if (!items) return null;
    const full = sale as unknown as SaleRow;
    return {
      kind: "invoice",
      number: sale.doc_number ?? "",
      date: fmtDate(sale.created_at),
      customer: {
        name: sale.customer_name,
        address: full.customer_address ?? null,
        phone: full.customer_phone ?? null,
        vatNumber: full.customer_vat_number ?? null,
      },
      poNumber: full.po_number ?? null,
      lines: items.map((it) => ({
        code: it.sku,
        description: it.name,
        qty: it.qty,
        unit: it.unit_code,
        unitPrice: it.unit_price,
        discount: it.discount_amount ?? 0,
        lineTotal: it.line_total,
      })),
      subtotal: full.subtotal ?? sale.total,
      discount: full.discount_amount ?? 0,
      vat: sale.tax_amount,
      total: sale.total,
      servedBy: sale.cashier_name,
      trade: full.trade_pricing ?? false,
      // An account or EFT sale leaves owing, and the document then has to say
      // where the money goes. Anything settled at the counter does not.
      paidWith:
        sale.payment_method === "account" || sale.payment_method === "eft"
          ? null
          : TENDER_LABEL[sale.payment_method ?? ""] ?? sale.payment_method ?? null,
    };
  }
  const returnable = sale.status === "completed";

  return (
    <div
      className="vv-fixed bg-black/50 flex items-center justify-center p-4 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={`Sale ${sale.doc_number ?? ""}`.trim()}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-stone-200 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold">
              {sale.doc_number ?? "No invoice number"}
              {sale.status === "voided" && <span className="ml-2 text-xs text-amber-700">voided</span>}
              {sale.status === "pending_approval" && (
                <span className="ml-2 text-xs text-amber-700">awaiting approval</span>
              )}
            </h2>
            <p className="text-sm text-stone-500">
              {when} · {sale.cashier_name}
              {sale.customer_name ? ` · ${sale.customer_name}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="text-stone-400 text-2xl leading-none" aria-label="Close sale">
            ×
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-3">
          {error && <p className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg">{error}</p>}
          {!items ? (
            <p className="text-sm text-stone-500">Loading…</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {items.map((i, n) => (
                <li key={n} className="py-2 flex items-baseline gap-3 text-sm even:bg-stone-50/70 px-1">
                  <span className="flex-1 min-w-0">
                    <span className="block">{i.name}</span>
                    <span className="block text-xs text-stone-500">
                      {i.qty} {i.unit_code} × {money(i.unit_price)}
                      {(i.discount_amount ?? 0) > 0 && (
                        <span className="text-amber-700"> · {money(i.discount_amount)} off</span>
                      )}
                    </span>
                  </span>
                  <span className="tabular-nums whitespace-nowrap">{money(i.line_total)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between items-baseline border-t-2 border-stone-800 pt-2">
            <span className="text-sm text-stone-600">
              {payments && payments.length > 1
                ? payments.map((p) => `${TENDER_LABEL[p.method] ?? p.method} ${money(p.amount)}`).join(" · ")
                : TENDER_LABEL[sale.payment_method ?? ""] ?? sale.payment_method ?? ""}
            </span>
            <span className="text-lg tabular-nums">{money(sale.total)}</span>
          </div>
          <p className="text-xs text-stone-500">VAT within {money(sale.tax_amount)}</p>
        </div>

        <div className="p-4 border-t border-stone-200 flex gap-2">
          <button
            className="flex-1 py-2.5 rounded-xl bg-stone-100 text-stone-700 disabled:opacity-40"
            disabled={!items}
            onClick={reprint}
          >
            Reprint
          </button>
          {/* The A4 version, for somebody who has to file it. */}
          <button
            className="flex-1 py-2.5 rounded-xl border border-stone-300 disabled:opacity-40"
            disabled={!items}
            onClick={() => setSheet(asSheet())}
          >
            A4 invoice
          </button>
          {returnable && (
            <button
              className="flex-1 py-2.5 rounded-xl bg-colophon text-paper"
              onClick={() => (pin ? setReturnPin(pin) : setAskPin(true))}
            >
              Return
            </button>
          )}
          {returnable && (
            <button
              className="py-2.5 px-4 rounded-xl border border-red-200 text-red-700"
              onClick={() => setCancelling(true)}
            >
              Cancel this sale
            </button>
          )}
        </div>
      </div>

      {cancelling && (
        <div onClick={(e) => e.stopPropagation()}>
          <CancelSale
            sale={sale}
            cashierId={cashierId ?? null}
            pin={pin}
            onClose={() => setCancelling(false)}
            onDone={async () => {
              setCancelling(false);
              await onChanged?.();
              onClose();
            }}
          />
        </div>
      )}

      {sheet && (
        <div onClick={(e) => e.stopPropagation()}>
          <DocumentSheet sheet={sheet} onClose={() => setSheet(null)} />
        </div>
      )}

      {askPin && (
        <div onClick={(e) => e.stopPropagation()}>
          <ManagerPinModal
            title="Return needs a manager"
            subtitle={`${sale.doc_number ?? "This sale"} — a manager's PIN`}
            onApprove={async (entered) => {
              setReturnPin(entered);
              setAskPin(false);
            }}
            onCancel={() => setAskPin(false)}
          />
        </div>
      )}

      {returnPin && (
        <div onClick={(e) => e.stopPropagation()}>
          <ReturnSheet
            pin={returnPin}
            sale={sale as unknown as SaleRow}
            onClose={() => setReturnPin(null)}
            onDone={async () => {
              setReturnPin(null);
              await onChanged?.();
              onClose();
            }}
          />
        </div>
      )}
    </div>
  );
}
