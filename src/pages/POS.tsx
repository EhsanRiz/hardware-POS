import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  approveSale,
  checkApprovalCode,
  closeQuote,
  fetchCatalogue,
  fetchCategories,
  listCustomers,
  NotPairedError,
  quoteByNumber,
  quoteItems,
  saleByNumber,
  saveQuote,
  type QuoteLine,
  type QuoteSummary,
} from "../lib/api";
import SaleDetail from "../components/SaleDetail";
import type { SaleRow } from "../lib/sales";
import { adminListProducts, shelfLookup, stockMovements } from "../lib/adminApi";
import { findByPinOffline } from "../lib/auth";
import { errorMessage } from "../lib/errors";
import { isPaired } from "../lib/device";
import {
  cartLineCap,
  saleDiscountCeiling,
  staffLineCeiling,
  staffSaleCeiling,
} from "../lib/discountLimits";
import { money } from "../lib/money";
import { cacheGet, cacheSet } from "../lib/localCache";
import { cashSessionStatus, STALE_SESSION_HOURS, type CashSessionStatus } from "../lib/cashup";
import { useOnline } from "../lib/offline";
import { can, canAny } from "../lib/permissions";
import { printReceipt } from "../lib/print";
import { buildQuoteText, buildReceiptText, cartQuoteLines } from "../lib/receipt";
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
import Calculator from "../components/Calculator";
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
import { fmtWeekdayTime } from "../lib/dates";

// The catalogue is cached so the till can sell through an outage. It is the one
// piece of server state the shop genuinely cannot work without.
const CATALOGUE_KEY = "catalogue.products";
const CATEGORIES_KEY = "catalogue.categories";
const CUSTOMERS_KEY = "catalogue.customers";
const PARKED_KEY = "sell.parked";
/**
 * The sale in progress right now, kept on the device between renders.
 *
 * A counter screen is a browser tab, and a browser tab gets refreshed: a
 * mistyped URL, a stray gesture on a tablet, the PWA updating itself, a phone
 * killing a backgrounded page to save memory. Every one of those used to throw
 * away a basket that had been scanned item by item, with the customer standing
 * there — and the cashier's only clue was an empty screen.
 */
