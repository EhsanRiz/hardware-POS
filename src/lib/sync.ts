// Offline-aware sale submission + background sync.
//
// submitSale() takes a sale online when possible, and otherwise records it on
// the device (queue.ts) so the invoice can still print and the sale syncs
// later. syncNow() replays the queue to the idempotent server RPC; the
// client-generated UUID guarantees no duplicates even if a request committed
// server-side but its response was lost on the way back.
import { useEffect, useState } from "react";
import { createSale } from "./api";
import { errorMessage } from "./errors";
import { findByPinOffline } from "./auth";
import { isNetworkError, isOnline, onNetworkChange } from "./offline";
import { can } from "./permissions";
import {
  bumpAttempt,
  enqueue,
  failedCount,
  listQueue,
  moveToFailed,
  onQueueChange,
  queueCount,
  removeFromQueue,
} from "./queue";
import type { CartLine, Payment, PaymentMethod, Sale } from "./types";

export interface SaleInput {
  cashierId: string;
  cashierName: string;
  lines: CartLine[];
  subtotal: number;
  discountAmount: number;
  discountReason: string | null;
  total: number;
  paymentMethod: PaymentMethod;
  amountTendered: number | null;
  /** Manager PIN entered to approve a discount, if one was applied. */
  approverPin: string | null;
  /**
   * A manager's single-use code, read over the phone when they are not in the
   * building. Unlike the PIN this cannot be checked on the device — it lives on
   * the server — so it travels with the sale and is spent there, atomically.
   */
  approvalCode?: string | null;
  customerId: string | null;
  customerName: string | null;
  tradePricing: boolean;
  paidCash: number | null;
  paidCard: number | null;
  /** Every tender taken at the counter. */
  payments?: Payment[] | null;
  poNumber?: string | null;
  customerVatNumber?: string | null;
  /** Cash rounding applied at settlement; the invoice total stays exact. */
  rounding?: number | null;
  note: string | null;
}

export interface SaleResult {
  sale: Sale;
  queued: boolean;
}

function itemsPayload(lines: CartLine[]) {
  // The discount travels with the line. A sale queued offline that dropped it
  // would replay at full price hours later, with nobody watching.
  return lines.map((l) => ({
    product_id: l.product.id,
    qty: l.qty,
    // An open line — delivery, quoted per job — carries the price the counter
    // named. The server honours it only for a product the shop has marked as
    // open, so this cannot reprice a bag of cement.
    ...(l.product.kind && l.product.kind !== "goods"
      ? { unit_price: l.product.price_retail }
      : {}),
    ...(l.discount ? { discount_amount: l.discount } : {}),
    ...(l.discountPercent ? { discount_percent: l.discountPercent } : {}),
    ...(l.discountReason ? { discount_reason: l.discountReason } : {}),
  }));
}

/**
 * Whether this sale has any discount on it at all.
 *
 * `discountAmount` is the discount taken off the SALE. Money taken off a single
 * line rides on the line, and for a long time this was the only figure the
 * approver was resolved against — so a per-line discount approved at the
 * counter had the manager's PIN dropped on the way out, and the server, which
 * counts both kinds, parked a sale a manager had just stood there and released.
 * The manager saw the prompt, typed their PIN, and the invoice never issued.
 */
function anyDiscount(p: SaleInput): boolean {
  return (
    p.discountAmount > 0 ||
    (p.lines ?? []).some((l) => (l.discount ?? 0) > 0)
  );
}

/**
 * Resolve a discount approver.
 *
 * Online we still want the manager's *identity*, not just their PIN, because
 * pos_create_sale takes an approver id and rechecks the permission itself.
 * Offline the same check runs against the device credential cache. Either way
 * the PIN is never stored or queued.
 */
async function resolveApprover(
  pin: string | null
): Promise<{ id: string; name: string } | null> {
  if (!pin) return null;
  const approver = await findByPinOffline(pin);
  if (!approver) {
    throw new Error("Manager PIN not recognised on this device");
  }
  if (!can(approver, "approve_discount")) {
    throw new Error("That PIN can't approve discounts");
  }
  return { id: approver.id, name: approver.name };
}

