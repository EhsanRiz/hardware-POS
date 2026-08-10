import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  fetchProducts,
  getOrderItems,
  listAccounts,
  listOpenOrdersFull,
  saveOrder,
} from "../lib/api";
import {
  cacheServerOrders,
  getCachedServerOrders,
} from "../lib/openOrdersCache";
import { signIn } from "../lib/auth";
import { submitPayment, usePendingSync } from "../lib/sync";
import type {
  AccountListItem,
  CartLine,
  OpenOrder,
  OpenOrderItem,
  PaymentMethod,
  Product,
  ProductVariant,
  User,
} from "../lib/types";
import { can, canAny, MANAGEMENT_PERMS } from "../lib/permissions";
import { lineKey, lineName, linePrice } from "../lib/variants";
import { buildBillText, buildReceiptText } from "../lib/receipt";
import { printReceipt } from "../lib/print";
import { money } from "../lib/format";
import { TIP_PERCENTS } from "../lib/config";
import { cacheGet, cacheSet } from "../lib/localCache";
import {
  listLocalOrders,
  localOrdersCount,
  onLocalOrdersChange,
  removeLocalOrder,
  saveLocalOrder,
} from "../lib/localOrders";
import { isNetworkError, isOnline, useOnline } from "../lib/offline";

import ProductGrid from "../components/ProductGrid";
import Cart from "../components/Cart";
import DiscountModal from "../components/DiscountModal";
import PaymentModal from "../components/PaymentModal";
import OpenOrders from "../components/OpenOrders";
import RecentInvoices from "../components/RecentInvoices";
import FailedSales from "../components/FailedSales";
import LabelPrompt from "../components/LabelPrompt";
import ManagerPinModal from "../components/ManagerPinModal";
import Admin from "../components/Admin";
import Profile from "../components/Profile";
import EndOfDay from "../components/EndOfDay";
import AccountsPanel from "../components/AccountsPanel";
import Calculator from "../components/Calculator";
import ShopLogo from "../components/ShopLogo";

const MENU_CACHE_KEY = "menu.products";
const ACCOUNTS_CACHE_KEY = "accounts.list";