const LIVE_KEY = "sell.live";

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
  // A manager's single-use code, when they were not in the building. Only ever
  // one of the two: a PIN identifies somebody standing here, a code stands in
  // for somebody who is not.
  const [approvalCode, setApprovalCode] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  // How to put things back if the manager is not fetched after all. Backing
  // out has to undo the discount that raised the prompt and nothing else: a
  // cashier who gave 5% off one line within their limit, then 20% off another
  // and thought better of it, should keep the first.
  const undoDiscount = useRef<(() => void) | null>(null);

  const [term, setTerm] = useState("");
  const scanRef = useRef<HTMLInputElement>(null);
  // Drives the just-scanned row tint, cleared on a timer.
  const [freshId, setFreshId] = useState<string | null>(null);
  const freshTimer = useRef<number>();

  const [parked, setParked] = useState<ParkedSale[]>(() =>
    cacheGet<ParkedSale[]>(PARKED_KEY, [])
  );

  /**
   * A sale that was open when the screen reloaded becomes a parked sale.
   *
   * Parked rather than simply restored, and the difference is the point. A
   * refresh is not always an accident — a cashier with a screen that has gone
   * strange refreshes it deliberately — and a basket that silently reappears
   * is fighting whoever did that. Parking says what happened, hands the sale
   * back on one tap, and is a state the till already knows how to be in.
   *
   * The approval on a discount is deliberately NOT carried across. A PIN or a
   * code released a particular sale at a particular moment; resuming asks
   * again, which is the right side to be wrong on.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const live = cacheGet<ParkedSale | null>(LIVE_KEY, null);
    if (!live || !live.lines?.length) return;
    setParked((prev) => {
      const next = [...prev, { ...live, id: String(Date.now()), at: new Date().toISOString() }];
      cacheSet(PARKED_KEY, next);
      return next;
    });
    cacheSet(LIVE_KEY, null);
    setBanner("The sale that was open here has been parked. Resume it below.");
  }, []);

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
  // "Save as quote" with nobody picked asks who it is for first. Null when
  // the question is not being asked; the text typed so far while it is.
  const [quoteName, setQuoteName] = useState<string | null>(null);
  // The line a discount is being set on. The sale-level one has no product id.
  const [discountLine, setDiscountLine] = useState<string | null>(null);
  const [showFailed, setShowFailed] = useState(false);
  // The header's pocket calculator. A toggle, so the same button dismisses it.
  const [showCalc, setShowCalc] = useState(false);
  const [showCustomers, setShowCustomers] = useState(false);
  // The back office asks for the PIN once and keeps it in memory only: every
  // admin RPC re-verifies it server-side, so it has to travel with each call.
  const [adminPin, setAdminPin] = useState<string | null>(null);
  const [askAdminPin, setAskAdminPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  // A drawer opened on another day. Asked of the server on every refresh so
  // the notice appears at sign-in and disappears the moment the day is closed.
  const [staleSession, setStaleSession] = useState<CashSessionStatus | null>(null);
  // A slip scanned back into the till: the sale it names, opened for a
  // reprint or a return.
  const [docSale, setDocSale] = useState<SaleRow | null>(null);
  const [adminTab, setAdminTab] = useState<"cashup" | undefined>(undefined);

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
        const st = await cashSessionStatus();
        setStaleSession(st && st.hours_open >= STALE_SESSION_HOURS ? st : null);
      } catch {
        // No answer is no notice; the cash-up screen still says what it says.
      }
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

  // The two ceilings, worked out here so both discount dialogs and the approval
  // decision all read the same figures. The server enforces them again — see
  // supabase/migrations/0037_discount_limits.sql — this is so the counter finds
  // out while typing rather than at the tender screen.
  const caps = useMemo(
    () =>
      lines.map((l) => ({
        qty: l.qty,
        price: priceOf(l.product),
        discount: l.discount,
        cap: cartLineCap(l, priceOf(l.product)),
      })),
    [lines, priceOf]
  );
  const saleCeiling = useMemo(() => saleDiscountCeiling(caps), [caps]);
  const anyCapped = caps.some((c) => c.cap != null);
  // Whether the limits are this person's business at all. Somebody who approves
  // their own discounts is not bound by one, so the dialogs never raise it.
  const limited = !can(user, "approve_discount");

  /**
   * Whether a discount has to wait for a manager's PIN.
   *
   * Mirrors pos_create_sale: the percent half of a limit is a RATE and holds on
   * every line, the rand half is a ceiling on the sale, and either one exceeded
   * fetches a manager. Passing the ceiling that applied to the box the cashier
   * was typing in keeps the two answers the same — the dialog cannot say "fine"
   * and the tender screen then ask for a PIN.
   */
  const overCeiling = useCallback(
    (amount: number, ceiling: number | null | undefined) => {
      if (!limited) return false;
      return ceiling == null || amount > ceiling + 0.005;
    },
    [limited]
  );

  /** How big a blanket discount goes through without fetching anybody. */
  const saleFreeUpTo = useMemo(
    () => staffSaleCeiling(user, caps, itemsDiscount),
    [user, caps, itemsDiscount]
  );
  /** The same for the line whose discount box is open, if one is. */
  const lineFreeUpTo = useMemo(() => {
    const l = lines.find((x) => x.product.id === discountLine);
    if (!l) return null;
    // The rand half of a limit is a ceiling on the whole sale, so what is
    // already coming off elsewhere eats into what is left for this line.
    const elsewhere = lines
      .filter((x) => x.product.id !== discountLine)
      .reduce((sum, x) => sum + (x.discount ?? 0), 0);
    return staffLineCeiling(user, priceOf(l.product) * l.qty, elsewhere + discount);
  }, [lines, discountLine, user, priceOf, discount]);

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

  /**
   * Keep the device's copy of the open sale in step.
   *
   * Written on every change rather than on a timer: the events this protects
   * against — a refresh, a tab dying, the PWA swapping itself out — give no
   * warning and no chance to flush. localStorage is synchronous and the object
   * is a handful of lines, so the cost is nothing next to losing the basket.
   */
  useEffect(() => {
    if (!restored.current) return;
    cacheSet(
      LIVE_KEY,
      lines.length
        ? { id: "live", at: new Date().toISOString(), lines, customer, discount, discountReason }
        : null
    );
  }, [lines, customer, discount, discountReason]);

  function clearSale() {
    setPayOpen(false);
    setLines([]);
    setCustomer(null);
    setDiscount(0);
    setDiscountReason(null);
    setApproverPin(null);
    setApprovalCode(null);
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
  /**
   * The barcode on a slip is its number. An invoice opens for a reprint or a
   * return; a quote comes back onto the till; a credit note points at the
   * invoice it was written against, which is the thing to scan.
   */
  async function openDocument(docNumber: string) {
    try {
      if (docNumber.startsWith("INV-")) {
        const sale = await saleByNumber(docNumber);
        if (!sale) {
          setBanner(`No sale ${docNumber} is on record.`);
          return;
        }
        setDocSale(sale);
      } else if (docNumber.startsWith("QUO-")) {
        const q = await quoteByNumber(docNumber);
        if (!q) {
          setBanner(`No quote ${docNumber} is on record.`);
          return;
        }
        if (q.status !== "open") {
          setBanner(`Quote ${docNumber} is already ${q.status}.`);
          return;
        }
        recallQuote(q, await quoteItems(q.id));
        setBanner(`Quote ${docNumber} is back on the till.`);
      } else {
        setBanner("A credit note is found through its invoice — scan the invoice number instead.");
      }
    } catch (e) {
      setBanner(errorMessage(e, "Could not open that slip"));
    }
  }

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
  /**
   * Save the basket as a quote, for somebody.
   *
   * An account customer's quote is theirs by the account. Anybody else is
   * asked for a name first — a quote for "Walk-in" cannot be found on Thursday
   * when the builder phones about "my quote", and the paper does not say whose
   * it was. The name is optional, since a customer at the counter may decline
   * to give one, but it is asked for every time.
   */
  function startQuote() {
    if (!user || lines.length === 0) return;
    if (customer) {
      void quoteThis(customer.name);
      return;
    }
    setQuoteName("");
  }

  async function quoteThis(forName: string | null) {
    if (!user || lines.length === 0) return;
    const customerName = forName?.trim() || null;
    setQuoteName(null);
    if (!online) {
      printReceipt(
        buildQuoteText(cartQuoteLines(lines, trade), {
          subtotal,
          // Everything off, not just the blanket discount — the same figure the
          // invoice prints, so subtotal less discount equals total on both.
          discount: allDiscount,
          total,
          trade,
          customerName,
        }),
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
        customer?.id ?? null,
        14,
        null,
        customer ? null : customerName
      );
      printReceipt(
        buildQuoteText(cartQuoteLines(lines, trade), {
          subtotal,
          discount: allDiscount,
          total,
          trade,
          docNumber: q.doc_number,
          validUntil: q.valid_until,
          customerName,
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
        discount_reason: l.discountReason ?? null,
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
        approvalCode,
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
      // A sale the server parked is NOT completed, and saying so was how a
      // cashier came to hand over a slip that was not an invoice and walk away
      // believing the sale had gone through. A missing document number is the
      // tell: queued sales have not got one yet either, so the two are told
      // apart by which of them the server actually accepted.
      setBanner(
        queued
          ? "Saved on this device — it will sync when the connection returns."
          : sale.status === "pending_approval"
            ? "Waiting for a manager — no invoice yet. Release it in Manage → Sales."
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
      canManage={canAny(user, ["manage_catalogue", "manage_inventory", "shelf_capture"])}
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
      onCalculator={() => setShowCalc((v) => !v)}
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
        {/* The calculator follows the header, so a quick sum works from
            Accounts or a quote as well as from the counter. */}
        {showCalc && <Calculator onClose={() => setShowCalc(false)} />}
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

      {/* Not dismissable: a drawer open since yesterday swallows today's sales
          into yesterday's window, and the only cure is closing it. Managers
          get the door; everyone else is told whom to fetch. */}
      {staleSession && (
        <div className="sell-banner is-warning" role="alert">
          <span>
            The cash-up on this till has been open since{" "}
            {fmtWeekdayTime(staleSession.opened_at)}{" "}
            ({staleSession.opened_by_name}). Close it before today's sales pile onto yesterday's.
            {!can(user, "cash_management") && " Ask a manager to cash up."}
          </span>
          {can(user, "cash_management") && (
            <button
              type="button"
              className="cash-up-now"
              onClick={() => {
                setAdminTab("cashup");
                setAskAdminPin(true);
              }}
            >
              Cash up
            </button>
          )}
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
            onDocument={(d) => void openDocument(d)}
            inputRef={scanRef}
          />

          <LineItems
            lines={lines}
            trade={trade}
            freshId={freshId}
            onSetQty={setQty}
            onRemove={removeLine}
            // Gated the same as the Discount button below it. Both take money
            // off; letting one through on a permission the other refuses was
            // an oversight, not a policy.
            onDiscountLine={
              can(user, "apply_discount") ? (id) => setDiscountLine(id) : undefined
            }
            onInspect={(p) => setInspecting({ product: p, mode: "edit" })}
          />

          <div className="sell-actions">
            <button
              className="btn-line"
              disabled={lines.length === 0 || busy}
              onClick={startQuote}
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
          // The same popup a scanned slip opens: reprint, or a return.
          onOpenSale={(d) => {
            setShowCustomers(false);
            void openDocument(d);
          }}
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

      {quoteName !== null && (
        <div className="modal-backdrop" onClick={() => setQuoteName(null)}>
          <form
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Who is this quote for?"
            onSubmit={(e) => {
              e.preventDefault();
              void quoteThis(quoteName);
            }}
          >
            <h2 className="modal-title">Who is this quote for?</h2>
            <p className="acc-note">
              A name or a company, so the quote can be found again and says whose
              it is. Pick a customer on the till instead to put it on an account.
            </p>
            <input
              className="modal-input"
              value={quoteName}
              onChange={(e) => setQuoteName(e.target.value)}
              placeholder="Name or company"
              aria-label="Quote for"
              autoFocus
              maxLength={120}
            />
            <div className="modal-actions">
              <button type="button" className="btn-line" onClick={() => setQuoteName(null)}>
                Cancel
              </button>
              <button type="button" className="btn-line" onClick={() => void quoteThis(null)}>
                No name
              </button>
              <button type="submit" className="btn-fill" disabled={busy}>
                Save quote
              </button>
            </div>
          </form>
        </div>
      )}

      {showDiscount && (
        <DiscountModal
          subtotal={netSubtotal}
          // Only mentioned when something in the basket is actually capped;
          // otherwise the ceiling is just the subtotal and saying so is noise.
          ceiling={anyCapped ? saleCeiling : null}
          approvalFreeUpTo={limited ? saleFreeUpTo : undefined}
          onCancel={() => setShowDiscount(false)}
          onApply={({ amount, reason }) => {
            const wasAmount = discount;
            const wasReason = discountReason;
            setDiscount(amount);
            setDiscountReason(reason);
            setShowDiscount(false);
            // Managers approve their own; so does anybody inside their standing
            // limit. Everyone else needs a PIN now, so the sale completes at the
            // counter instead of parking for later.
            if (overCeiling(amount, saleFreeUpTo)) {
              undoDiscount.current = () => {
                setDiscount(wasAmount);
                setDiscountReason(wasReason);
              };
              setNeedsApproval(true);
            }
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
          // The line's own cap. If a blanket discount is already on the sale it
          // takes a share of this line too, and the two together can still land
          // over — the server catches that and names the product. Giving the
          // line discount first, which is the order a counter works in, is
          // covered exactly.
          ceiling={(() => {
            const l = lines.find((x) => x.product.id === discountLine);
            return l ? cartLineCap(l, priceOf(l.product)) : null;
          })()}
          approvalFreeUpTo={limited ? lineFreeUpTo : undefined}
          onCancel={() => setDiscountLine(null)}
          onApply={({ amount, percent, note }) => {
            // A line has a column for each of these, so each goes to its own:
            // the percentage so the slip can name it — the server works the
            // amount out again from it, which is what stops the two disagreeing
            // — and the words so somebody reading the sale back in a month can
            // see what was agreed and not just that something was.
            const id = discountLine;
            const was = lines.find((l) => l.product.id === id);
            setLines((prev) =>
              prev.map((l) =>
                l.product.id === id
                  ? {
                      ...l,
                      discount: amount,
                      discountPercent: percent,
                      discountReason: note,
                    }
                  : l
              )
            );
            setDiscountLine(null);
            if (overCeiling(amount, lineFreeUpTo)) {
              undoDiscount.current = () =>
                setLines((prev) =>
                  prev.map((l) =>
                    l.product.id === id
                      ? {
                          ...l,
                          discount: was?.discount,
                          discountPercent: was?.discountPercent,
                          discountReason: was?.discountReason,
                        }
                      : l
                  )
                );
              setNeedsApproval(true);
            }
          }}
        />
      )}

      {needsApproval && (
        <ManagerPinModal
          title="Manager approval"
          // The whole discount on the sale, not just the blanket one — a line
          // discount used to make this read "Discount of R0.00".
          subtitle={`${money(allDiscount)} off — a manager's PIN, or a code they gave you`}
          onApprove={async (entered) => {
            // Two things can be typed here, and the difference matters. A PIN
            // belongs to somebody standing at the till and is checked against
            // the device credential cache, so approval survives an outage. A
            // code is a manager's single-use stand-in, read over the phone from
            // wherever they are — it lives on the server and cannot be checked
            // here, so it is verified online when it can be and carried with
            // the sale either way.
            const approver = await findByPinOffline(entered).catch(() => null);
            if (approver && can(approver, "approve_discount")) {
              setApproverPin(entered);
              setApprovalCode(null);
              undoDiscount.current = null;
              setNeedsApproval(false);
              return;
            }

            if (online) {
              const check = await checkApprovalCode(entered);
              if (!check.ok) {
                throw new Error(
                  "Not a PIN that can approve, and not a code we recognise. " +
                    "A code may have expired or already been used."
                );
              }
              if (check.max_amount != null && allDiscount > check.max_amount + 0.005) {
                throw new Error(
                  `That code releases up to ${money(check.max_amount)}, and this is ${money(allDiscount)}.`
                );
              }
            } else if (!approver) {
              // Offline, the code cannot be checked. Taking it on trust is the
              // right call — the shop sells through outages and the server
              // still has the last word at sync — but say so, rather than
              // implying it has been verified.
              setBanner("Code taken on trust — the line is down. It will be checked when it syncs.");
            }
            setApprovalCode(entered);
            setApproverPin(null);
            undoDiscount.current = null;
            setNeedsApproval(false);
          }}
          onCancel={() => {
            // Backing out drops the discount rather than leaving one applied
            // that nobody authorised — the one that raised the prompt, whether
            // it came off the sale or off a line.
            undoDiscount.current?.();
            undoDiscount.current = null;
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
            // Proved against the server by a first call this signer is
            // actually entitled to make — the catalogue for catalogue
            // rights, a shelf lookup for the shelf grant. Proving with the
            // catalogue alone locked shelf-only staff out of the one screen
            // their permission exists to open. Either call fails loudly on a
            // wrong PIN.
            if (can(user, "manage_catalogue")) await adminListProducts(entered);
            else await shelfLookup(entered, "0");
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
          initialTab={adminTab}
          onClose={() => {
            setAdminPin(null);
            setAdminTab(undefined);
            void refresh();
          }}
        />
      )}

      {docSale && (
        <SaleDetail
          sale={docSale}
          pin={null}
          onClose={() => {
            setDocSale(null);
            scanRef.current?.focus();
          }}
          onChanged={refresh}
        />
      )}

      {showFailed && <FailedSales onClose={() => setShowFailed(false)} />}
      {showCalc && <Calculator onClose={() => setShowCalc(false)} />}
    </div>
  );
}

/** Re-exported so App can offer approval of a parked sale. */
export { approveSale };
export type { Sale };
