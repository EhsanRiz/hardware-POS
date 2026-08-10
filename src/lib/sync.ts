// Offline-aware payment submission + background sync.
//
// submitPayment() takes a payment online when possible, and otherwise records
// it on the device (queue.ts) so the receipt can still print and the sale syncs
// later. syncNow() replays the queue to the idempotent server RPC; the
// client-generated UUID guarantees no duplicates even if a request committed
// server-side but its response was lost.
import { useEffect, useState } from "react";
import { payOrder, payOrderV2, saveOrder } from "./api";
import {
  listLocalOrders,
  localOrdersCount,
  onLocalOrdersChange,
  removeLocalOrder,
} from "./localOrders";
import { verifyPinOffline } from "./auth";
import { can } from "./permissions";
import {
  isMissingRpcError,
  isNetworkError,
  isOnline,
  onNetworkChange,
} from "./offline";
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
import type { PaymentMethod, Sale } from "./types";

export interface PaymentInput {
  cashierId: string;
  cashierName: string;
  orderId: string | null;
  lines: import("./types").CartLine[];
  subtotal: number;
  discountAmount: number;
  discountReason: string | null;
  tipAmount: number;
  total: number;
  paymentMethod: PaymentMethod;
  amountTendered: number | null;
  label: string | null;
  approverPin: string | null;
  accountId: string | null;
  accountName: string | null;
  paidCash: number | null;
  paidCard: number | null;
}

export interface PaymentResult {
  sale: Sale;
  queued: boolean;
}

/** Take a payment online, or queue it on the device if the network is down. */
export async function submitPayment(p: PaymentInput): Promise<PaymentResult> {
  const clientUuid = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const changeDue =
    p.paymentMethod === "cash" && p.amountTendered != null
      ? Math.max(0, p.amountTendered - p.total)
      : null;

  if (isOnline()) {
    try {
      const sale = await payOrderV2({
        clientUuid,
        cashierId: p.cashierId,
        orderId: p.orderId,
        lines: p.lines,
        discountAmount: p.discountAmount,
        discountReason: p.discountReason,
        tipAmount: p.tipAmount,
        paymentMethod: p.paymentMethod,
        amountTendered: p.amountTendered,
        approverPin: p.approverPin,
        createdAt,
        offline: false,
        accountId: p.accountId,
        paidCash: p.paidCash,
        paidCard: p.paidCard,
      });
      return { sale, queued: false };
    } catch (e) {
      // Frontend deployed before the migration: fall back to the legacy pay so
      // the till keeps working (no offline idempotency, but online is fine).
      // Account charges and split payments need the new RPC — no legacy path.
      if (isMissingRpcError(e) && !p.accountId && p.paymentMethod !== "split") {
        const sale = await payOrder({
          cashierId: p.cashierId,
          orderId: p.orderId,
          lines: p.lines,
          discountAmount: p.discountAmount,
          discountReason: p.discountReason,
          tipAmount: p.tipAmount,
          paymentMethod: p.paymentMethod,
          amountTendered: p.amountTendered,
          approverPin: p.approverPin,
        });
        return { sale, queued: false };
      }
      // A real server rejection (bad PIN, etc.) must surface to the cashier;
      // only a connectivity failure falls through to the offline queue.
      if (!isNetworkError(e)) throw e;
    }
  }

  // --- Offline path: verify any discount approver against the device cache ---
  let approvedBy: string | null = null;
  let approvedByName: string | null = null;
  if (p.discountAmount > 0 && p.approverPin) {
    const approver = await verifyPinOffline(p.approverPin);
    if (!approver) {
      throw new Error("Manager PIN not recognised on this device (offline)");
    }
    if (!can(approver, "approve_discount")) {
      throw new Error("That PIN can't approve discounts");
    }
    approvedBy = approver.id;
    approvedByName = approver.name;
  }

  enqueue({
    clientUuid,
    cashierId: p.cashierId,
    cashierName: p.cashierName,
    orderId: p.orderId,
    lines: p.lines,
    discountAmount: p.discountAmount,
    discountReason: p.discountReason,
    tipAmount: p.tipAmount,
    paymentMethod: p.paymentMethod,
    amountTendered: p.amountTendered,
    changeDue,
    subtotal: p.subtotal,
    total: p.total,
    approvedBy,
    approvedByName,
    accountId: p.accountId,
    accountName: p.accountName,
    paidCash: p.paidCash,
    paidCard: p.paidCard,
    createdAt,
  });

  // Build the sale locally so the receipt prints immediately (RawBT is local).
  const sale: Sale = {
    id: clientUuid,
    cashier_id: p.cashierId,
    cashier_name: p.cashierName,
    subtotal: p.subtotal,
    discount_amount: p.discountAmount,
    discount_reason: p.discountReason,
    tip_amount: p.tipAmount,
    total: p.total,
    status: "completed",
    approved_by: approvedBy,
    approved_by_name: approvedByName,
    payment_method: p.paymentMethod,
    amount_tendered: p.amountTendered,
    change_due: changeDue,
    label: p.label,
    account_id: p.accountId,
    paid_cash: p.paidCash,
    paid_card: p.paidCard,
    created_at: createdAt,
  };

  // Best-effort: if we *think* we're online but the request failed, kick a sync.
  if (isOnline()) void syncNow();
  return { sale, queued: true };
}