export default function POS() {
  const { user, logout, setUser } = useAuth();
  // Seed the grid from the last cached menu so it shows instantly and works
  // offline; a successful fetch then refreshes and re-caches it.
  const [products, setProducts] = useState<Product[]>(() =>
    cacheGet<Product[]>(MENU_CACHE_KEY, [])
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState<{ amount: number; reason: string }>({
    amount: 0,
    reason: "",
  });
  // The open order currently loaded into the cart (if any). `localId` is set
  // when the loaded order is one parked on this device (not yet on the server).
  const [currentOrder, setCurrentOrder] = useState<{
    id: string;
    label: string | null;
    localId?: string;
  } | null>(null);

  const [busy, setBusy] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [showOpenOrders, setShowOpenOrders] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [showFailed, setShowFailed] = useState(false);
  const [savePrompt, setSavePrompt] = useState(false);
  const [serverOpenCount, setServerOpenCount] = useState(
    () => getCachedServerOrders().length
  );
  const [localOpenCount, setLocalOpenCount] = useState(localOrdersCount());
  const openCount = serverOpenCount + localOpenCount;
  const [toast, setToast] = useState<string | null>(null);

  const [adminGate, setAdminGate] = useState(false);
  const [admin, setAdmin] = useState<{ pin: string; actor: User } | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  // End-of-day report for staff who don't have access to the Manage area.
  const [eodGate, setEodGate] = useState(false);
  const [eod, setEod] = useState<{ pin: string } | null>(null);
  // Customer accounts (cached so the picker works offline).
  const [accounts, setAccounts] = useState<AccountListItem[]>(() =>
    cacheGet<AccountListItem[]>(ACCOUNTS_CACHE_KEY, [])
  );
  const [showAccounts, setShowAccounts] = useState(false);
  const [showCalc, setShowCalc] = useState(false);
  const online = useOnline();
  const { pending, failed } = usePendingSync();
  const [query, setQuery] = useState("");

  const reloadProducts = () => {
    fetchProducts()
      .then((p) => {
        setProducts(p);
        cacheSet(MENU_CACHE_KEY, p);
        setLoadError(null);
      })
      .catch((e) => {
        // Offline / fetch failure: keep showing the cached menu rather than
        // wiping the grid. Only surface an error if we have nothing to show.
        if (isNetworkError(e)) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load products");
      });
  };
  useEffect(reloadProducts, []);

  const refreshOpenCount = useCallback(() => {
    if (!user) return;
    listOpenOrdersFull(user.id)
      .then((o) => {
        cacheServerOrders(o); // refresh the offline snapshot
        setServerOpenCount(o.length);
      })
      // Offline: keep showing however many tabs we last cached.
      .catch(() => setServerOpenCount(getCachedServerOrders().length));
  }, [user]);
  useEffect(refreshOpenCount, [refreshOpenCount]);

  // Keep the parked-order count live, and re-check the server count whenever the
  // connection returns (parked orders sync in the background and drop off).
  useEffect(
    () => onLocalOrdersChange(() => setLocalOpenCount(localOrdersCount())),
    []
  );
  useEffect(() => {
    if (online) setTimeout(refreshOpenCount, 2_000);
  }, [online, refreshOpenCount]);

  const refreshAccounts = useCallback(() => {
    if (!user) return;
    listAccounts(user.id)
      .then((a) => {
        setAccounts(a);
        cacheSet(ACCOUNTS_CACHE_KEY, a);
      })
      .catch(() => {}); // offline: keep the cached list
  }, [user]);
  useEffect(refreshAccounts, [refreshAccounts]);

  // Home-screen app shortcuts (long-press the icon) deep-link via ?go=…
  useEffect(() => {
    const go = new URLSearchParams(window.location.search).get("go");
    if (!go) return;
    if (go === "accounts" && can(user, "take_payments")) setShowAccounts(true);
    else if (go === "eod") setEodGate(true);
    window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAdmin = async (pin: string) => {
    const actor = await signIn(pin);
    if (!actor) throw new Error("Incorrect PIN");
    if (!canAny(actor, MANAGEMENT_PERMS)) {
      throw new Error("You don't have management access");
    }
    setAdmin({ pin, actor });
    setAdminGate(false);
  };

  const subtotal = useMemo(
    () => cart.reduce((s, l) => s + linePrice(l) * l.qty, 0),
    [cart]
  );
  const discountAmount = Math.min(discount.amount, subtotal);
  const total = Math.max(0, subtotal - discountAmount);

  // Add a product, or a specific variant of it. Lines are keyed by
  // product + variant so each size is its own line.
  const addToCart = (p: Product, variant?: ProductVariant) =>
    setCart((prev) => {
      const key = lineKey({ product: p, qty: 1, variant });
      const found = prev.find((l) => lineKey(l) === key);
      return found
        ? prev.map((l) => (lineKey(l) === key ? { ...l, qty: l.qty + 1 } : l))
        : [...prev, { product: p, qty: 1, variant }];
    });

  const inc = (key: string) =>
    setCart((prev) =>
      prev.map((l) => (lineKey(l) === key ? { ...l, qty: l.qty + 1 } : l))
    );
  const dec = (key: string) =>
    setCart((prev) =>
      prev
        .map((l) => (lineKey(l) === key ? { ...l, qty: l.qty - 1 } : l))
        .filter((l) => l.qty > 0)
    );

  const resetOrder = () => {
    setCart([]);
    setDiscount({ amount: 0, reason: "" });
    setCurrentOrder(null);
  };

  const flashToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const cartItems = () =>
    cart.map((l) => ({
      name: lineName(l),
      price: linePrice(l),
      qty: l.qty,
    }));

  // Print the pre-payment BILL (pro-forma) from the current cart.
  const printBill = () => {
    printReceipt(
      buildBillText({
        items: cartItems(),
        subtotal,
        discount: discountAmount,
        total,
        label: currentOrder?.label,
        tipPercents: TIP_PERCENTS,
      }),
      "Bill"
    );
  };

  // Save the current cart as a parked order on this device (used offline, or as
  // a fallback when a server save fails mid-flight). Syncs up automatically.
  const parkLocally = (label: string) => {
    if (!user) return;
    const localId = currentOrder?.localId ?? crypto.randomUUID();
    saveLocalOrder({
      localId,
      label: label.trim() || null,
      lines: cart,
      cashierId: user.id,
      cashierName: user.name,
      total: subtotal,
      createdAt: new Date().toISOString(),
    });
    flashToast(currentOrder ? "Order updated (offline)" : "Order saved (offline)");
    resetOrder();
    setSavePrompt(false);
  };

  // Save / update an open order, then clear the screen for the next customer.
  // Falls back to an on-device copy when there's no connection so nothing is
  // lost; it then syncs to the server automatically once back online.
  const saveOpenOrder = async (label: string) => {
    if (!user) return;
    setBusy(true);
    try {
      const isLocal = !!currentOrder?.localId;
      if (isOnline()) {
        try {
          // A parked order has no server id yet, so it's created fresh.
          await saveOrder(user.id, isLocal ? null : currentOrder?.id ?? null, label, cart);
          if (isLocal) removeLocalOrder(currentOrder!.localId!);
          flashToast(currentOrder ? "Order updated" : "Order saved");
          resetOrder();
          setSavePrompt(false);
          refreshOpenCount();
          return;
        } catch (e) {
          if (!isNetworkError(e)) throw e; // real rejection — surface it
          // otherwise fall through and keep it on the device
        }
      }
      parkLocally(label);
    } catch (e) {
      flashToast(e instanceof Error ? e.message : "Could not save order");
    } finally {
      setBusy(false);
    }
  };

  const pay = async (p: {
    tipAmount: number;
    method: PaymentMethod;
    tendered: number | null;
    approverPin: string | null;
    accountId: string | null;
    paidCash: number | null;
    paidCard: number | null;
  }) => {
    if (!user) return;
    setBusy(true);
    setPayError(null);
    const acct = p.accountId
      ? accounts.find((a) => a.id === p.accountId) ?? null
      : null;
    try {
      const grandTotal = total + p.tipAmount;
      const { sale, queued } = await submitPayment({
        cashierId: user.id,
        cashierName: user.name,
        orderId: currentOrder?.id ?? null,
        lines: cart,
        subtotal,
        discountAmount,
        discountReason: discount.reason || null,
        tipAmount: p.tipAmount,
        total: grandTotal,
        paymentMethod: p.method,
        amountTendered: p.tendered,
        label: currentOrder?.label ?? null,
        approverPin: p.approverPin,
        accountId: p.accountId,
        accountName: acct?.name ?? null,
        paidCash: p.paidCash,
        paidCard: p.paidCard,
      });
      const acctInfo =
        p.method === "account" && acct
          ? { name: acct.name, balance: acct.balance + grandTotal }
          : null;
      printReceipt(buildReceiptText(sale, cartItems(), acctInfo), "Tax Invoice");
      setShowPay(false);
      resetOrder();
      refreshOpenCount();
      if (p.method === "account") refreshAccounts();
      const change =
        sale.change_due && sale.change_due > 0
          ? ` · change ${money(sale.change_due)}`
          : "";
      flashToast(
        p.method === "account"
          ? `Charged to ${acct?.name ?? "account"}${queued ? " (offline)" : ""}`
          : queued
          ? `Saved offline — will sync${change}`
          : `Payment complete${change}`
      );
    } catch (e) {
      setPayError(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setBusy(false);
    }
  };

  const reopen = async (order: OpenOrder) => {
    if (!user) return;
    // Orders parked on this device are reopened straight from local storage so
    // it works offline; the stored lines already carry product + price.
    if (order.localId) {
      const lo = listLocalOrders().find((o) => o.localId === order.localId);
      if (!lo) {
        flashToast("Order not found");
        return;
      }
      setCart(lo.lines);
      setDiscount({ amount: 0, reason: "" });
      setCurrentOrder({ id: lo.localId, label: lo.label, localId: lo.localId });
      setShowOpenOrders(false);
      return;
    }
    const toLines = (items: OpenOrderItem[]): CartLine[] =>
      items.map((it) => {
        const prod = products.find((p) => p.id === it.product_id);
        const product: Product = prod ?? {
          id: it.product_id,
          name: it.name,
          price: it.unit_price,
          category: "",
          active: true,
          sort_order: 0,
          image_url: null,
          stock_qty: null,
        };
        // Re-attach the variant so the line prices and labels correctly. Prefer
        // the live menu's variant; fall back to a stub carrying the saved price.
        let variant: ProductVariant | undefined;
        if (it.variant_id) {
          variant =
            product.variants?.find((v) => v.id === it.variant_id) ?? {
              id: it.variant_id,
              name: null,
              size: null,
              price: it.unit_price,
              stock_qty: null,
              active: true,
              sort_order: 0,
            };
        }
        return { product, qty: it.qty, variant };
      });

    try {
      let lines: CartLine[];
      if (isOnline()) {
        lines = toLines(await getOrderItems(user.id, order.id));
      } else {
        // Offline: reopen from the cached snapshot taken while online.
        const cached = getCachedServerOrders().find((o) => o.id === order.id);
        if (!cached) {
          flashToast("Open it once online first so it's saved for offline use");
          return;
        }
        lines = toLines(cached.items);
      }
      setCart(lines);
      setDiscount({ amount: 0, reason: "" });
      setCurrentOrder({ id: order.id, label: order.label });
      setShowOpenOrders(false);
    } catch (e) {
      flashToast(e instanceof Error ? e.message : "Could not open order");
    }
  };

  const needsApproval = discountAmount > 0 && !can(user, "approve_discount");

  return (
    <div className="h-full flex flex-col bg-stone-50">
      <header className="flex items-center gap-3 px-4 h-14 bg-white border-b border-stone-200 shrink-0">
        {/* Left: logo + connection/sync status */}
        <div className="flex items-center gap-3 shrink-0">
          <ShopLogo className="h-9 w-auto" />
          {!online && (
            <span
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold"
              title="No internet — sales are saved on this device and will sync automatically"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              Offline
            </span>
          )}
          {pending > 0 && (
            <span
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-blue-100 text-blue-800 text-xs font-semibold"
              title={`${pending} item(s) (sales / parked orders) waiting to sync`}
            >
              <span className="animate-spin">⟳</span>
              {pending} to sync
            </span>
          )}
          {failed > 0 && (
            <button
              onClick={() => setShowFailed(true)}
              className="flex items-center h-7 px-2.5 rounded-full bg-red-100 text-red-700 text-xs font-semibold active:bg-red-200"
              title={`${failed} sale(s) the server rejected on sync — tap to view`}
            >
              {failed} failed
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowCalc((v) => !v)}
            aria-label="Calculator"
            title="Calculator"
            className={`h-9 w-9 rounded-lg font-medium text-lg flex items-center justify-center ${
              showCalc
                ? "bg-brand text-white"
                : "bg-stone-100 text-stone-700 active:bg-stone-200"
            }`}
          >
            🧮
          </button>
          {can(user, "take_payments") && (
            <button
              onClick={() => setShowOpenOrders(true)}
              className="relative h-9 px-3 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
            >
              Open orders
              {openCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 rounded-full bg-brand text-white text-xs font-bold flex items-center justify-center">
                  {openCount}
                </span>
              )}
            </button>
          )}
          {can(user, "take_payments") && (
            <button
              onClick={() => setShowAccounts(true)}
              className="h-9 px-3 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
            >
              Accounts
            </button>
          )}
          {can(user, "take_payments") && (
            <button
              onClick={() => setShowRecent(true)}
              className="h-9 px-3 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
            >
              Receipts
            </button>
          )}
          {canAny(user, MANAGEMENT_PERMS) ? (
            <button
              onClick={() => setAdminGate(true)}
              className="h-9 px-3 rounded-lg bg-brand-light text-brand-dark font-medium active:bg-brand/20 transition-transform active:scale-95"
            >
              Manage
            </button>
          ) : (
            // Staff without Manage access still get the End-of-Day report.
            <button
              onClick={() => setEodGate(true)}
              className="h-9 px-3 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
            >
              End of Day
            </button>
          )}
        </div>

        {/* Menu search (between the actions and the user) */}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search menu…"
          className="flex-1 min-w-0 h-9 px-3 rounded-lg border border-stone-300 bg-stone-50 text-sm focus:bg-white focus:border-brand outline-none"
        />

        {/* User name + role, with Sign out right beside it, far right */}
        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={() => setShowProfile(true)}
            className="text-sm text-right leading-tight active:opacity-70"
          >
            <div className="font-semibold text-stone-800">{user?.name}</div>
            <div className="text-[11px] text-taupe uppercase">{user?.role}</div>
          </button>
          <button
            onClick={logout}
            className="h-9 px-3 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_360px] min-h-0">
        <main className="p-4 min-h-0 min-w-0 overflow-hidden">
          {loadError ? (
            <p className="text-red-600">{loadError}</p>
          ) : (
            <ProductGrid products={products} onAdd={addToCart} query={query} />
          )}
        </main>
        <aside className="min-h-0">
          <Cart
            lines={cart}
            subtotal={subtotal}
            discount={discountAmount}
            total={total}
            busy={busy}
            canDiscount={can(user, "apply_discount")}
            editingLabel={currentOrder?.label ?? (currentOrder ? "order" : null)}
            onInc={inc}
            onDec={dec}
            onClear={resetOrder}
            onDiscount={() => setShowDiscount(true)}
            onBill={printBill}
            onSave={() => setSavePrompt(true)}
            onPay={() => {
              setPayError(null);
              setShowPay(true);
            }}
          />
        </aside>
      </div>

      {showDiscount && (
        <DiscountModal
          subtotal={subtotal}
          onApply={(amount, reason) => {
            setDiscount({ amount, reason });
            setShowDiscount(false);
          }}
          onCancel={() => setShowDiscount(false)}
        />
      )}

      {showPay && (
        <PaymentModal
          baseTotal={total}
          needsApproval={needsApproval}
          accounts={accounts}
          busy={busy}
          error={payError}
          onCancel={() => setShowPay(false)}
          onConfirm={pay}
        />
      )}

      {savePrompt && (
        <LabelPrompt
          title={currentOrder ? "Update open order" : "Save open order"}
          initial={currentOrder?.label ?? ""}
          busy={busy}
          onConfirm={saveOpenOrder}
          onCancel={() => setSavePrompt(false)}
        />
      )}

      {showOpenOrders && user && (
        <OpenOrders
          cashierId={user.id}
          onReopen={reopen}
          onClose={() => {
            setShowOpenOrders(false);
            refreshOpenCount();
          }}
        />
      )}

      {showRecent && user && (
        <RecentInvoices
          cashierId={user.id}
          onClose={() => setShowRecent(false)}
        />
      )}

      {showFailed && <FailedSales onClose={() => setShowFailed(false)} />}

      {adminGate && (
        <ManagerPinModal
          title="Manage"
          subtitle="Enter your PIN to open the management area."
          onApprove={openAdmin}
          onCancel={() => setAdminGate(false)}
        />
      )}

      {admin && (
        <Admin
          managerPin={admin.pin}
          actor={admin.actor}
          onProductsChanged={reloadProducts}
          onClose={() => setAdmin(null)}
        />
      )}

      {eodGate && (
        <ManagerPinModal
          title="End of Day"
          subtitle="Enter your PIN to view the report."
          onApprove={async (pin) => {
            const u = await signIn(pin);
            if (!u) throw new Error("Incorrect PIN");
            setEod({ pin });
            setEodGate(false);
          }}
          onCancel={() => setEodGate(false)}
        />
      )}

      {showAccounts && user && (
        <AccountsPanel
          cashierId={user.id}
          cashierName={user.name}
          onClose={() => {
            setShowAccounts(false);
            refreshAccounts();
          }}
        />
      )}

      {eod && user && (
        <div className="fixed inset-0 bg-stone-50 z-40 flex flex-col animate-fade-in">
          <header className="h-14 shrink-0 bg-white border-b border-stone-200 flex items-center justify-between px-4">
            <h1 className="text-lg font-bold text-stone-800">End of Day</h1>
            <button
              onClick={() => setEod(null)}
              className="h-9 px-3 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
            >
              ← Back to till
            </button>
          </header>
          <div className="flex-1 overflow-y-auto">
            <EndOfDay managerPin={eod.pin} actor={user} />
          </div>
        </div>
      )}

      {showProfile && user && (
        <Profile
          user={user}
          onClose={() => setShowProfile(false)}
          onUpdated={(u) => {
            setUser({ ...user, ...u });
            flashToast("Profile updated");
          }}
        />
      )}

      {showCalc && <Calculator onClose={() => setShowCalc(false)} />}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-stone-900 text-white px-5 py-3 rounded-full shadow-lg z-50 animate-slide-up">
          {toast}
        </div>
      )}
    </div>
  );
}
