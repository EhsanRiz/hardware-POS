import { useState } from "react";
import { money } from "../lib/format";
import { CURRENCY } from "../lib/config";
import NumberPad from "./NumberPad";

/** What the modal knows about the discount somebody just agreed to. */
export interface DiscountDetail {
  /** The rand figure that travels. Always set, whichever way it was typed. */
  amount: number;
  /** The percentage, when it was asked for as one. Null when it was rands. */
  percent: number | null;
  /** What the cashier typed to explain it, and nothing else. */
  note: string | null;
  /**
   * Percentage and note as one string, for the sale-level discount — `sales`
   * keeps a single reason column and the percentage has nowhere else to go.
   * A line has a column for each and uses `percent` and `note` instead.
   */
  reason: string;
}

interface Props {
  subtotal: number;
  /**
   * The shop's cap on this — the most that may come off, whoever asks. Null
   * means uncapped. This one refuses: there is no PIN that lifts it, which is
   * why it is checked here and not left to the tender screen to discover.
   */
  ceiling?: number | null;
  /**
   * How much goes through on this person's own authority before a manager has
   * to be fetched. Null means none does — every discount they give is
   * approved, which is how the shop worked before limits existed. Undefined
   * means they approve their own, so approval is never mentioned.
   */
  approvalFreeUpTo?: number | null;
  onApply: (d: DiscountDetail) => void;
  onCancel: () => void;
}

/**
 * Taking money off the whole sale.
 *
 * Two ways to say the same thing, because a counter uses both: "give him fifty
 * off" and "give him ten percent". The percentage is worked out here and what
 * travels is an amount — the server stores a figure, the invoice shows a
 * figure, and a percentage recomputed later against a changed total would not
 * be the discount that was actually given.
 *
 * The percentage still reaches the slip, though: it goes into the reason. A
 * customer looking at "Discount -R506.40" wants to see the 10% they were
 * promised, and a manager reading it back next week wants the same.
 */
export default function DiscountModal({
  subtotal,
  ceiling,
  approvalFreeUpTo,
  onApply,
  onCancel,
}: Props) {
  const [mode, setMode] = useState<"amount" | "percent">("amount");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  const typed = Number(value) || 0;
  const amount =
    mode === "percent"
      ? Math.round(subtotal * (typed / 100) * 100) / 100
      : typed;

  const overSubtotal = amount > subtotal;
  const overHundred = mode === "percent" && typed > 100;
  // A cent of slack, matching the server: a percentage of an odd figure can
  // land a rounding cent over a cap that was meant to be exactly reachable.
  const overCeiling = ceiling != null && amount > ceiling + 0.005;
  const invalid = amount <= 0 || overSubtotal || overHundred || overCeiling;

  // Not a refusal — the sale still happens, it just waits for a PIN. Said
  // before Apply is pressed so the cashier can decide whether to fetch
  // somebody or offer less, rather than finding out at the tender screen.
  const willNeedApproval =
    approvalFreeUpTo !== undefined &&
    amount > 0 &&
    !overCeiling &&
    (approvalFreeUpTo === null || amount > approvalFreeUpTo + 0.005);

  function apply() {
    // The percentage is the thing worth remembering, so it leads the reason and
    // whatever the cashier typed follows it. The pieces go out beside it: a
    // caller with a column for each should not have to pick this string apart
    // again with a regular expression, which is how the typed words used to get
    // lost on their way to a line.
    const percent = mode === "percent" ? typed : null;
    const note = reason.trim();
    onApply({
      amount,
      percent,
      note: note || null,
      reason:
        percent != null
          ? [`${percent}% off`, note].filter(Boolean).join(" — ")
          : note,
    });
  }

  return (
    <div className="vv-fixed bg-black/50 flex items-center justify-center p-6 z-50 animate-fade-in">
      {/* Bounded by the visible screen and scrolling inside it. With a keypad
          added this dialog is taller than a phone has left once a keyboard is
          up, and a card centred in a short scrim spills equally off both ends —
          the title above the screen and Apply below it. */}
      <div
        className="bg-white rounded-2xl p-6 w-full max-w-sm animate-scale-in max-h-full overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="Apply discount"
      >
        <h2 className="text-xl font-bold text-stone-800 mb-1">Apply discount</h2>
        <p className="text-stone-500 mb-1">Subtotal {money(subtotal)}</p>
        {/* The ceiling is worth stating up front rather than only when it is
            hit: a cashier who knows the cement stops at 5% negotiates around
            it, and one who does not promises 20% and then takes it back. */}
        {ceiling != null && (
          <p className="text-sm text-amber-800 mb-3">
            Capped at {money(ceiling)} off. Nobody can go past this.
          </p>
        )}
        {ceiling == null && <div className="mb-3" />}

        <div className="flex gap-2 mb-4">
          {([
            ["amount", `Amount (${CURRENCY})`],
            ["percent", "Percent (%)"],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setMode(k)}
              aria-pressed={mode === k}
              className={`flex-1 h-11 rounded-lg text-sm font-medium ${
                mode === k
                  ? "bg-stone-800 text-white"
                  : "bg-stone-100 text-stone-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="block text-sm font-medium text-stone-600 mb-1">
          {mode === "percent" ? "Percent off" : `Amount (${CURRENCY})`}
        </label>
        {/* inputMode="none" keeps the OS keyboard shut on a tablet without
            keeping a real keyboard out: a desk types into this exactly as
            before. The on-screen keys underneath are how a counter enters it.
            Before this, focusing the box raised the iPad keyboard over the
            middle of the screen and buried the dialog it belonged to. */}
        <input
          type="text"
          inputMode="none"
          aria-label={mode === "percent" ? "Discount percent" : "Discount amount"}
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
          autoFocus
          className="w-full h-12 px-3 rounded-lg border border-stone-300 text-lg mb-2 tabular-nums"
          placeholder={mode === "percent" ? "0" : "0.00"}
        />

        <div className="mb-2">
          <NumberPad value={value} onChange={setValue} />
        </div>

        {/* What the percentage actually comes to, before it is applied. Nobody
            should have to do the arithmetic to find out what they just agreed
            to give away. */}
        {mode === "percent" && typed > 0 && !overHundred && (
          <p className="text-stone-600 text-sm mb-2" role="status">
            {typed}% of {money(subtotal)} is <strong>{money(amount)}</strong>
          </p>
        )}

        <label className="block text-sm font-medium text-stone-600 mb-1 mt-2">
          Reason (optional)
        </label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-2"
          placeholder="e.g. staff, loyalty"
        />

        {overCeiling && (
          <p className="text-red-600 text-sm mb-2">
            The most that comes off this is {money(ceiling ?? 0)}. It is capped on
            the item, so no PIN will lift it.
          </p>
        )}
        {willNeedApproval && (
          <p className="text-amber-800 text-sm mb-2" role="status">
            {approvalFreeUpTo === null
              ? "A manager will need to approve this."
              : `Over your ${money(approvalFreeUpTo)} — a manager will need to approve this.`}
          </p>
        )}

        {overHundred && (
          <p className="text-red-600 text-sm mb-2">
            A discount cannot be more than the whole thing.
          </p>
        )}
        {overSubtotal && !overHundred && (
          <p className="text-red-600 text-sm mb-2">
            Discount cannot exceed the subtotal.
          </p>
        )}

        <div className="flex gap-2 mt-4">
          <button
            onClick={onCancel}
            className="flex-1 h-12 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={invalid}
            className="flex-1 h-12 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
