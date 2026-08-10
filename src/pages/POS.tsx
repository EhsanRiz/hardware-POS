import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  approveSale,
  fetchCatalogue,
  fetchCategories,
  listCustomers,
  NotPairedError,
} from "../lib/api";
import { verifyPinOffline } from "../lib/auth";
import { isPaired } from "../lib/device";
import { money } from "../lib/format";
import { cacheGet, cacheSet } from "../lib/localCache";
import { useOnline } from "../lib/offline";
import { can } from "../lib/permissions";
import { printReceipt } from "../lib/print";
import { buildQuoteText, buildReceiptText } from "../lib/receipt";
import { refreshSettings } from "../lib/settings";
import { submitSale, usePendingSync } from "../lib/sync";
import type {
  CartLine,
  Category,
  Customer,
  PaymentMethod,
  Product,
  ReceiptItem,
  Sale,
} from "../lib/types";

import Cart from "../components/Cart";
import DiscountModal from "../components/DiscountModal";
import FailedSales from "../components/FailedSales";
import PairRegister from "../components/PairRegister";
import PaymentModal from "../components/PaymentModal";
import ManagerPinModal from "../components/ManagerPinModal";
import ProductSearch from "../components/ProductSearch";
import ShopLogo from "../components/ShopLogo";

// The catalogue is cached so the till can sell through an outage. It is the one
// piece of server state the shop genuinely cannot work without.
const CATALOGUE_KEY = "catalogue.products";
const CATEGORIES_KEY = "catalogue.categories";
const CUSTOMERS_KEY = "catalogue.customers";

export default function POS() {
  const { user, logout } = useAuth();
  const online = useOnline();
  const { pending, failed } = usePendingSync();

  const [paired, setPaired] = useState(isPaired());
  const [products, setProducts] = useState<Product[]>(() =>
    cacheGet<Product[]>(CATALOGUE_KEY, [])
  );
  const [categories, setCategories] = useState<Category[]>(() =>
    cacheGet<Category[]>(CATEGORIES_KEY, [])
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

  const [showPayment, setShowPayment] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  const [showFailed, setShowFailed] = useState(false);
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
      setCategories(c);
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
        // Scanning the same barcode twice means two of them.
        return prev.map((l) =>
          l.product.id === p.id ? { ...l, qty: l.qty + 1 } : l
        );
      }
      return [...prev, { product: p, qty: 1 }];
    });
  }

  function setQty(productId: string, qty: number) {
    setLines((prev) =>
      prev.map((l) => (l.product.id === productId ? { ...l, qty } : l))
    );
  }

  function removeLine(productId: string) {
    setLines((prev) => prev.filter((l) => l.product.id !== productId));
  }

  function clearSale() {
    setLines([]);
    setCustomer(null);
    setDiscount(0);
    setDiscountReason(null);
    setApproverPin(null);
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

      setShowPayment(false);
      clearSale();
      setBanner(
        queued
          ? "Saved on this device — it will sync when the connection returns."
          : `${sale.doc_number ?? "Sale"} completed.`
      );
      if (!queued) void refresh();
    } catch (e) {
      setBanner(
        e instanceof Error ? e.message : "The sale was refused. Nothing charged."
      );
    } finally {
      setBusy(false);
    }
  }

  if (!paired) return <PairRegister onPaired={() => setPaired(true)} />;

  return (
    <div className="h-screen flex flex-col bg-stone-50">
      <header className="flex items-center gap-3 px-3 py-2 bg-white border-b border-stone-200 shrink-0">
        <ShopLogo className="h-8 w-auto" />
        <div className="ml-auto flex items-center gap-2 text-sm">
          {!online && (
            <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-800 text-xs">
              Offline
            </span>
          )}
          {pending > 0 && (
            <span className="px-2 py-1 rounded-full bg-sky-100 text-sky-800 text-xs">
              {pending} to sync
            </span>
          )}
          {failed > 0 && (
            <button
              onClick={() => setShowFailed(true)}
              className="px-2 py-1 rounded-full bg-red-100 text-red-800 text-xs"
            >
              {failed} failed
            </button>
          )}
          <span className="text-stone-600">{user?.name}</span>
          <button onClick={logout} className="text-stone-500 px-2">
            Sign out
          </button>
        </div>
      </header>

      {banner && (
        <div
          onClick={() => setBanner(null)}
          className="px-4 py-2 bg-stone-800 text-white text-sm cursor-pointer shrink-0"
        >
          {banner}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <section className="flex-1 min-w-0 border-r border-stone-200 bg-white">
          <ProductSearch
            products={products}
            categories={categories}
            trade={trade}
            onAdd={addProduct}
          />
        </section>

        <aside className="w-[22rem] shrink-0 flex flex-col bg-white">
          {customer && (
            <div className="px-3 py-2 bg-emerald-50 border-b border-emerald-100 text-sm">
              <div className="font-medium text-emerald-900">{customer.name}</div>
              <div className="text-xs text-emerald-700">
                {trade ? "trade pricing · " : ""}
                balance {money(customer.balance)}
              </div>
            </div>
          )}

          <Cart
            lines={lines}
            trade={trade}
            onSetQty={setQty}
            onRemove={removeLine}
          />

          <div className="border-t border-stone-200 p-3 space-y-2 shrink-0">
            <div className="flex justify-between text-sm text-stone-600">
              <span>Subtotal</span>
              <span className="tabular-nums">{money(subtotal)}</span>
            </div>
            {discount > 0 && (
              <div className="flex justify-between text-sm text-emerald-700">
                <span>Discount</span>
                <span className="tabular-nums">−{money(discount)}</span>
              </div>
            )}
            <div className="flex justify-between text-xl font-bold">
              <span>Total</span>
              <span className="tabular-nums">{money(total)}</span>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                disabled={lines.length === 0}
                onClick={() =>
                  printReceipt(
                    buildQuoteText(lines, {
                      subtotal,
                      discount,
                      total,
                      trade,
                    }),
                    "Quote"
                  )
                }
                className="py-2.5 rounded-xl bg-stone-100 text-stone-700 text-sm
                           disabled:opacity-40"
              >
                Print quote
              </button>
              <button
                disabled={lines.length === 0 || !can(user, "apply_discount")}
                onClick={() => setShowDiscount(true)}
                className="py-2.5 rounded-xl bg-stone-100 text-stone-700 text-sm
                           disabled:opacity-40"
              >
                Discount
              </button>
            </div>

            <button
              disabled={lines.length === 0 || !can(user, "take_payments")}
              onClick={() => setShowPayment(true)}
              className="w-full py-3.5 rounded-xl bg-emerald-600 text-white
                         text-lg font-semibold disabled:opacity-40"
            >
              Charge {money(total)}
            </button>

            {lines.length > 0 && (
              <button
                onClick={clearSale}
                className="w-full py-2 text-sm text-stone-500"
              >
                Clear sale
              </button>
            )}
          </div>
        </aside>
      </div>

      {showPayment && (
        <PaymentModal
          total={total}
          customers={customers}
          customer={customer}
          onPickCustomer={setCustomer}
          onCancel={() => setShowPayment(false)}
          onConfirm={confirmPayment}
          busy={busy}
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

      {showFailed && <FailedSales onClose={() => setShowFailed(false)} />}
    </div>
  );
}

/** Re-exported so App can offer approval of a parked sale. */
export { approveSale };
export type { Sale };