/** Take a sale online, or queue it on the device if the network is down. */
export async function submitSale(p: SaleInput): Promise<SaleResult> {
  const clientUuid = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  // Change is measured against the CASH actually applied, not the invoice
  // total: with a mixed tender the customer's notes only cover the cash part.
  const cashApplied = (p.payments ?? [])
    .filter((x) => x.method === "cash")
    .reduce((sum, x) => sum + x.amount, 0);
  const changeDue =
    p.amountTendered != null
      ? Math.max(0, p.amountTendered - (cashApplied || p.total))
      : null;

  // A code is the server's business; a PIN is resolved here so the till can
  // approve during an outage. Only one of the two is ever in play.
  const approver =
    anyDiscount(p) && !p.approvalCode
      ? await resolveApprover(p.approverPin)
      : null;

  if (isOnline()) {
    try {
      const sale = await createSale({
        cashierId: p.cashierId,
        items: itemsPayload(p.lines),
        customerId: p.customerId,
        paymentMethod: p.paymentMethod,
        discountAmount: p.discountAmount,
        discountReason: p.discountReason,
        approvedBy: approver?.id ?? null,
        approvalCode: p.approvalCode ?? null,
        amountTendered: p.amountTendered,
        paidCash: p.paidCash,
        paidCard: p.paidCard,
        payments: p.payments ?? null,
        poNumber: p.poNumber ?? null,
        customerVatNumber: p.customerVatNumber ?? null,
        clientRef: clientUuid,
        createdAt: null, // online: let the server stamp it
        note: p.note,
      });
      return { sale, queued: false };
    } catch (e) {
      // A real server rejection (over credit limit, out of stock, not paired)
      // must surface to the cashier. Only a connectivity failure falls through
      // to the offline queue.
      if (!isNetworkError(e)) throw e;
    }
  }

  enqueue({
    clientUuid,
    cashierId: p.cashierId,
    cashierName: p.cashierName,
    lines: p.lines,
    discountAmount: p.discountAmount,
    discountReason: p.discountReason,
    paymentMethod: p.paymentMethod,
    amountTendered: p.amountTendered,
    changeDue,
    subtotal: p.subtotal,
    total: p.total,
    approvedBy: approver?.id ?? null,
    approvedByName: approver?.name ?? null,
    approvalCode: p.approvalCode ?? null,
    customerId: p.customerId,
    customerName: p.customerName,
    tradePricing: p.tradePricing,
    paidCash: p.paidCash,
    paidCard: p.paidCard,
    payments: p.payments ?? null,
    poNumber: p.poNumber ?? null,
    customerVatNumber: p.customerVatNumber ?? null,
    createdAt,
  });

  // Build the sale locally so the invoice prints immediately — RawBT is on the
  // tablet, so printing never depended on the network. There is no document
  // number yet: the server allocates that at sync, and the slip says so.
  const sale: Sale = {
    id: clientUuid,
    doc_number: null,
    cashier_id: p.cashierId,
    cashier_name: p.cashierName,
    customer_id: p.customerId,
    customer_name: p.customerName,
    trade_pricing: p.tradePricing,
    subtotal: p.subtotal,
    discount_amount: p.discountAmount,
    discount_reason: p.discountReason,
    // Prices are VAT-inclusive, so the tax is the portion within the total.
    // The server recomputes this per line on sync; this is for the slip only.
    tax_amount: 0,
    total: p.total,
    status: "completed",
    approved_by: approver?.id ?? null,
    approved_by_name: approver?.name ?? null,
    payment_method: p.paymentMethod,
    amount_tendered: p.amountTendered,
    change_due: changeDue,
    paid_cash: p.paidCash,
    paid_card: p.paidCard,
    rounding: p.rounding ?? 0,
    po_number: p.poNumber ?? null,
    customer_vat_number: p.customerVatNumber ?? null,
    note: p.note,
    created_at: createdAt,
  };

  // If we *thought* we were online but the request failed, kick a sync.
  if (isOnline()) void syncNow();
  return { sale, queued: true };
}

let syncing = false;

/** Replay queued sales to the server (idempotent). Safe to call anytime. */
export async function syncNow(): Promise<void> {
  if (syncing || !isOnline()) return;
  syncing = true;
  try {
    for (const item of listQueue()) {
      try {
        await createSale({
          cashierId: item.cashierId,
          items: itemsPayload(item.lines),
          customerId: item.customerId,
          paymentMethod: item.paymentMethod,
          discountAmount: item.discountAmount,
          discountReason: item.discountReason,
          approvedBy: item.approvedBy,
          approvalCode: item.approvalCode ?? null,
          amountTendered: item.amountTendered,
          paidCash: item.paidCash,
          paidCard: item.paidCard,
          payments: item.payments ?? null,
          poNumber: item.poNumber ?? null,
          customerVatNumber: item.customerVatNumber ?? null,
          clientRef: item.clientUuid,
          // Offline sales keep the time they were actually taken.
          createdAt: item.createdAt,
          note: null,
        });
        removeFromQueue(item.clientUuid);
      } catch (e) {
        if (isNetworkError(e)) {
          // Connection dropped again — keep the item and retry later rather
          // than discarding a real sale.
          bumpAttempt(item.clientUuid);
          break;
        }
        // Permanent rejection (e.g. the product was deleted, or stock has since
        // gone negative): park it so it stops blocking the rest of the queue.
        moveToFailed(item, errorMessage(e, "Sync rejected"));
      }
    }
  } finally {
    syncing = false;
  }
}

// Background triggers: sync when the connection returns, periodically while
// anything is queued, and once shortly after load.
if (typeof window !== "undefined") {
  onNetworkChange((online) => {
    if (online) void syncNow();
  });
  setInterval(() => {
    if (queueCount() > 0) void syncNow();
  }, 30_000);
  setTimeout(() => void syncNow(), 1_500);
}

/** React hook: pending (to sync) and failed counts for the UI. */
export function usePendingSync(): { pending: number; failed: number } {
  const read = () => ({ pending: queueCount(), failed: failedCount() });
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    return onQueueChange(update);
  }, []);
  return state;
}
