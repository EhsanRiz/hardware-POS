import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  approveSale,
  approvalCodes,
  checkApprovalCode,
  closeQuote,
  createDelivery,
  deleteParkedSale,
  deliveryProduct,
  fetchCatalogue,
  fetchCategories,
  listCustomers,
  listParkedSales,
  NotPairedError,
  parkSale,
  unparkSale,
  type ParkedLine,
  type ParkedSaleRow,
  quoteByNumber,
  quoteItems,
  saleByNumber,
  saveQuote,
  type QuoteLine,
  type QuoteSummary,
  refreshDeliveriesCache,
} from "../lib/api";
import SaleDetail from "../components/SaleDetail";
import CancelSale, { type CancellableSale } from "../components/CancelSale";
import type { SaleRow } from "../lib/sales";
import {
  adminListProducts,
  purchasingSuppliers,
  shelfLookup,
  stockMovements,
} from "../lib/adminApi";
import { findByPinOffline, signIn } from "../lib/auth";
import { errorMessage } from "../lib/errors";
import { enqueueAction, listQueue } from "../lib/queue";
import { commitDocNumber, peekDocNumber, topUpAllDocNumbers, topUpDocNumbers } from "../lib/docNumbers";
import { isNetworkError, isOnline, onNetworkChange, useOnline } from "../lib/offline";
import { useAwayLock } from "../lib/awayLock";
import { deviceKind, isPaired, registerName } from "../lib/device";
import {
  cartLineCap,
  saleDiscountCeiling,
  staffLineCeiling,
  staffSaleCeiling,
} from "../lib/discountLimits";
import { money } from "../lib/money";
import { cacheGet, cacheSet } from "../lib/localCache";
import { cashSessionStatus, STALE_SESSION_HOURS, type CashSessionStatus } from "../lib/cashup";
import { can, canAny } from "../lib/permissions";
import { printReceipt } from "../lib/print";
import { buildQuoteText, buildReceiptText, cartQuoteLines, tillRef } from "../lib/receipt";
import { refreshSettings, shopSettings, vatRate } from "../lib/settings";
import { fmtDate } from "../lib/dates";
import ParkedPicker, { localEntry, parkedTotal, type ParkedEntry, type ParkedSale } from "../components/sell/ParkedPicker";
import { quoteSheet } from "../lib/quoteSheet";
import { archiveSheet } from "../lib/sendSheet";
import DeliveryForm, { type DeliveryDetails } from "../components/sell/DeliveryForm";
import Deliveries from "../components/deliveries/Deliveries";
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
import { useCamera } from "../lib/useCamera";
import { hasBackOffice } from "../lib/menu";
import Stock from "../components/stock/Stock";
import Admin, { type TabKey } from "../components/Admin";
import PhoneHome from "../components/PhoneHome";
import PhoneLock from "../components/PhoneLock";
import PhoneLookup from "../components/PhoneLookup";
import Calculator from "../components/Calculator";
import DiscountModal from "../components/DiscountModal";
import FailedSales from "../components/FailedSales";
import TillAI from "../components/TillAI";
import PairRegister from "../components/PairRegister";
import ManagerPinModal from "../components/ManagerPinModal";
import { biometricForget } from "../lib/biometric";
import { BACK_OFFICE, forgetPins, ownerProved, recall, remember } from "../lib/unlock";
import { buildNotices, fetchNotices, type Notice, type NoticeCounts } from "../lib/notices";
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
/** The shop's parked sales, as this till last saw them. */
const SHARED_KEY = "sell.parked.shared";
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
/** What the phone's own screens are called at the top of the page. */
const PHONE_SCREEN_TITLE: Record<string, string> = {
  stock: "Stock",
  quotes: "Quotes",
  deliveries: "Deliveries",
};

