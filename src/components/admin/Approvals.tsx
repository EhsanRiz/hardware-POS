import { useCallback, useEffect, useState } from "react";
import {
  approvalCodes,
  issueApprovalCode,
  type ApprovalCodeRow,
} from "../../lib/api";
import { CURRENCY } from "../../lib/config";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/format";

const MINUTES = [5, 10, 30, 60];

/**
 * A code a manager can read over the phone instead of their PIN.
 *
 * The counter's real problem is never the discount, it is the phone call. A
 * cashier with a customer pressing for money off and a manager at the bank has
 * exactly one way to release the sale, and it is six digits that live in the
 * manager's head — so those six digits get read out, and from that moment they
 * are not the manager's any more. They open the back office, the staff list and
 * the cash-up on every till in the shop.
 *
 * A habit like that is only ever replaced by something equally easy, so this is
 * one screen and two taps: pick how long, say the number. What comes out is
 * single use, expires in minutes, can carry a rand ceiling, and approves one
 * discount and nothing else.
 *
 * The list underneath is not decoration. A code that releases a sale without
 * leaving a trail is a hole with a user interface.
 */
export default function Approvals({ pin }: { pin: string }) {
  const [minutes, setMinutes] = useState(10);
  const [cap, setCap] = useState("");
  const [reason, setReason] = useState("");
  const [issued, setIssued] = useState<{ code: string; expires_at: string } | null>(null);
  const [rows, setRows] = useState<ApprovalCodeRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await approvalCodes(pin));
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "Could not read the code list"));
    }
  }, [pin]);

  useEffect(() => {
    void load();
  }, [load]);

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      const capValue = cap.trim() === "" ? null : Number(cap);
      setIssued(await issueApprovalCode(pin, minutes, capValue, reason.trim() || null));
      setReason("");
      await load();
    } catch (e) {
      setError(errorMessage(e, "Could not issue a code"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="max-w-xl bg-white rounded-xl border border-stone-200 p-5 space-y-4">
        <div>
          <h2 className="font-medium">Approve a discount from anywhere</h2>
          <p className="text-sm text-stone-500">
            Read the code out instead of your PIN. It works once, expires, and
            approves one discount — it cannot sign in or open the back office.
          </p>
        </div>

        {error && (
          <p className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg">{error}</p>
        )}

        <fieldset>
          <legend className="text-sm text-stone-600 mb-1">Good for</legend>
          <div className="flex gap-2">
            {MINUTES.map((m) => (
              <button
                key={m}
                onClick={() => setMinutes(m)}
                aria-pressed={minutes === m}
                className={`flex-1 h-11 rounded-lg text-sm font-medium ${
                  minutes === m
                    ? "bg-colophon text-paper"
                    : "bg-stone-100 text-stone-600"
                }`}
              >
                {m < 60 ? `${m} min` : "1 hour"}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="block">
          <span className="text-sm text-stone-600">Up to (optional)</span>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-stone-500">{CURRENCY}</span>
            <input
              className="w-full border border-stone-300 rounded-lg px-3 py-2"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              inputMode="decimal"
              placeholder="no ceiling"
              aria-label="Code ceiling"
            />
          </div>
          {/* A ceiling is what makes a code safe to say out loud in a shop
              where somebody might be listening: overheard, it is worth at
              most this much, once. */}
          <span className="text-xs text-stone-500">
            The most this code can release. Leave blank and only the usual rules
            apply.
          </span>
        </label>

        <label className="block">
          <span className="text-sm text-stone-600">What it is for (optional)</span>
          <input
            className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Mr Molefe, cement"
            aria-label="Code reason"
          />
        </label>

        <button
          className="px-4 py-2 rounded-lg bg-colophon text-paper disabled:opacity-40"
          disabled={busy}
          onClick={issue}
        >
          {busy ? "Issuing…" : "Give me a code"}
        </button>
      </div>

      {issued && (
        <div className="max-w-xl bg-emerald-50 border border-emerald-200 rounded-xl p-5">
          <p className="text-sm text-emerald-900">Read this to the counter:</p>
          {/* Big, spaced, and the only time it is ever shown — the row keeps a
              hash, so there is no screen anywhere that can show it again. */}
          <p className="text-4xl font-bold tracking-[0.3em] tabular-nums my-2">
            {issued.code}
          </p>
          <p className="text-sm text-emerald-900">
            Good until{" "}
            {new Date(issued.expires_at).toLocaleTimeString("en-ZA", {
              hour: "2-digit",
              minute: "2-digit",
            })}
            , once. It will not be shown again.
          </p>
        </div>
      )}

      <div className="max-w-3xl bg-white rounded-xl border border-stone-200 p-4">
        <h3 className="font-medium">Codes issued</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-stone-500 mt-2">None yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-stone-100">
            {rows.map((r) => {
              const spent = r.used_at != null;
              const dead = !spent && new Date(r.expires_at) < new Date();
              return (
                <li key={r.id} className="py-2 px-1 text-sm flex items-baseline gap-3 even:bg-stone-50/70">
                  <span className="flex-1 min-w-0">
                    <span className="block">
                      {r.issued_by_name}
                      {r.max_amount != null && (
                        <span className="text-stone-500">
                          {" "}
                          · up to {money(r.max_amount)}
                        </span>
                      )}
                      {r.reason && <span className="text-stone-500"> · {r.reason}</span>}
                    </span>
                    <span className="block text-stone-500">
                      {new Date(r.created_at).toLocaleString("en-ZA", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </span>
                  <span
                    className={
                      spent ? "text-emerald-700" : dead ? "text-stone-400" : "text-amber-700"
                    }
                  >
                    {spent
                      ? `used by ${r.used_by_name ?? "somebody"}${r.doc_number ? ` · ${r.doc_number}` : ""}`
                      : dead
                        ? "expired"
                        : "live"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
