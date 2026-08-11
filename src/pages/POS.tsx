import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  approveSale,
  fetchCatalogue,
  fetchCategories,
  listCustomers,
  NotPairedError,
} from "../lib/api";
import { adminListProducts } from "../lib/adminApi";
import { verifyPinOffline } from "../lib/auth";
import { errorMessage } from "../lib/errors";
import { isPaired } from "../lib/device";
import { money } from "../lib/money";
import { cacheGet, cacheSet } from "../lib/localCache";
import { useOnline } from "../lib/offline";
import { can, canAny } from "../lib/permissions";
import { printReceipt } from "../lib/print";
import { buildQuoteText, buildReceiptText } from "../lib/receipt";
import { refreshSettings } from "../lib/settings";
import { submitSale, usePendingSync } from "../lib/sync";
import type {
  CartLine,
  Customer,
  PaymentMethod,
  Product,
  ReceiptItem,
  Sale,
} from "../lib/types";

import Admin from "../components/Admin";
import DiscountModal from "../components/DiscountModal";
import FailedSales from "../components/FailedSales";
import PairRegister from "../components/PairRegister";
import ManagerPinModal from "../components/ManagerPinModal";
import CustomerPicker from "../components/sell/CustomerPicker";
import LineItems from "../components/sell/LineItems";
import PaymentColumn from "../components/sell/PaymentColumn";
import ScanBar from "../components/sell/ScanBar";
import SellHeader from "../components/sell/SellHeader";
import InnovaMark from "../components/InnovaMark";

// The catalogue is cached so the till can sell through an outage. It is the one
// piece of server state the shop genuinely cannot work without.
const CATALOGUE_KEY = "catalogue.products";
const CATEGORIES_KEY = "catalogue.categories";
const CUSTOMERS_KEY = "catalogue.customers";
const PARKED_KEY = "sell.parked";

/** A sale set aside to serve the next customer while this one fetches a card. */
interface ParkedSale {
  id: string;
  at: string;
  lines: CartLine[];
  customer: Customer | null;
  discount: number;
  discountReason: string | null;
}

/**
 * The Sell screen.
 *
 * Four jobs and nothing else: scan, bill, take payment, print. Quotes,
 * statements, age analysis and stock takes are deliberately absent — the
 * handoff puts them in the sibling products, and a counter screen that tries to
 * hold every operational reality at once is precisely why the incumbent
 * hardware POS software is disliked.
 *
 * Layout and every measurement come from design_handoff_innovapos §1; the
 * styles live in src/styles/sell.css.
 */