export default function POS() {
  const { user, logout, sessionPin, setSessionPin } = useAuth();
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

  const [showParked, setShowParked] = useState(false);
  // The parked slot the open sale came from, if it came from one. Parking it
  // again goes back into that slot at its original time rather than adding
  // a second copy, and voiding it asks rather than losing it.
  const [parkedFrom, setParkedFrom] = useState<{ id: string; at: string } | null>(null);
  const [askVoid, setAskVoid] = useState(false);
  // This device's own parked sales: the line down, or a basket recovered
  // after a refresh. Drained to the shop's list as soon as it can be.
  const [parked, setParked] = useState<ParkedSale[]>(() =>
    cacheGet<ParkedSale[]>(PARKED_KEY, [])
  );
  // The shop's parked sales (0086): parked on any till, picked up on any.
  //
  // Cached like every other list the counter reads, so a till that has just
  // been opened — or reloaded mid-morning — shows the baskets waiting the
  // moment the screen draws, rather than an empty Parked button until the
  // first poll comes back. Taking one up still goes to the server, which is
  // what decides whether it is still there to take (unparkSale).
  const [shared, setShared] = useState<ParkedSaleRow[]>(() =>
    cacheGet<ParkedSaleRow[]>(SHARED_KEY, [])
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
      // A sale resumed from a parked slot goes back into that slot; a sale
      // that was never parked gets one now.
      const fromSlot = live.id !== "live";
      const entry = fromSlot ? live : { ...live, id: crypto.randomUUID(), at: new Date().toISOString() };
      const next = [...prev.filter((x) => x.id !== entry.id), entry].sort((a, b) => a.at.localeCompare(b.at));
      cacheSet(PARKED_KEY, next);
      return next;
    });
    cacheSet(LIVE_KEY, null);
    setBanner("The sale that was open here has been parked. Resume it below.");
  }, []);

  // Which section fills the frame. Sell is home; the others swap the counter
  // for the debtors book or the stock room. Deliberately NOT a route: an
  // in-progress sale must survive a glance at an account or a shelf.
  //
  // Sell is home for whoever may sell. A storeman cannot: take_payments is not
  // theirs, the tender button refuses, and landing them on the counter let
  // them scan a basket together and find out at the end. They start where
  // their work is.
  // Whether this device has a lens. Manage's Shelf tab is the whole back
  // office for some people, and a counter machine without a camera has none.
  const camera = useCamera();
  const [section, setSection] = useState<
    "sell" | "accounts" | "stock" | "quotes" | "deliveries"
  //
  // Deliveries and not the stock room, though a storeman's work is in both:
  // the stock room asks for a PIN of its own on the way in, and a screen that
  // greets somebody with a keypad is not a landing. Stock is one tap away in
  // the header.
  >(() => (can(user, "take_payments") ? "sell" : "deliveries"));

  /** A cart line as it is parked, and back. */
  const toParkedLines = (ls: CartLine[]): ParkedLine[] =>
    ls.map((l) => ({
      product_id: l.product.id, qty: l.qty,
      discount: l.discount ?? null, discount_percent: l.discountPercent ?? null,
      discount_reason: l.discountReason ?? null,
    }));

  /**
   * Keep the shop's list current, and hand it anything this device was
   * holding. Polled while the counter is open: another till's park has to
   * show up here without anybody refreshing, because the customer just
   * walked over. The device's own list is drained first, so a basket parked
   * with the line down, or recovered after a refresh, becomes the shop's the
   * moment it can.
   */
  const refreshShared = useCallback(async () => {
    if (!online || !user) return;
    const local = cacheGet<ParkedSale[]>(PARKED_KEY, []);
    if (local.length) {
      const kept: ParkedSale[] = [];
      for (const p of local) {
        try {
          await parkSale(user.id, {
            id: p.id, lines: toParkedLines(p.lines), customerId: p.customer?.id ?? null,
            discount: p.discount, discountReason: p.discountReason, total: parkedTotal(p), parkedAt: p.at,
          });
        } catch {
          kept.push(p);
        }
      }
      setParked(kept);
      cacheSet(PARKED_KEY, kept);
    }
    try {
      const rows = await listParkedSales();
      setShared(rows);
      cacheSet(SHARED_KEY, rows);
    } catch {
      /* the list stays as it was; the next poll tries again */
    }
  }, [online, user]);

  useEffect(() => {
    if (!online || !user || section !== "sell") return;
    void refreshShared();
    const t = window.setInterval(() => void refreshShared(), 6000);
    const onFocus = () => void refreshShared();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [online, user, section, refreshShared]);

  /** Both lists as rows, oldest first. */
  const parkedEntries = useMemo<ParkedEntry[]>(() => {
    const byId = new Map(products.map((p) => [p.id, p]));
    const rows: ParkedEntry[] = shared.map((r) => ({
      id: r.id, at: r.parked_at, where: r.register_name, who: r.parked_by_name,
      customerName: r.customer_name, total: r.total,
      lineCount: r.lines.length,
      units: r.lines.reduce((n, l) => n + l.qty, 0),
      names: r.lines.map((l) => byId.get(l.product_id)?.name ?? "?").join(", "),
    }));
    for (const p of parked) if (!shared.some((r) => r.id === p.id)) rows.push(localEntry(p));
    return rows.sort((a, b) => a.at.localeCompare(b.at));
  }, [shared, parked, products]);

  // On a tablet the payment column is a sheet raised from the bar; on a wide
  // screen it is always docked and this flag is ignored by the stylesheet.
  const [payOpen, setPayOpen] = useState(false);
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
  /**
   * The delivery this sale is going out on, once the counter has asked.
   *
   * Held here rather than written straight away because the note belongs to a
   * sale, and the sale does not exist until the money is taken. The charge is
   * in the cart from the moment it is agreed, though — that is what makes it
   * banked and taxed rather than a figure on a scrap of paper.
   */
  const [delivery, setDelivery] = useState<DeliveryDetails | null>(null);
  const [askDelivery, setAskDelivery] = useState(false);

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
  // The sale just rung, while "actually, no" is still a live possibility —
  // cleared the moment the next one starts. And the one being cancelled.
  const [lastSale, setLastSale] = useState<CancellableSale | null>(null);
  const [cancelSale, setCancelSale] = useState<CancellableSale | null>(null);
  // A drawer opened on another day. Asked of the server on every refresh so
  // the notice appears at sign-in and disappears the moment the day is closed.
  const [staleSession, setStaleSession] = useState<CashSessionStatus | null>(null);
  // A slip scanned back into the till: the sale it names, opened for a
  // reprint or a return.
  const [docSale, setDocSale] = useState<SaleRow | null>(null);
  const [adminTab, setAdminTab] = useState<TabKey | undefined>(undefined);
  // Where a personal device is standing. The tiles are doorways into the
  // back office, so "home" is where it returns whenever one closes; only
  // Look it up is a screen of its own.
  const [phoneScreen, setPhoneScreen] =
    useState<"home" | "lookup" | "deliveries" | "stock" | "quotes">("home");
  // Read once. It cannot change without the app reloading, and the till
  // re-renders on every keystroke in the scan box — no reason to parse it
  // out of local storage each time.
  const [kind] = useState(deviceKind);
  // A phone that has been put away asks for its owner's PIN again. The
  // till does not: it is watched, shared, and takes money all day.
  const [locked, unlock] = useAwayLock(kind === "personal");

  /**
   * What needs somebody (lib/notices, 0100).
   *
   * Asked for here rather than in the header or the phone's home, because
   * both of those want the same list and the device should ask once. The
   * local half — sales queued or refused — comes from the sync state this
   * screen already holds, which is why it keeps working with the line down
   * while the shop's half honestly disappears rather than going stale.
   */
  const [noticeCounts, setNoticeCounts] = useState<NoticeCounts | null>(null);
  const readNotices = useCallback(() => {
    if (!isOnline()) return;
    fetchNotices(new Date())
      .then(setNoticeCounts)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!online || !user) return;
    readNotices();
    const timer = setInterval(readNotices, 120_000);
    return () => clearInterval(timer);
  }, [online, user, readNotices]);

  const notices = useMemo(
    () => buildNotices(online ? noticeCounts : null, { pending, failed }),
    [online, noticeCounts, pending, failed]
  );

  // A phone belongs to one person, and the PIN they signed in with was proved
  // against the server by the sign-in itself. Asking for the same six digits
  // again at the back office door, ten seconds later, proves nothing. The till
  // is the other case — shared, watched, and nobody's — so it asks at its own
  // door and then holds it for a while like everything else.
  useEffect(() => {
    if (kind !== "personal" || !user || !sessionPin) return;
    ownerProved(user, sessionPin);
  }, [kind, user, sessionPin]);

  // The dividers over the two footers meet (sell.css, --sell-foot): the
  // left footer is made at least as tall as the right one. Never the other
  // way — the right column is the tender keypad, and on a 620-tall window
  // raising its footer put the keys behind a scrollbar. So the lines meet
  // wherever the left's own contents are the shorter, which on a wide screen
  // is always (the bubble sits in the row, not under it), and under 1200
  // wide they can still part on a short window. Only while the columns stand
  // side by side — stacked on a phone, their bottoms are on different lines.
  useEffect(() => {
    if (kind === "personal" || typeof ResizeObserver === "undefined") return;
    const body = document.querySelector<HTMLElement>(".sell-body");
    if (!body) return;
    const measure = () => {
      const a = body.querySelector<HTMLElement>(".sell-actions");
      const b = body.querySelector<HTMLElement>(".pay-foot");
      if (!a || !b) return;
      body.style.setProperty("--sell-foot", "0px");
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const next = Math.abs(ra.bottom - rb.bottom) <= 2 ? `${Math.ceil(rb.height)}px` : "";
      if (next) body.style.setProperty("--sell-foot", next);
      else body.style.removeProperty("--sell-foot");
    };
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    body.querySelectorAll<HTMLElement>(".sell-actions, .pay-foot").forEach((el) => ro.observe(el));
    measure();
    return () => ro.disconnect();
  }, [kind]);

  // The till's own invoice and delivery-note numbers (docNumbers.ts): a
  // block reserved while the line is up, topped up whenever it returns. A
  // phone does not sell, so it holds none.
  useEffect(() => {
    if (kind === "personal") return;
    topUpAllDocNumbers();
    // And the delivery line's product, so Deliver works with the line down;
    // and the deliveries list, so the tab shows the morning's loads without it.
    void deliveryProduct().catch(() => undefined);
    void refreshDeliveriesCache();
    return onNetworkChange((on) => {
      if (on) {
        topUpAllDocNumbers();
        void refreshDeliveriesCache();
      }
    });
  }, [kind]);
  // The one screen a locked phone will still show, and only when the PIN
  // cannot be proved for want of a line.
  const [lockedPeek, setLockedPeek] = useState(false);

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
        ? {
            id: parkedFrom?.id ?? "live",
            at: parkedFrom?.at ?? new Date().toISOString(),
            lines, customer, discount, discountReason,
          }
        : null
    );
  }, [lines, customer, discount, discountReason, parkedFrom]);

  function clearSale() {
    setPayOpen(false);
    setAskVoid(false);
    setParkedFrom(null);
    setLines([]);
    setCustomer(null);
    setDiscount(0);
    setDiscountReason(null);
    setApproverPin(null);
    setApprovalCode(null);
    setFreshId(null);
    setFromQuote(null);
    setDelivery(null);
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
      } else if (docNumber.startsWith("TR-")) {
        // An offline slip's reference. If the sale is still on this till,
        // say so: there is no invoice to open yet, and the line is why.
        const queued = listQueue().find((q) => tillRef(q.clientUuid) === docNumber);
        if (queued) {
          setBanner(`That sale is still on this till, waiting for the line. Its invoice number follows when it syncs.`);
          return;
        }
        const sale = await saleByNumber(docNumber);
        if (!sale) {
          setBanner(`No sale with till reference ${docNumber} is on record.`);
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
      // Keep the document as it goes out, before the shop's address or terms
      // can move under it. Deliberately not awaited and never allowed to fail
      // loudly: the quote is saved either way, and the Quotes screen rebuilds
      // one from its figures if this never lands.
      void archiveSheet(
        q.quote_id,
        quoteSheet({
          number: q.doc_number,
          date: fmtDate(new Date().toISOString()),
          validUntil: fmtDate(q.valid_until),
          customerName: customer?.name ?? customerName ?? null,
          servedBy: user.name,
          // Through cartQuoteLines, so the document quotes the same price the
          // till slip does — that is the one place that decides whether a
          // line is at trade or retail.
          lines: cartQuoteLines(lines, trade).map((l, i) => ({
            code: lines[i].product.sku,
            description: l.name,
            qty: l.qty,
            unit: l.unit_code,
            unitPrice: l.unit,
            discount: l.off || undefined,
            lineTotal: Math.round((l.qty * l.unit - (l.off ?? 0)) * 100) / 100,
          })),
          discount: allDiscount,
          total: q.total,
          rate: vatRate(),
        }),
        shopSettings()
      );
      setBanner(`${q.doc_number} saved — bring it back by number.`);
      clearSale();
    } catch (e) {
      setBanner(errorMessage(e, "The quote could not be saved"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Take the address, and put the carrying charge in the cart.
   *
   * The charge is a line like any other from here on: it is in the total, VAT
   * is worked on it, it prints on the receipt and it lands in the day's
   * takings. The product it hangs off is the shop's own delivery line, which
   * the server makes the first time anybody delivers anything.
   */
  async function agreeDelivery(d: DeliveryDetails) {
    setAskDelivery(false);
    try {
      const previous = delivery;
      setDelivery(d);
      // Off with the old charge before the new one goes on, so changing your
      // mind about the price does not put two delivery lines on the invoice.
      let next = lines.filter((l) => l.product.kind !== "delivery");
      {
        // The line goes on even when the delivery is FREE. A free trip still
        // costs the shop fuel and an hour, and the cost is only recorded
        // against a line — so a delivery given away used to be invisible in
        // the one report that asks what delivering is worth. It also puts
        // "Delivery R0.00" on the customer's invoice, which is a fair thing
        // for them to see.
        const p = await deliveryProduct();
        next = [
          ...next,
          {
            product: {
              id: p.id, sku: p.sku, barcode: null, name: p.name,
              description: null, category_id: null, category_name: null,
              unit_code: p.unit_code, unit_name: p.unit_code,
              allows_fraction: false,
              // The price IS the charge: every figure the till works out
              // downstream reads it from here.
              price_retail: d.charge, price_trade: d.charge,
              tax_code: "standard", stock_qty: null, reorder_level: null,
              image_url: null, sort_order: 0, kind: "delivery",
            },
            qty: 1,
          },
        ];
      }
      setLines(next);
      if (!previous) setBanner(`Going to ${d.customerName} — the note prints with the sale.`);
    } catch (e) {
      setDelivery(null);
      setBanner(errorMessage(e, "The delivery charge could not be added"));
    }
  }

  /**
   * Set the sale aside so the next customer can be served — on the shop's
   * list, so any till can pick it up. With the line down it is kept on this
   * device and handed over when the line returns.
   */
  async function park() {
    if (lines.length === 0) return;
    // Back into its own slot, at the time it was first parked: a customer
    // who stepped away at 09:19 is still the 09:19 customer.
    const entry: ParkedSale = {
      id: parkedFrom?.id ?? crypto.randomUUID(),
      at: parkedFrom?.at ?? new Date().toISOString(),
      lines,
      customer,
      discount,
      discountReason,
    };
    // The counter is cleared at once, before the server answers: the next
    // customer's first scan must not land in a basket that is about to be
    // wiped. If the park does not reach the shop, the device keeps it.
    clearSale();
    if (online && user) {
      try {
        await parkSale(user.id, {
          id: entry.id, lines: toParkedLines(entry.lines), customerId: entry.customer?.id ?? null,
          discount: entry.discount, discountReason: entry.discountReason,
          total: parkedTotal(entry), parkedAt: entry.at,
        });
        setBanner("Sale parked. Any till can pick it up from the button below.");
        void refreshShared();
        return;
      } catch {
        /* the line, most likely: kept here and handed over when it returns */
      }
    }
    setParked((prev) => {
      const next = [...prev.filter((x) => x.id !== entry.id), entry]
        .sort((a, b) => a.at.localeCompare(b.at));
      cacheSet(PARKED_KEY, next);
      return next;
    });
    setBanner("Sale parked on this till. It goes to every till when the line returns.");
  }

  /** A parked sale nobody is coming back for. */
  async function deleteParked(id: string) {
    if (shared.some((r) => r.id === id)) {
      try {
        await deleteParkedSale(id);
      } catch (e) {
        setBanner(errorMessage(e, "That parked sale could not be deleted"));
      }
      const rest = shared.filter((r) => r.id !== id);
      setShared(rest);
      cacheSet(SHARED_KEY, rest);
      if (rest.length + parked.length < 2) setShowParked(false);
      void refreshShared();
      return;
    }
    const rest = parked.filter((x) => x.id !== id);
    setParked(rest);
    cacheSet(PARKED_KEY, rest);
    if (rest.length + shared.length < 2) setShowParked(false);
  }

  /**
   * Void: gone at once for a sale that was never parked, as before. A sale
   * that came off the parked list is asked about, because the customer who
   * parked it may be on their way back.
   */
  function voidSale() {
    if (lines.length === 0) return;
    if (parkedFrom) setAskVoid(true);
    else clearSale();
  }

  /** Bring one parked sale back to the counter, from whichever list holds it. */
  async function resume(id: string) {
    // Parking the current sale first would be surprising; refusing to lose it
    // is not. The cashier parks or clears deliberately.
    if (lines.length > 0) {
      setBanner("Finish or park this sale before resuming another.");
      return;
    }
    const local = parked.find((x) => x.id === id);
    if (local) {
      const rest = parked.filter((x) => x.id !== id);
      setParked(rest);
      cacheSet(PARKED_KEY, rest);
      setShowParked(false);
      setParkedFrom({ id: local.id, at: local.at });
      setLines(local.lines);
      setCustomer(local.customer);
      setDiscount(local.discount);
      setDiscountReason(local.discountReason);
      scanRef.current?.focus();
      return;
    }
    // The shop's: taken off the list as it is taken, so two tills cannot
    // both have it. If another till got there first, the list says so.
    let row: ParkedSaleRow;
    try {
      row = await unparkSale(id);
    } catch (e) {
      setBanner(errorMessage(e, "That parked sale could not be picked up"));
      void refreshShared();
      return;
    }
    const byId = new Map(products.map((p) => [p.id, p]));
    const cart: CartLine[] = [];
    let missing = 0;
    for (const l of row.lines) {
      const product = byId.get(l.product_id);
      if (!product) { missing++; continue; }
      cart.push({
        product, qty: l.qty,
        discount: l.discount ?? undefined, discountPercent: l.discount_percent ?? null,
        discountReason: l.discount_reason ?? null,
      });
    }
    // Computed out here, not inside the updater: a state updater must be pure,
    // and this is the same shape as deleteParked above.
    const rest = shared.filter((r) => r.id !== id);
    setShared(rest);
    cacheSet(SHARED_KEY, rest);
    setShowParked(false);
    setParkedFrom({ id: row.id, at: row.parked_at });
    setLines(cart);
    setCustomer(customers.find((c) => c.id === row.customer_id) ?? null);
    setDiscount(row.discount);
    setDiscountReason(row.discount_reason);
    if (missing) {
      setBanner(`${missing} line${missing === 1 ? "" : "s"} not in this till's catalogue were left off.`);
    }
    scanRef.current?.focus();
  }
  /** One parked sale comes straight back; two or more are chosen from. */
  function resumeParked() {
    if (parkedEntries.length === 0) return;
    if (parkedEntries.length === 1) return void resume(parkedEntries[0].id);
    if (lines.length > 0) {
      setBanner("Finish or park this sale before resuming another.");
      return;
    }
    setShowParked(true);
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

      // Only a sale the server accepted can be cancelled: a queued one has
      // nothing on the server to void yet, and a parked one is not a sale.
      const done: CancellableSale | null =
        !queued && sale.id && sale.status === "completed"
          ? {
              id: sale.id,
              doc_number: sale.doc_number,
              total: sale.total,
              payment_method: sale.payment_method,
            }
          : null;
      printReceipt(
        // The tenders go on the slip: a customer disputing a card charge needs
        // to see which card, for how much, against which invoice.
        buildReceiptText(sale, receiptItems(), customer, p.payments),
        "Tax Invoice",
        done ? { label: "Cancel this sale", run: () => setCancelSale(done) } : undefined
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

      // The note, now that there is a sale for it to belong to. A queued sale
      // has no id on the server yet, so there is nothing to hang a note on —
      // said out loud rather than swallowed, because somebody is waiting to
      // load a bakkie.
      let deliveryNote = "";
      if (delivery) {
        // Numbered by the till from its reserved block, like the invoice, so
        // the driver has a note number with the line down.
        const docNumber = peekDocNumber("delivery");
        const details = {
          cashierId: user.id,
          customerName: delivery.customerName,
          address: delivery.address,
          deliverOn: delivery.deliverOn,
          deliverAt: delivery.deliverAt || null,
          charge: delivery.charge,
          note: delivery.note || null,
          docNumber,
        };
        // Kept on this device and filed when the line is back — after the
        // sale, if the sale is itself still on its way. The Deliveries tab
        // lists it meanwhile, so the load is not a surprise to anybody.
        const queueIt = (saleClientRef: string | null, saleId: string | null) => {
          enqueueAction({
            id: `cd-${saleClientRef ?? saleId}`, kind: "create_delivery",
            saleClientRef, saleId, saleNumber: sale.doc_number, ...details,
            at: new Date().toISOString(),
          });
          commitDocNumber("delivery", docNumber);
          deliveryNote = docNumber
            ? ` Delivery note ${docNumber} for ${delivery.customerName} follows when the connection returns.`
            : ` The delivery note for ${delivery.customerName} follows when the connection returns.`;
        };
        if (queued || !sale.id) {
          queueIt(sale.id, null);
        } else {
          try {
            const note = await createDelivery({ ...details, saleId: sale.id });
            if (note.doc_number === docNumber) commitDocNumber("delivery", docNumber);
            void topUpDocNumbers("delivery");
            deliveryNote = ` Delivery note ${note.doc_number} for ${delivery.customerName}.`;
          } catch (e) {
            if (isNetworkError(e)) {
              queueIt(null, sale.id);
            } else {
              // Said out loud on the same line as the sale: somebody is
              // waiting to load a bakkie, and a note that silently did not
              // happen is a delivery nobody knows about.
              deliveryNote = ` ${errorMessage(e, "The delivery note did not save")}`;
            }
          }
        }
      }

      clearSale();
      setLastSale(done);
      // A sale the server parked is NOT completed, and saying so was how a
      // cashier came to hand over a slip that was not an invoice and walk away
      // believing the sale had gone through. A missing document number is the
      // tell: queued sales have not got one yet either, so the two are told
      // apart by which of them the server actually accepted.
      setBanner(
        (queued
          ? "Saved on this device — it will sync when the connection returns."
          : sale.status === "pending_approval"
            ? "Waiting for a manager — no invoice yet. Release it in Manage → Sales."
            : `${sale.doc_number ?? "Sale"} completed.`) + deliveryNote
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

  /**
   * The back office and the stock room, opened.
   *
   * Each asks for a PIN only if nothing proved recently is still good (see
   * lib/unlock): the door is about a device left lying about, which is a
   * question of time, and every call behind it re-checks the PIN server-side
   * anyway. Switching between screens is not a reason to ask again.
   */
  function openAdmin() {
    const kept = recall("admin");
    if (kept) setAdminPin(kept);
    else setAskAdminPin(true);
  }

  function openStock(where: "phone" | "till") {
    const kept = recall("stock");
    if (!kept) {
      setAskStockPin(true);
      return;
    }
    setStockPin(kept);
    if (where === "phone") setPhoneScreen("stock");
    else setSection("stock");
  }

  /**
   * A notice tapped goes to where the thing is fixed.
   *
   * The destinations are menu keys, so this is the same routing the menu
   * itself goes through rather than a second way of moving about — and the
   * two that are not back-office sections (the sync list, and the stock room
   * behind its own PIN) are handled here for the same reason.
   */
  function goNotice(goes: Notice["goes"]) {
    if (goes === "failed") {
      setShowFailed(true);
      return;
    }
    if (goes === "deliveries") {
      if (kind === "personal") setPhoneScreen("deliveries");
      else setSection("deliveries");
      return;
    }
    if (goes === "stock") {
      openStock(kind === "personal" ? "phone" : "till");
      return;
    }
    setAdminTab(goes as TabKey);
    openAdmin();
  }

  /** Somebody leaving takes every proved PIN with them. */
  function signOut() {
    forgetPins();
    // And their face. The next person to hold this handset is not them, and an
    // enrolment left behind would offer to unlock somebody else's session.
    if (user) biometricForget(user.id);
    logout();
  }

  if (!paired) return <PairRegister onPaired={() => setPaired(true)} />;

  const header = (
    <SellHeader
      user={user}
      online={online}
      pending={pending}
      failed={failed}
      // From the SAME list the back office draws its tabs from (lib/menu).
      // These were two lists and they disagreed: this one asked for
      // manage_inventory, which opens nothing in Manage — the Stock room is a
      // screen on this till. A storeman on a counter machine with no camera
      // was shown a door into an empty room, and the room then defaulted to
      // the catalogue.
      canManage={!!user && hasBackOffice(user, { camera, phone: kind === "personal" })}
      section={section}
      canSell={can(user, "take_payments")}
      canAccounts={can(user, "take_payments")}
      canQuotes={can(user, "take_payments")}
      canStock={can(user, "manage_inventory")}
      onSection={(s) => {
        if (s === "stock") {
          openStock("till");
          return;
        }
        setSection(s);
      }}
      onShowFailed={() => setShowFailed(true)}
      notices={notices}
      onNotice={goNotice}
      onReadNotices={readNotices}
      onManage={() => openAdmin()}
      onSignOut={signOut}
      onCalculator={() => setShowCalc((v) => !v)}
    />
  );

  /**
   * Everything the header can open.
   *
   * It lives beside `header` for the same reason: the screen below changes,
   * the frame does not. Kept in the main return alone, every one of these was
   * unreachable from Accounts, Quotes, Deliveries and Stock — those screens
   * return early, above the point where the modals were written, so pressing
   * Manage set the state and rendered nothing. The button looked broken
   * because it was.
   */
  const overlays = (
    <>
      {askStockPin && (
        <ManagerPinModal
          title="Stock"
          subtitle="Enter your PIN to open the stock room"
          onApprove={async (entered) => {
            // WHOSE PIN, for the same reason as the back office below: this
            // says "enter YOUR PIN" and proved only that the PIN belonged to
            // SOMEBODY with the inventory right. A storeman who knew the
            // manager's PIN opened the stock room with it, and every call
            // inside then ran as him.
            //
            // The four other PIN modals in this app are the opposite case and
            // must stay that way — "a manager's PIN" on a discount, a return,
            // a parked sale, a voided payment. Those exist precisely so that
            // somebody else can approve. The subtitle is the difference.
            //
            // signIn resolves one person against one PIN, and falls back to
            // this device's own credentials when the line is down, so the rule
            // holds either way.
            if (!user) throw new Error("Sign in first.");
            const who = await signIn(user.id, entered);
            if (!who) throw new Error("That is not your PIN.");
            // Then the permission, as before: the cheapest inventory call,
            // which fails loudly on a PIN that is yours but opens nothing.
            await stockMovements(entered, 1);
            setStockPin(entered);
            remember("stock", entered);
            setAskStockPin(false);
            // On a phone the stock room is a screen of its own, not a
            // section of the till.
            if (kind === "personal") setPhoneScreen("stock");
            else setSection("stock");
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
            // The phone widens who reaches this modal: a buyer with no
            // catalogue or shelf right taps Buying and must still be able to
            // prove a PIN. Each branch is a call that signer is entitled to.
            // With the line down, against the credentials this device keeps
            // for signing in (the same hashes, the same check): the door
            // opens, and each screen inside says what it cannot show. The
            // server still checks the PIN on every call once the line is back.
            //
            // WHOSE PIN. This modal says "enter your PIN" and did not check
            // that it was: it proved the PIN by making a call the SIGNED-IN
            // person was entitled to, then held that PIN for every call
            // inside. So a storeman who knew the manager's PIN got the
            // manager's back office on her own session — the screen her, the
            // authority his. Nothing about that was deliberate; the label had
            // said the rule all along.
            //
            // It is checked against this person and no other. A manager who
            // wants the back office at somebody else's till signs in as
            // himself, which is the honest version of what he was doing.
            // Nobody is at this till, so nothing opens.
            if (!user) throw new Error("Sign in first.");
            if (!isOnline()) {
              const who = await findByPinOffline(entered);
              // Three different things, said as three different sentences: a
              // PIN this device has never seen, a PIN that belongs to somebody
              // else, and your own PIN opening nothing. Collapsing them loses
              // the one a person can act on.
              if (!who) {
                throw new Error("That PIN is not known on this device.");
              }
              if (who.id !== user.id) {
                throw new Error("That is not your PIN.");
              }
              if (!canAny(who, [...BACK_OFFICE])) {
                throw new Error("That PIN opens nothing in the back office.");
              }
            } else {
              const who = await signIn(user.id, entered);
              if (!who) throw new Error("That is not your PIN.");
              // Then the same proof as before, so a PIN that is right but
              // opens nothing still fails here rather than inside.
              if (can(user, "manage_catalogue")) await adminListProducts(entered);
              else if (can(user, "shelf_capture")) await shelfLookup(entered, "0");
              else if (can(user, "manage_purchasing")) await purchasingSuppliers(entered);
              else await approvalCodes(entered);
            }
            setAdminPin(entered);
            remember("admin", entered);
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
          // On a phone the menu inside Manage carries the phone's own
          // screens too, so picking one closes Manage and opens it.
          onLeave={(key) => {
            setAdminPin(null);
            setAdminTab(undefined);
            if (key === "stock") openStock("phone");
            else setPhoneScreen(key as "lookup" | "deliveries" | "stock");
          }}
          onClose={() => {
            setAdminPin(null);
            setAdminTab(undefined);
            void refresh();
          }}
        />
      )}

      {showFailed && <FailedSales onClose={() => setShowFailed(false)} />}
      {showCalc && <Calculator onClose={() => setShowCalc(false)} />}
      {/* The bubble in the corner: questions about the shop, answered from its
          own records. Never in the path of a sale. On a phone the sheet it
          opens is the whole screen. */}
      <TillAI variant={kind === "personal" ? "phone" : "bubble"} />
    </>
  );

  /**
   * A personal device does not get the till.
   *
   * The counter is a 17" touch screen and the till belongs to it. A phone is
   * for the work done away from the counter, so it lands on a short list of
   * errands instead — and it must not be able to sell, which is not enforced
   * here but in the database (0074): a personal register is refused a sale, a
   * drawer, a customer payment or a return outright, whatever the client asks.
   * This branch only decides what to show.
   */
  if (kind === "personal" && user) {
    if (locked) {
      // Look it up, with the lock still on: coming back from it returns here,
      // not to the errands.
      if (lockedPeek) {
        return (
          <PhoneLookup
            products={products}
            online={online}
            onBack={() => setLockedPeek(false)}
          />
        );
      }
      return (
        <PhoneLock
          user={user}
          online={online}
          // The PIN this phone was opened with is still in memory when the app
          // was only hidden, never reloaded — so there is a session to resume
          // and a face can stand in for retyping it. A cold start has none,
          // and the keypad is then the only way back, which is right.
          resumable={sessionPin != null}
          onResume={() => {
            // Nothing is re-proved because nothing changed: the same PIN, the
            // same person, the same session the phone was already running.
            // Rolling the doors forward is what typing it would have done.
            if (sessionPin) ownerProved(user, sessionPin);
            unlock();
          }}
          onUnlock={(pin) => {
            setSessionPin(pin);
            // Proved against the server a moment ago, by the same check the
            // back office's own door makes.
            ownerProved(user, pin);
            unlock();
          }}
          onLookup={() => setLockedPeek(true)}
          onSignOut={signOut}
        />
      );
    }
    if (phoneScreen === "lookup") {
      return (
        <>
          <PhoneLookup
            products={products}
            online={online}
            onBack={() => setPhoneScreen("home")}
          />
          {overlays}
        </>
      );
    }
    // Deliveries, the stock room and quotes, whole, on the phone: the till's
    // own screens a manager or owner can work from away from the counter. All
    // already ran on a personal token — every RPC behind them takes the
    // register token and, for stock, the PIN — so nothing on the server
    // changed; what was missing was a way in. Stock keeps the same PIN gate
    // the till has, held in memory for the session.
    //
    // Quotes arrives without its "Open on the till" button: a phone has no
    // Sell screen to open one onto. What it has instead is the reason it is
    // here — the document, and the share sheet.
    if (phoneScreen === "deliveries" || phoneScreen === "quotes"
        || (phoneScreen === "stock" && stockPin)) {
      return (
        <>
          <div className="phone-screen">
            <header className="phone-screen-head">
              <button className="btn-line quiet" onClick={() => setPhoneScreen("home")}>Back</button>
              <h1>{PHONE_SCREEN_TITLE[phoneScreen]}</h1>
            </header>
            <div className="phone-body sell">
              {phoneScreen === "stock" ? <Stock pin={stockPin!} />
                : phoneScreen === "quotes" ? <Quotes user={user} />
                : <Deliveries user={user} />}
            </div>
          </div>
          {overlays}
        </>
      );
    }
    return (
      <>
        <PhoneHome
          user={user}
          online={online}
          deviceName={registerName()}
          notices={notices}
          onNotice={goNotice}
          onReadNotices={readNotices}
          onSignOut={signOut}
          onPick={(key) => {
            if (key === "lookup") {
              setPhoneScreen("lookup");
              return;
            }
            if (key === "deliveries") {
              setPhoneScreen("deliveries");
              return;
            }
            if (key === "quotes") {
              setPhoneScreen("quotes");
              return;
            }
            if (key === "stock") {
              openStock("phone");
              return;
            }

            // Everything else is a section of Manage, opened straight onto
            // its own tab. The menu and Manage share one list (lib/menu), so
            // the key IS the tab. The PIN is asked for the same way it is on
            // the till — held in memory only, re-checked server-side by every
            // call behind it.
            setAdminTab(key as TabKey);
            openAdmin();
          }}
        />
        {overlays}
      </>
    );
  }

  // Accounts and Stock replace the counter, not the frame: the header keeps
  // the sync state and the way back, and a parked sale stays parked underneath.
  if ((section === "accounts" || section === "quotes" || section === "deliveries" ||
       (section === "stock" && stockPin)) && user) {
    return (
      <div className="sell">
        {header}
        {section === "accounts" ? (
          <Accounts user={user} />
        ) : section === "quotes" ? (
          <Quotes user={user} onRecall={recallQuote} />
        ) : section === "deliveries" ? (
          <Deliveries user={user} />
        ) : (
          <Stock pin={stockPin!} />
        )}
        {overlays}
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
        <div
          className="sell-banner"
          onClick={() => {
            setBanner(null);
            setLastSale(null);
          }}
          role="status"
        >
          {banner}
          {/* On a thermal till the slip went straight to paper, so this is
              the only place the cancel can be offered. */}
          {lastSale && (
            <button
              type="button"
              className="cash-up-now"
              onClick={(e) => {
                e.stopPropagation();
                setCancelSale(lastSale);
              }}
            >
              Cancel this sale
            </button>
          )}
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
              disabled={lines.length === 0 || busy}
              onClick={() => setAskDelivery(true)}
              title={delivery ? `Deliver to ${delivery.customerName}` : undefined}
            >
              {/* The destination is shown but BOUNDED. A trading name has no
                  length limit and this button shares its row with five others
                  that must not be pushed off it, so the name truncates here and
                  is carried whole by the banner above the sale and by the
                  button's own title. */}
              {delivery ? (
                <span className="deliver-who">
                  Deliver · {delivery.customerName}
                </span>
              ) : (
                "Deliver"
              )}
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
              onClick={() => void park()}
            >
              Park sale
            </button>

            {parkedEntries.length > 0 && (
              <button className="btn-line" onClick={resumeParked}>
                {/* "Parked · 3", not "Resume parked · 3". It sits beside
                    "Park sale", which is what makes it unambiguous, and the
                    word it loses was 45px — the difference between six buttons
                    on one row of a 1024 counter screen and five plus an orphan.
                    Pressing a thing called "Parked" to get the parked ones back
                    is not a sentence anybody has to be taught. */}
                Parked · {parkedEntries.length}
              </button>
            )}

            <button
              className="btn-line quiet push"
              disabled={lines.length === 0}
              onClick={voidSale}
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
      {showParked && (
        <ParkedPicker
          parked={parkedEntries}
          onPick={(id) => void resume(id)}
          onDelete={(id) => void deleteParked(id)}
          onClose={() => setShowParked(false)}
        />
      )}

      {askVoid && (
        <div className="modal-backdrop" onClick={() => setAskVoid(false)}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="This sale was parked"
          >
            <h2 className="modal-title">This sale was parked</h2>
            <p className="acc-note">
              Put it back for whoever parked it, or delete it for good.
            </p>
            <div className="modal-actions" style={{ marginTop: 14 }}>
              <button className="btn-cancel" onClick={() => setAskVoid(false)}>
                Cancel
              </button>
              <button className="btn-line" onClick={() => void park()}>
                Put it back
              </button>
              <button className="btn-fill" onClick={clearSale}>
                Delete it
              </button>
            </div>
          </div>
        </div>
      )}

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
          onChanged={(c) => {
            // The corrected row replaces the old one everywhere it is held:
            // the list, the cache, and the sale if it is theirs, so the slip
            // carries the right name.
            setCustomers((prev) => {
              const next = [...prev.filter((p) => p.id !== c.id), c].sort((a, b) =>
                a.name.localeCompare(b.name)
              );
              cacheSet(CUSTOMERS_KEY, next);
              return next;
            });
            setCustomer((cur) => (cur && cur.id === c.id ? c : cur));
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

      {askDelivery && (
        <DeliveryForm
          initial={delivery}
          suggestedName={customer?.name ?? null}
          suggestedAddress={customer?.address ?? null}
          onCancel={() => setAskDelivery(false)}
          onConfirm={(d) => void agreeDelivery(d)}
        />
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

      {cancelSale && user && (
        <CancelSale
          sale={cancelSale}
          cashierId={user.id}
          pin={null}
          onClose={() => setCancelSale(null)}
          onDone={async () => {
            const c = cancelSale;
            setCancelSale(null);
            setLastSale(null);
            setBanner(`${c.doc_number ?? "The sale"} cancelled — hand back ${money(c.total)}.`);
            await refresh();
          }}
        />
      )}

      {docSale && (
        <SaleDetail
          sale={docSale}
          cashierId={user?.id ?? null}
          pin={null}
          onClose={() => {
            setDocSale(null);
            scanRef.current?.focus();
          }}
          onChanged={refresh}
        />
      )}

      {overlays}
    </div>
  );
}

/** Re-exported so App can offer approval of a parked sale. */
export { approveSale };
export type { Sale };
