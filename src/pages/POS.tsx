import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  approveSale,
  closeQuote,
  fetchCatalogue,
  fetchCategories,
  listCustomers,
  NotPairedError,
  saveQuote,
  type QuoteLine,
  type QuoteSummary,
} from "../lib/api";
import { adminListProducts, stockMovements } from "../lib/adminApi";
import { findByPinOffline } from "../lib/auth";
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
  Payment,
  Product,
  ReceiptItem,
  Sale,
} from "../lib/types";

import Accounts from "../components/accounts/Accounts";
import Quotes, { recallWarnings, sellableLines } from "../components/quotes/Quotes";
import Stock from "../components/stock/Stock";
import Admin from "../components/Admin";
import DiscountModal from "../components/DiscountModal";
import FailedSales from "../components/FailedSales";
import PairRegister from "../components/PairRegister";
import ManagerPinModal from "../components/ManagerPinModal";
import CustomerPicker from "../components/sell/CustomerPicker";
import LineItems from "../components/sell/LineItems";
import PaymentColumn from "../components/sell/PaymentColumn";
import ProductDetail from "../components/sell/ProductDetail";
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

  // On a tablet the payment column is a sheet raised from the bar; on a wide
  // screen it is always docked and this flag is ignored by the stylesheet.
  const [payOpen, setPayOpen] = useState(false);
  // Which section fills the frame. Sell is home; the others swap the counter
  // for the debtors book or the stock room. Deliberately NOT a route: an
  // in-progress sale must survive a glance at an account or a shelf.
  const [section, setSection] = useState<"sell" | "accounts" | "stock" | "quotes">("sell");
  // The product being looked at closely, and what confirming it means. From a
  // search result it ADDS the quantity chosen; from a line already in the sale
  // it REPLACES that line's quantity.
  const [inspecting, setInspecting] = useState<{
    product: Product;
    mode: "add" | "edit";
  } | null>(null);
  // The open quote this cart came from, so completing the sale closes it and
  // the paper trail joins up: QUO-000031 -> INV-000214.
  const [fromQuote, setFromQuote] = useState<{ id: string; doc: string } | null>(null);
  // Stock changes things, so entering it costs a PIN — verified server-side by
  // the first inventory call, then held in memory only, like the back office.
  const [stockPin, setStockPin] = useState<string | null>(null);
  const [askStockPin, setAskStockPin] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  // The line a discount is being set on. The sale-level one has no product id.
  const [discountLine, setDiscountLine] = useState<string | null>(null);
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
        // F2 means "I want to type another item", so a closer look standing
        // open is dismissed rather than left with the caret behind it.
        setInspecting(null);
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
  // What the lines took off themselves, before anything comes off the sale.
  const itemsDiscount = useMemo(
    () => Math.round(lines.reduce((sum, l) => sum + (l.discount ?? 0), 0) * 100) / 100,
    [lines]
  );
  // Everything off, which is what the customer sees on one line of the slip.
  const allDiscount = Math.round((itemsDiscount + discount) * 100) / 100;
  const total = Math.max(0, subtotal - allDiscount);
  // The sale-level discount spreads over what is left of the lines, mirroring
  // the server: a line already marked down must not take a second helping in
  // proportion to a price it is no longer being sold at.
  const netSubtotal = Math.max(0, subtotal - itemsDiscount);

  function addProduct(p: Product, qty = 1) {
    setLines((prev) => {
      const found = prev.find((l) => l.product.id === p.id);
      if (found) {
        // Scanning the same barcode twice means two of them, not two lines.
        return prev.map((l) =>
          l.product.id === p.id ? { ...l, qty: l.qty + qty } : l
        );
      }
      return [...prev, { product: p, qty }];
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
    setPayOpen(false);
    setLines([]);
    setCustomer(null);
    setDiscount(0);
    setDiscountReason(null);
    setApproverPin(null);
    setFreshId(null);
    setFromQuote(null);
    setTerm("");
    scanRef.current?.focus();
  }

  /**
   * A quote comes back to the counter.
   *
   * The lines land in the cart priced from TODAY's catalogue — the server
   * reprices every sale, so the till cannot promise otherwise. What the till
   * can do is be honest about it: any drift from the quoted price is put in
   * the banner before a single item is rung, so honouring the promise (with a
   * discount) is a decision made looking at the difference, not after it.
   */
  function recallQuote(q: QuoteSummary, quoteLines: QuoteLine[]) {
    const byId = new Map(products.map((p) => [p.id, p]));
    const cart: CartLine[] = [];
    let missing = 0;
    for (const l of sellableLines(quoteLines)) {
      const product = byId.get(l.product_id!);
      if (!product) {
        missing++;
        continue;
      }
      cart.push({ product, qty: l.qty });
    }
    setLines(cart);
    setCustomer(customers.find((c) => c.id === q.customer_id) ?? null);
    setDiscount(0);
    setDiscountReason(null);
    setFromQuote({ id: q.id, doc: q.doc_number ?? "Quote" });
    setSection("sell");

    const warn = recallWarnings(quoteLines);
    const gaps = missing
      ? `${missing} line${missing === 1 ? "" : "s"} not in this till's catalogue were left off. `
      : "";
    setBanner(
      `${q.doc_number ?? "Quote"} loaded.` +
        (gaps || warn ? ` ${gaps}${warn ?? ""}` : "")
    );
  }

  /**
   * The cart becomes a quote: saved under a QUO number, then printed.
   *
   * Offline it still prints — a builder at the counter cannot wait for the
   * line — but without a number, and the slip says so.
   */
  async function quoteThis() {
    if (!user || lines.length === 0) return;
    if (!online) {
      printReceipt(
        buildQuoteText(lines, { subtotal, discount, total, trade }),
        "Quote"
      );
      setBanner("Printed unsaved — quotes get a number when the line is back.");
      return;
    }
    setBusy(true);
    try {
      const q = await saveQuote(
        user.id,
        lines.map((l) => ({ product_id: l.product.id, qty: l.qty })),
        customer?.id ?? null
      );
      printReceipt(
        buildQuoteText(lines, {
          subtotal,
          discount,
          total,
          trade,
          docNumber: q.doc_number,
          validUntil: q.valid_until,
        }),
        "Quote"
      );
      setBanner(`${q.doc_number} saved — bring it back by number.`);
      clearSale();
    } catch (e) {
      setBanner(errorMessage(e, "The quote could not be saved"));
    } finally {
      setBusy(false);
    }
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
      const net = gross - (l.discount ?? 0);
      const share = netSubtotal > 0 ? (net * total) / netSubtotal : 0;
      return {
        name: l.product.name,
        unit_code: l.product.unit_code,
        qty: l.qty,
        unit_price: priceOf(l.product),
        line_total: Math.round(share * 100) / 100,
        discount_amount: l.discount ?? 0,
        discount_percent: l.discountPercent ?? null,
      };
    });
  }

  async function confirmPayment(p: {
    payments: Payment[];
    amountTendered: number | null;
    rounding: number;
    poNumber: string | null;
    customerVatNumber: string | null;
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
        // The summary method: one tender keeps its name, several are "mixed".
        paymentMethod:
          p.payments.length === 1 ? p.payments[0].method : "mixed",
        payments: p.payments,
        amountTendered: p.amountTendered,
        rounding: p.rounding,
        poNumber: p.poNumber,
        customerVatNumber: p.customerVatNumber,
        approverPin,
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? null,
        tradePricing: trade,
        paidCash:
          p.payments.filter((x) => x.method === "cash")
            .reduce((sum, x) => sum + x.amount, 0) || null,
        paidCard:
          p.payments.filter((x) => x.method !== "cash")
            .reduce((sum, x) => sum + x.amount, 0) || null,
        note: null,
      });

      printReceipt(
        // The tenders go on the slip: a customer disputing a card charge needs
        // to see which card, for how much, against which invoice.
        buildReceiptText(sale, receiptItems(), customer, p.payments),
        "Tax Invoice"
      );

      // If this cart came off a quote and the sale reached the server, close
      // the quote against it. A queued offline sale leaves the quote open —
      // better an open quote that was honoured than a closed one whose sale
      // never synced.
      if (fromQuote && !queued && sale.id) {
        try {
          await closeQuote(user.id, fromQuote.id, "converted", sale.id);
        } catch {
          // The sale stands either way; the quote can be tidied later.
        }
      }

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

  const header = (
    <SellHeader
      user={user}
      online={online}
      pending={pending}
      failed={failed}
      canManage={canAny(user, ["manage_catalogue", "manage_inventory"])}
      section={section}
      canAccounts={can(user, "take_payments")}
      canQuotes={can(user, "take_payments")}
      canStock={can(user, "manage_inventory")}
      onSection={(s) => {
        if (s === "stock" && !stockPin) {
          setAskStockPin(true);
          return;
        }
        setSection(s);
      }}
      onShowFailed={() => setShowFailed(true)}
      onManage={() => setAskAdminPin(true)}
      onSignOut={logout}
    />
  );

  // Accounts and Stock replace the counter, not the frame: the header keeps
  // the sync state and the way back, and a parked sale stays parked underneath.
  if ((section === "accounts" || section === "quotes" ||
       (section === "stock" && stockPin)) && user) {
    return (
      <div className="sell">
        {header}
        {section === "accounts" ? (
          <Accounts user={user} />
        ) : section === "quotes" ? (
          <Quotes user={user} onRecall={recallQuote} />
        ) : (
          <Stock pin={stockPin!} />
        )}
        <footer className="sell-foot">
          <InnovaMark size={16} />
          <span>InnovaPOS · a product of InnovaEarth</span>
          <span className="push">
            © {new Date().getFullYear()} InnovaEarth · All rights reserved
          </span>
        </footer>
      </div>
    );
  }

  return (
    <div className="sell">
      {header}

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
            onInspect={(p) => setInspecting({ product: p, mode: "add" })}
            onPickCustomer={() => setShowCustomers(true)}
            inputRef={scanRef}
          />

          <LineItems
            lines={lines}
            trade={trade}
            freshId={freshId}
            onSetQty={setQty}
            onRemove={removeLine}
            onDiscountLine={(id) => setDiscountLine(id)}
            onInspect={(p) => setInspecting({ product: p, mode: "edit" })}
          />

          <div className="sell-actions">
            <button
              className="btn-line"
              disabled={lines.length === 0 || busy}
              onClick={() => void quoteThis()}
            >
              Save as quote
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
          discount={allDiscount}
          total={total}
          trade={trade}
          customer={customer}
          busy={busy}
          canPay={can(user, "take_payments")}
          open={payOpen}
          onClose={() => setPayOpen(false)}
          onPickCustomer={() => setShowCustomers(true)}
          onComplete={confirmPayment}
        />
      </div>

      {/* Only rendered as a bar on narrow screens (CSS); it is the one control
          that raises the payment sheet, and it always shows what is owed. */}
      <div className="pay-bar">
        <span>
          <span className="lbl">Total</span>
          <span className="fig">{money(total)}</span>
        </span>
        <button
          className="btn-tender"
          disabled={lines.length === 0 || !can(user, "take_payments")}
          onClick={() => setPayOpen(true)}
        >
          Take payment
        </button>
      </div>

      <footer className="sell-foot">
        <InnovaMark size={16} />
        <span>InnovaPOS · a product of InnovaEarth</span>
        <span className="push">
          © {new Date().getFullYear()} InnovaEarth · All rights reserved
        </span>
      </footer>

      {/* Recording a buyer is authorised by the cashier's own permission, so
          there is no picker without one signed in. */}
      {showCustomers && user && (
        <CustomerPicker
          customers={customers}
          cashierId={user.id}
          onPick={(c) => {
            setCustomer(c);
            setShowCustomers(false);
            scanRef.current?.focus();
          }}
          onAdded={(c) => {
            // Into the cache as well as the list: the next time this buyer
            // comes in, their number must still be findable with the line down.
            setCustomers((prev) => {
              const next = [...prev.filter((p) => p.id !== c.id), c].sort((a, b) =>
                a.name.localeCompare(b.name)
              );
              cacheSet(CUSTOMERS_KEY, next);
              return next;
            });
          }}
          onClose={() => setShowCustomers(false)}
        />
      )}

      {inspecting && (
        <ProductDetail
          product={inspecting.product}
          trade={trade}
          mode={inspecting.mode}
          inSale={
            lines.find((l) => l.product.id === inspecting.product.id)?.qty ?? 0
          }
          onConfirm={(p, qty) => {
            if (inspecting.mode === "edit") {
              setQty(p.id, qty);
            } else {
              addProduct(p, qty);
              // The query has done its job; leaving it behind pollutes the next
              // scan, and the field must be ready for one.
              setTerm("");
            }
            setInspecting(null);
            scanRef.current?.focus();
          }}
          onClose={() => {
            setInspecting(null);
            scanRef.current?.focus();
          }}
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

      {/* The same dialog, aimed at one line. Money off a ladder is the same
          decision as money off the sale — same arithmetic, same approval — so
          it is the same screen rather than a second one to learn. */}
      {discountLine && (
        <DiscountModal
          subtotal={(() => {
            const l = lines.find((x) => x.product.id === discountLine);
            return l ? priceOf(l.product) * l.qty : 0;
          })()}
          onCancel={() => setDiscountLine(null)}
          onApply={(amount, reason) => {
            // The percentage is recovered from the reason the modal writes, so
            // the slip can name it. The server works the amount out again from
            // the percentage, which is what stops the two disagreeing.
            const pct = /^(\d+(?:\.\d+)?)% off/.exec(reason)?.[1];
            setLines((prev) =>
              prev.map((l) =>
                l.product.id === discountLine
                  ? {
                      ...l,
                      discount: amount,
                      discountPercent: pct ? Number(pct) : null,
                    }
                  : l
              )
            );
            setDiscountLine(null);
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
            const approver = await findByPinOffline(pin);
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

      {askStockPin && (
        <ManagerPinModal
          title="Stock"
          subtitle="Enter your PIN to open the stock room"
          onApprove={async (entered) => {
            // Proved against the server by the cheapest inventory call; fails
            // loudly on a wrong PIN or a missing permission.
            await stockMovements(entered, 1);
            setStockPin(entered);
            setAskStockPin(false);
            setSection("stock");
          }}
          onCancel={() => setAskStockPin(false)}
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