export default function POS() {
  const { user, logout } = useAuth();
  const online = useOnline();
  const { pending, failed } = usePendingSync();

  const [paired, setPaired] = useState(isPaired());
  const [products, setProducts] = useState<Product[]>(() =>
    cacheGet<Product[]>(CATALOGUE_KEY, [])
  );
  const [customers, setCustomers] = useState<Customer[]>(() =>
    cacheGet<Customer[]>(CUSTOMERS_KEY, [])
  );

  const [lines, setLines] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [discount, setDiscount] = useState(0);
  const [discountReason, setDiscountReason] = useState<string | null>(null);
  // A discount applied by someone who cannot approve one needs a manager at the
  // counter. Their PIN is held only until the sale is submitted, then dropped —
  // it is never queued, and never written to the device.
  const [approverPin, setApproverPin] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);

  const [term, setTerm] = useState("");
  const scanRef = useRef<HTMLInputElement>(null);
  // Drives the just-scanned row tint, cleared on a timer.
  const [freshId, setFreshId] = useState<string | null>(null);
  const freshTimer = useRef<number>();

  const [parked, setParked] = useState<ParkedSale[]>(() =>
    cacheGet<ParkedSale[]>(PARKED_KEY, [])
  );

  const [showDiscount, setShowDiscount] = useState(false);
  const [showFailed, setShowFailed] = useState(false);
  const [showCustomers, setShowCustomers] = useState(false);
  // The back office asks for the PIN once and keeps it in memory only: every
  // admin RPC re-verifies it server-side, so it has to travel with each call.
  const [adminPin, setAdminPin] = useState<string | null>(null);
  const [askAdminPin, setAskAdminPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // A trade customer prices off the trade list. Resolved server-side too — this
  // is only so the cashier sees the same numbers the invoice will show.
  const trade = customer?.is_trade ?? false;

  const refresh = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([fetchCatalogue(), fetchCategories()]);
      setProducts(p);
      cacheSet(CATALOGUE_KEY, p);
      // Categories are not shown on this screen, but the back office reads them
      // from the same cache and may be opened with the line down.
      cacheSet(CATEGORIES_KEY, c);
      void refreshSettings();
      try {
        const cust = await listCustomers();
        setCustomers(cust);
        cacheSet(CUSTOMERS_KEY, cust);
      } catch {
        // Customers are a nice-to-have; a till with no account list can still
        // take cash. Fall back to whatever was cached.
      }
    } catch (e) {
      if (e instanceof NotPairedError) setPaired(false);
      // Otherwise stay on the cached catalogue — this is the offline path.
    }
  }, []);

  useEffect(() => {
    if (paired) void refresh();
  }, [paired, refresh]);

  // F2 opens search from anywhere, as the handoff requires. The scan field also
  // takes focus back after every completed action, because a scanner types
  // wherever the caret happens to be and a barcode that lands in a quantity
  // field is a silent mis-sale.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        scanRef.current?.focus();
        scanRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => () => window.clearTimeout(freshTimer.current), []);

  const priceOf = useCallback(
    (p: Product) =>
      trade && p.price_trade != null ? p.price_trade : p.price_retail,
    [trade]
  );

  const subtotal = useMemo(
    () => lines.reduce((sum, l) => sum + priceOf(l.product) * l.qty, 0),
    [lines, priceOf]
  );
  const total = Math.max(0, subtotal - discount);

  function addProduct(p: Product) {
    setLines((prev) => {
      const found = prev.find((l) => l.product.id === p.id);
      if (found) {
        // Scanning the same barcode twice means two of them, not two lines.
        return prev.map((l) =>
          l.product.id === p.id ? { ...l, qty: l.qty + 1 } : l
        );
      }
      return [...prev, { product: p, qty: 1 }];
    });

    // The tint decays after ~1.2s: long enough to pull the eye to the new line,
    // short enough that it is gone before the next scan.
    setFreshId(p.id);
    window.clearTimeout(freshTimer.current);
    freshTimer.current = window.setTimeout(() => setFreshId(null), 1200);
  }

  function setQty(productId: string, qty: number) {
    setLines((prev) =>
      prev.map((l) => (l.product.id === productId ? { ...l, qty } : l))
    );
  }

  function removeLine(productId: string) {
    setLines((prev) => prev.filter((l) => l.product.id !== productId));
    scanRef.current?.focus();
  }

  function clearSale() {
    setLines([]);
    setCustomer(null);
    setDiscount(0);
    setDiscountReason(null);
    setApproverPin(null);
    setFreshId(null);
    setTerm("");
    scanRef.current?.focus();
  }

  /** Set the sale aside so the next customer can be served. */
  function park() {
    if (lines.length === 0) return;
    const next = [
      ...parked,
      {
        id: String(Date.now()),
        at: new Date().toISOString(),
        lines,
        customer,
        discount,
        discountReason,
      },
    ];
    setParked(next);
    cacheSet(PARKED_KEY, next);
    clearSale();
    setBanner("Sale parked. Resume it from the button below.");
  }

  function resumeParked() {
    const last = parked[parked.length - 1];
    if (!last) return;
    // Parking the current sale first would be surprising; refusing to lose it
    // is not. The cashier parks or clears deliberately.
    if (lines.length > 0) {
      setBanner("Finish or park this sale before resuming another.");
      return;
    }
    const rest = parked.slice(0, -1);
    setParked(rest);
    cacheSet(PARKED_KEY, rest);
    setLines(last.lines);
    setCustomer(last.customer);
    setDiscount(last.discount);
    setDiscountReason(last.discountReason);
    scanRef.current?.focus();
  }

  function receiptItems(): ReceiptItem[] {
    // Mirror the server's pro-rata discount split so the printed slip and the
    // stored invoice agree line for line.
    return lines.map((l) => {
      const gross = priceOf(l.product) * l.qty;
      const share = subtotal > 0 ? (gross * total) / subtotal : 0;
      return {
        name: l.product.name,
        unit_code: l.product.unit_code,
        qty: l.qty,
        unit_price: priceOf(l.product),
        line_total: Math.round(share * 100) / 100,
      };
    });
  }

  async function confirmPayment(p: {
    method: PaymentMethod;
    amountTendered: number | null;
    paidCash: number | null;
    paidCard: number | null;
  }) {
    if (!user) return;
    setBusy(true);
    try {
      const { sale, queued } = await submitSale({
        cashierId: user.id,
        cashierName: user.name,
        lines,
        subtotal,
        discountAmount: discount,
        discountReason,
        total,
        paymentMethod: p.method,
        amountTendered: p.amountTendered,
        approverPin,
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? null,
        tradePricing: trade,
        paidCash: p.paidCash,
        paidCard: p.paidCard,
        note: null,
      });

      printReceipt(
        buildReceiptText(sale, receiptItems(), customer),
        "Tax Invoice"
      );

      clearSale();
      setBanner(
        queued
          ? "Saved on this device — it will sync when the connection returns."
          : `${sale.doc_number ?? "Sale"} completed.`
      );
      if (!queued) void refresh();
    } catch (e) {
      // The server's reason is the useful part — "Not enough stock for X",
      // "Over credit limit: R500 available" — and it arrives as a plain object,
      // so it needs extracting rather than an instanceof check.
      setBanner(errorMessage(e, "The sale was refused. Nothing charged."));
    } finally {
      setBusy(false);
    }
  }

  if (!paired) return <PairRegister onPaired={() => setPaired(true)} />;

  return (
    <div className="sell">
      <SellHeader
        user={user}
        online={online}
        pending={pending}
        failed={failed}
        canManage={canAny(user, ["manage_catalogue", "manage_inventory"])}
        onShowFailed={() => setShowFailed(true)}
        onManage={() => setAskAdminPin(true)}
        onSignOut={logout}
      />

      {banner && (
        <div className="sell-banner" onClick={() => setBanner(null)} role="status">
          {banner}
          <span className="dismiss">dismiss</span>
        </div>
      )}

      <div className="sell-body">
        <section className="sell-left">
          <ScanBar
            term={term}
            onTermChange={setTerm}
            products={products}
            trade={trade}
            customer={customer}
            onAdd={addProduct}
            onPickCustomer={() => setShowCustomers(true)}
            inputRef={scanRef}
          />

          <LineItems
            lines={lines}
            trade={trade}
            freshId={freshId}
            onSetQty={setQty}
            onRemove={removeLine}
          />

          <div className="sell-actions">
            <button
              className="btn-line"
              disabled={lines.length === 0}
              onClick={() =>
                printReceipt(
                  buildQuoteText(lines, { subtotal, discount, total, trade }),
                  "Quote"
                )
              }
            >
              Print quote
            </button>

            <button
              className="btn-line"
              disabled={lines.length === 0 || !can(user, "apply_discount")}
              onClick={() => setShowDiscount(true)}
            >
              Discount
            </button>

            <button
              className="btn-line"
              disabled={lines.length === 0}
              onClick={park}
            >
              Park sale
            </button>

            {parked.length > 0 && (
              <button className="btn-line" onClick={resumeParked}>
                Resume parked · {parked.length}
              </button>
            )}

            <button
              className="btn-line quiet push"
              disabled={lines.length === 0}
              onClick={clearSale}
            >
              Void sale
            </button>
          </div>
        </section>

        <PaymentColumn
          lines={lines}
          subtotal={subtotal}
          discount={discount}
          total={total}
          trade={trade}
          customer={customer}
          busy={busy}
          canPay={can(user, "take_payments")}
          onComplete={confirmPayment}
        />
      </div>

      <footer className="sell-foot">
        <InnovaMark size={16} />
        <span>InnovaPOS · a product of InnovaEarth</span>
        <span className="push">
          © {new Date().getFullYear()} InnovaEarth · All rights reserved
        </span>
      </footer>

      {showCustomers && (
        <CustomerPicker
          customers={customers}
          onPick={(c) => {
            setCustomer(c);
            setShowCustomers(false);
            scanRef.current?.focus();
          }}
          onClose={() => setShowCustomers(false)}
        />
      )}

      {showDiscount && (
        <DiscountModal
          subtotal={subtotal}
          onCancel={() => setShowDiscount(false)}
          onApply={(amount, reason) => {
            setDiscount(amount);
            setDiscountReason(reason);
            setShowDiscount(false);
            // Managers approve their own; everyone else needs a PIN now, so the
            // sale completes at the counter instead of parking for later.
            if (!can(user, "approve_discount")) setNeedsApproval(true);
          }}
        />
      )}

      {needsApproval && (
        <ManagerPinModal
          title="Manager approval"
          subtitle={`Discount of ${money(discount)} needs a manager's PIN`}
          onApprove={async (pin) => {
            // Checked against the device credential cache so this works during
            // an outage too; the server rechecks the approver's permission.
            const approver = await verifyPinOffline(pin);
            if (!approver || !can(approver, "approve_discount")) {
              throw new Error("That PIN can't approve discounts");
            }
            setApproverPin(pin);
            setNeedsApproval(false);
          }}
          onCancel={() => {
            // Backing out drops the discount rather than leaving one applied
            // that nobody authorised.
            setDiscount(0);
            setDiscountReason(null);
            setNeedsApproval(false);
          }}
        />
      )}

      {askAdminPin && (
        <ManagerPinModal
          title="Manage"
          subtitle="Enter your PIN to open the back office"
          onApprove={async (entered) => {
            // Proved against the server by the first admin call, which fails
            // loudly if the PIN is wrong or lacks the permission.
            await adminListProducts(entered);
            setAdminPin(entered);
            setAskAdminPin(false);
          }}
          onCancel={() => setAskAdminPin(false)}
        />
      )}

      {adminPin && (
        <Admin
          user={user}
          pin={adminPin}
          onClose={() => {
            setAdminPin(null);
            void refresh();
          }}
        />
      )}

      {showFailed && <FailedSales onClose={() => setShowFailed(false)} />}
    </div>
  );
}

/** Re-exported so App can offer approval of a parked sale. */
export { approveSale };
export type { Sale };