// Supabase/PostgREST errors are plain objects (not Error instances), so pull a
// human-readable message from whichever field carries it.
function syncErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const msg =
      (o.message as string) ||
      (o.details as string) ||
      (o.hint as string) ||
      (o.error_description as string) ||
      (o.code ? `Error ${o.code}` : "");
    if (msg) return String(msg);
  }
  return typeof e === "string" && e ? e : "Sync rejected";
}

let syncing = false;

/** Replay queued payments to the server (idempotent). Safe to call anytime. */
export async function syncNow(): Promise<void> {
  if (syncing || !isOnline()) return;
  syncing = true;
  try {
    for (const item of listQueue()) {
      try {
        await payOrderV2({
          clientUuid: item.clientUuid,
          cashierId: item.cashierId,
          orderId: item.orderId,
          lines: item.lines,
          discountAmount: item.discountAmount,
          discountReason: item.discountReason,
          tipAmount: item.tipAmount,
          paymentMethod: item.paymentMethod,
          amountTendered: item.amountTendered,
          approverPin: null,
          approvedBy: item.approvedBy,
          createdAt: item.createdAt,
          offline: true,
          accountId: item.accountId,
          paidCash: item.paidCash,
          paidCard: item.paidCard,
        });
        removeFromQueue(item.clientUuid);
      } catch (e) {
        if (isNetworkError(e) || isMissingRpcError(e)) {
          // Connection dropped, or the migration isn't applied yet — keep the
          // item queued and retry later rather than discarding the sale.
          bumpAttempt(item.clientUuid);
          break;
        }
        // Permanent rejection: park it so it stops blocking the rest.
        moveToFailed(item, syncErrorMessage(e));
      }
    }
  } finally {
    syncing = false;
  }
}

let syncingOrders = false;

/** Push open orders parked on this device to the server. Safe to call anytime. */
export async function syncOrders(): Promise<void> {
  if (syncingOrders || !isOnline()) return;
  syncingOrders = true;
  try {
    for (const o of listLocalOrders()) {
      try {
        // Parked orders are always created fresh on the server (the device id is
        // never sent), then dropped from the local store once they land.
        await saveOrder(o.cashierId, null, o.label ?? "", o.lines);
        removeLocalOrder(o.localId);
      } catch (e) {
        // Network blip: keep it and retry later. Anything else (e.g. an item is
        // no longer on the menu) also stays put so nothing is lost; stop the
        // loop so it doesn't spin, and the cashier can re-key it if needed.
        if (!isNetworkError(e)) {
          // leave the order in place for a later attempt / manual handling
        }
        break;
      }
    }
  } finally {
    syncingOrders = false;
  }
}

// Background triggers: sync when the connection returns, periodically while
// there's anything queued, and once shortly after load.
if (typeof window !== "undefined") {
  onNetworkChange((online) => {
    if (online) {
      void syncNow();
      void syncOrders();
    }
  });
  setInterval(() => {
    if (queueCount() > 0) void syncNow();
    if (localOrdersCount() > 0) void syncOrders();
  }, 30_000);
  setTimeout(() => {
    void syncNow();
    void syncOrders();
  }, 1_500);
}

/** React hook: pending (to sync) and failed counts for the UI. */
export function usePendingSync(): { pending: number; failed: number } {
  const read = () => ({
    pending: queueCount() + localOrdersCount(),
    failed: failedCount(),
  });
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    const offQueue = onQueueChange(update);
    const offOrders = onLocalOrdersChange(update);
    return () => {
      offQueue();
      offOrders();
    };
  }, []);
  return state;
}
