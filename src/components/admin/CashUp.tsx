import { useCallback, useEffect, useState } from "react";
import {
  addMovement,
  closeSession,
  currentSession,
  openSession,
  pastSessions,
  type CashSession,
} from "../../lib/cashup";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/format";
import { printReceipt } from "../../lib/print";
import { queueCount } from "../../lib/queue";
import { buildCashUpText } from "../../lib/receipt";

/**
 * Cashing up.
 *
 * The whole screen exists for one figure: expected against counted. Everything
 * above it is the working that gets there, and the layout says so — the count
 * is the only thing the manager types, and the difference appears the moment
 * they type it, before they commit to it. A cash-up that reveals the variance
 * only after closing invites the count to be adjusted to match.
 *
 * The expected figure is the server's. A till that computed its own would be
 * marking its own homework.
 */
export default function CashUp({ pin }: { pin: string }) {
  const [session, setSession] = useState<CashSession | null>(null);
  const [past, setPast] = useState<CashSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [float, setFloat] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([currentSession(pin), pastSessions(pin)]);
      setSession(s);
      setPast(p);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "Could not load the cash-up"));
    } finally {
      setLoading(false);
    }
  }, [pin]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorMessage(e, "That did not work"));
    } finally {
      setBusy(false);
    }
  }

  // Sales still sitting in the queue are real money in the drawer that the
  // server has never heard of. Closing over them books a shortfall against a
  // cashier who is not short, so this is the one moment worth interrupting.
  const queued = queueCount();

  const countedNum = Number(counted.replace(",", ".")) || 0;
  const expected = session?.figures.expected_cash ?? 0;
  const variance = Math.round((countedNum - expected) * 100) / 100;

  return (
    <div className="flex-1 overflow-auto p-4">
      {error && (
        <p
          onClick={() => setError(null)}
          className="max-w-2xl mb-4 px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg cursor-pointer"
        >
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-stone-500 text-sm">Loading…</p>
      ) : !session ? (
        <div className="max-w-md bg-white rounded-xl border border-stone-200 p-5 space-y-3">
          <h2 className="font-medium">Open the drawer</h2>
          <p className="text-sm text-stone-500">
            Count the float going in. Everything after this is measured against it.
          </p>
          <label className="block">
            <span className="text-sm text-stone-600">Opening float</span>
            <input
              className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2 text-right tabular-nums"
              inputMode="decimal"
              value={float}
              onChange={(e) => setFloat(e.target.value.replace(/[^\d.,]/g, ""))}
              placeholder="0.00"
              aria-label="Opening float"
            />
          </label>
          <button
            className="px-4 py-2 rounded-lg bg-colophon text-paper disabled:opacity-40"
            disabled={busy}
            onClick={() => run(() => openSession(pin, Number(float.replace(",", ".")) || 0))}
          >
            Open the day
          </button>
        </div>
      ) : (
        <div className="max-w-2xl space-y-4">
          <Figures session={session} />

          <Movements pin={pin} busy={busy} onDone={run} />

          <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-4">
            <h2 className="font-medium">Count the drawer</h2>

            {queued > 0 && (
              <p className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg">
                {queued} {queued === 1 ? "sale is" : "sales are"} still waiting to
                sync. That cash is in the drawer but not yet in these figures —
                closing now will report a shortfall that is not real. Get the till
                back online first.
              </p>
            )}

            <label className="block">
              <span className="text-sm text-stone-600">Counted cash</span>
              <input
                className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2 text-right tabular-nums text-lg"
                inputMode="decimal"
                value={counted}
                onChange={(e) => {
                  setCounted(e.target.value.replace(/[^\d.,]/g, ""));
                  setConfirmClose(false);
                }}
                placeholder="0.00"
                aria-label="Counted cash"
              />
            </label>

            {counted.trim() !== "" && (
              <div
                className={`flex justify-between items-baseline px-3 py-2 rounded-lg ${
                  Math.abs(variance) < 0.005
                    ? "bg-emerald-50 text-emerald-800"
                    : "bg-amber-50 text-amber-900"
                }`}
                role="status"
                aria-label="Variance"
              >
                <span className="text-sm">
                  {Math.abs(variance) < 0.005
                    ? "Balanced"
                    : variance > 0
                      ? "Over"
                      : "Short"}
                </span>
                <span className="text-xl tabular-nums">{money(Math.abs(variance))}</span>
              </div>
            )}

            <label className="block">
              <span className="text-sm text-stone-600">Note</span>
              <input
                className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Anything that explains the difference"
                aria-label="Cash-up note"
              />
            </label>

            <div className="flex gap-2 items-center">
              <button
                className="px-4 py-2 rounded-lg bg-colophon text-paper disabled:opacity-40"
                disabled={busy || counted.trim() === ""}
                onClick={() => {
                  // Closing is the end of the day and cannot be undone from
                  // here, so a shortfall gets a second press rather than a
                  // dialog nobody reads.
                  if (!confirmClose && Math.abs(variance) >= 0.005) {
                    setConfirmClose(true);
                    return;
                  }
                  void run(async () => {
                    const closed = await closeSession(pin, countedNum, note.trim() || null);
                    printReceipt(buildCashUpText(closed), "Cash-up");
                    setCounted("");
                    setNote("");
                    setConfirmClose(false);
                  });
                }}
              >
                {confirmClose
                  ? `Close ${variance > 0 ? "over" : "short"} by ${money(Math.abs(variance))}`
                  : "Close & print"}
              </button>
              <button
                className="px-3 py-2 text-sm text-stone-600"
                onClick={() =>
                  printReceipt(buildCashUpText(session), "Cash-up so far")
                }
              >
                Print without closing
              </button>
            </div>
          </div>
        </div>
      )}

      {past.length > 0 && (
        <div className="max-w-2xl mt-6">
          <h2 className="font-medium mb-2">Earlier days</h2>
          <ul className="divide-y divide-stone-200 bg-white rounded-xl border border-stone-200">
            {past.map((s) => (
              <li key={s.id} className="px-4 py-3 flex items-center gap-3">
                <span className="flex-1">
                  <span className="block text-sm">
                    {new Date(s.opened_at).toLocaleDateString("en-ZA", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                  <span className="block text-xs text-stone-500">
                    {s.figures.sales_count} sales · closed by {s.closed_by_name}
                  </span>
                </span>
                <span
                  className={`text-sm tabular-nums ${
                    Math.abs(s.variance ?? 0) < 0.005 ? "text-stone-500" : "text-amber-700"
                  }`}
                >
                  {Math.abs(s.variance ?? 0) < 0.005
                    ? "Balanced"
                    : `${(s.variance ?? 0) > 0 ? "Over" : "Short"} ${money(
                        Math.abs(s.variance ?? 0)
                      )}`}
                </span>
                <button
                  className="text-sm text-stone-600 underline underline-offset-2"
                  onClick={() => printReceipt(buildCashUpText(s), "Cash-up")}
                >
                  Print
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The working: what was sold, and what that means the drawer should hold. */
function Figures({ session }: { session: CashSession }) {
  const f = session.figures;
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="font-medium">Today</h2>
        <span className="text-sm text-stone-500">
          open since{" "}
          {new Date(session.opened_at).toLocaleTimeString("en-ZA", {
            hour: "2-digit",
            minute: "2-digit",
          })}{" "}
          · {session.opened_by_name}
        </span>
      </div>

      <Row label={`Sales (${f.sales_count})`} value={f.sales_total} />
      <Row label="VAT within" value={f.vat_total} muted />
      {f.discount_total > 0 && (
        <Row label="Discounts given" value={f.discount_total} muted />
      )}

      {Object.keys(f.tenders).length > 0 && (
        <div className="mt-3 pt-3 border-t border-stone-100">
          {Object.entries(f.tenders).map(([method, value]) => (
            <Row key={method} label={labelFor(method)} value={value} muted />
          ))}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-stone-100">
        <Row label="Opening float" value={session.opening_float} muted />
        <Row label="Cash sales" value={f.cash_sales} muted />
        {f.account_cash > 0 && (
          <Row label="Account payments in cash" value={f.account_cash} muted />
        )}
        {f.pay_in > 0 && <Row label="Paid in" value={f.pay_in} muted />}
        {f.pay_out > 0 && <Row label="Paid out" value={-f.pay_out} muted />}
        <div className="flex justify-between items-baseline pt-2 mt-1 border-t-2 border-stone-800">
          <span>Expected in drawer</span>
          <span className="text-lg tabular-nums">{money(f.expected_cash)}</span>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={`flex justify-between text-sm py-0.5 ${muted ? "text-stone-600" : ""}`}>
      <span>{label}</span>
      <span className="tabular-nums">{money(value)}</span>
    </div>
  );
}

const TENDER_LABEL: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  eft: "EFT",
  zapper: "Zapper",
  account: "On account",
  mixed: "Mixed",
};

function labelFor(method: string): string {
  return TENDER_LABEL[method] ?? method;
}

/** Float top-ups and payouts, which are the difference between a variance
 *  somebody can explain and one nobody can. */
function Movements({
  pin,
  busy,
  onDone,
}: {
  pin: string;
  busy: boolean;
  onDone: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"pay_in" | "pay_out">("pay_out");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <button
        className="text-sm text-stone-600 underline underline-offset-2"
        onClick={() => setOpen(true)}
      >
        Money in or out of the drawer
      </button>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-3">
      <h2 className="font-medium">Money in or out</h2>
      <div className="flex gap-2">
        {(["pay_out", "pay_in"] as const).map((k) => (
          <button
            key={k}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              kind === k ? "bg-colophon text-paper" : "bg-stone-100 text-stone-600"
            }`}
            onClick={() => setKind(k)}
          >
            {k === "pay_out" ? "Paid out" : "Paid in"}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="text-sm text-stone-600">Amount</span>
        <input
          className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2 text-right tabular-nums"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ""))}
          aria-label="Movement amount"
        />
      </label>
      <label className="block">
        <span className="text-sm text-stone-600">What for</span>
        <input
          className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Diesel for the bakkie, banked, float top-up"
          aria-label="Movement reason"
        />
      </label>
      <div className="flex gap-2">
        <button
          className="px-4 py-2 rounded-lg bg-colophon text-paper disabled:opacity-40"
          disabled={busy || !reason.trim() || !(Number(amount.replace(",", ".")) > 0)}
          onClick={() =>
            void onDone(async () => {
              await addMovement(
                pin,
                kind,
                Number(amount.replace(",", ".")),
                reason.trim()
              );
              setAmount("");
              setReason("");
              setOpen(false);
            })
          }
        >
          Record it
        </button>
        <button className="px-3 py-2 text-stone-600" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
