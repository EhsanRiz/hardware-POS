import { money, quantity } from "../../lib/money";
import type { CartLine } from "../../lib/types";

/**
 * The line-item table — design_handoff_innovapos §1.3.
 *
 * A CSS grid with identical tracks on the header row and every data row (see
 * sell.css), because a table of money that does not line up digit-under-digit
 * is a table nobody trusts.
 *
 * The metadata line under each description is the part that earns its keep:
 * it shows the stock movement the line CAUSES. The handoff is explicit that
 * stock is a consequence shown inline, never a task — the cashier learns that
 * the shelf count moved without being handed a second job.
 */
export default function LineItems({
  lines,
  trade,
  freshId,
  onSetQty,
  onRemove,
  onDiscountLine,
  onInspect,
}: {
  lines: CartLine[];
  trade: boolean;
  /** The just-scanned line, tinted until the timer clears it. */
  freshId: string | null;
  onSetQty: (productId: string, qty: number) => void;
  onRemove: (productId: string) => void;
  /** Take money off this line alone. Null clears whatever was on it. */
  onDiscountLine?: (productId: string) => void;
  /** Open the closer look for a line already in the sale. */
  onInspect: (p: CartLine["product"]) => void;
}) {
  const priceOf = (l: CartLine) =>
    trade && l.product.price_trade != null
      ? l.product.price_trade
      : l.product.price_retail;

  return (
    <>
      <div className="lines-head">
        <span>#</span>
        <span>Item</span>
        <span className="line-qty">Qty</span>
        <span className="line-unit">Unit</span>
        <span className="line-amt">Amount</span>
        {/* Two empty cells: the discount key and the remove key. The header
            shares the row grid, so a missing one shifts every column under it. */}
        <span />
        <span />
      </div>

      <div className="lines-scroll">
        {lines.length === 0 && (
          <p className="lines-empty">
            Scan an item to start a sale — or press F2 and describe it.
          </p>
        )}

        {lines.map((l, i) => {
          const p = l.product;
          const fresh = freshId === p.id;
          const stockAfter =
            p.stock_qty != null ? p.stock_qty - l.qty : null;

          return (
            <div
              key={p.id}
              className={`line-row${fresh ? " is-fresh" : ""}`}
              data-testid="line-row"
            >
              <span className="line-n">{i + 1}</span>

              <span className="line-main">
                {/* The name is a button: "is that the right one?" gets asked
                    about a line already in the sale at least as often as about
                    a search result. */}
                <button
                  type="button"
                  className="line-desc line-desc-btn"
                  onClick={() => onInspect(l.product)}
                  title="Look closer"
                >
                  {p.name}
                </button>
                <span className="line-meta">
                  {/* Weighed and cut goods carry a tag before their metadata,
                      because these are the lines a customer queries later and
                      the slip has to explain itself weeks after the sale. */}
                  {!p.allows_fraction ? null : (
                    <span className="line-tag">
                      {p.unit_code === "kg" ? "Weighed" : "Cut"}
                    </span>
                  )}
                  {/* The unit price rides along here because the Unit column
                      is dropped on a narrow tablet; on a wide screen this span
                      is hidden and the column carries it. */}
                  <span className="line-rate">
                    @ {money(priceOf(l), { currency: false })}/{p.unit_code} ·{" "}
                  </span>
                  {fresh ? "just scanned · " : `${p.sku} · `}
                  {p.bin ? `bin ${p.bin} · ` : ""}
                  {stockAfter != null ? (
                    // The stock this line CONSUMES, shown as it happens. The
                    // handoff is explicit that stock is a consequence, never a
                    // task: the cashier watches the shelf count fall as they
                    // change the quantity, and is never handed a second job.
                    <span
                      className={`line-stock${stockAfter < 0 ? " is-short" : ""}`}
                    >
                      stock {quantity(p.stock_qty!, "")} →{" "}
                      {quantity(stockAfter, "")}
                    </span>
                  ) : (
                    "not stock-tracked"
                  )}
                </span>
              </span>

              <span className="line-qty">
                <input
                  // Whole-unit goods must not accept a fraction: half a padlock
                  // is not a sale, and the server refuses it anyway.
                  inputMode={p.allows_fraction ? "decimal" : "numeric"}
                  value={l.qty}
                  aria-label={`Quantity of ${p.name}`}
                  onChange={(e) => {
                    const raw = Number(e.target.value.replace(",", "."));
                    if (!Number.isFinite(raw)) return;
                    onSetQty(p.id, raw);
                  }}
                  onBlur={(e) => {
                    let v = Number(e.target.value.replace(",", "."));
                    if (!Number.isFinite(v) || v <= 0) v = 1;
                    if (!p.allows_fraction) v = Math.round(v);
                    onSetQty(p.id, v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              </span>

              <span className="line-unit">
                {money(priceOf(l), { currency: false })}
              </span>

              <span className="line-amt">
                {money(priceOf(l) * l.qty, { currency: false })}
                {!!l.discount && l.discount > 0 && (
                  <span className="line-disc">
                    {l.discountPercent ? `less ${l.discountPercent}% ` : "less "}
                    −{money(l.discount, { currency: false })}
                  </span>
                )}
              </span>

              {/* Money off THIS line. It hid behind the amount figure at first,
                  which reads as text and offers nothing to tap on a tablet
                  where there is no hover to reveal it. A feature nobody can
                  find is a feature nobody has. */}
              {onDiscountLine && (
                <button
                  className={`line-off${l.discount ? " is-set" : ""}`}
                  onClick={() => onDiscountLine(p.id)}
                  aria-label={`Discount ${p.name}`}
                  title="Take money off this line"
                >
                  %
                </button>
              )}

              <button
                className="line-del"
                onClick={() => onRemove(p.id)}
                aria-label={`Remove ${p.name}`}
                title="Remove line"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
