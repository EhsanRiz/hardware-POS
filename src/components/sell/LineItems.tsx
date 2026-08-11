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
}: {
  lines: CartLine[];
  trade: boolean;
  /** The just-scanned line, tinted until the timer clears it. */
  freshId: string | null;
  onSetQty: (productId: string, qty: number) => void;
  onRemove: (productId: string) => void;
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

              <span>
                <span className="line-desc">{p.name}</span>
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
                  {fresh
                    ? `just scanned${
                        stockAfter != null
                          ? ` · stock ${quantity(p.stock_qty!, "")} → ${quantity(
                              stockAfter,
                              ""
                            )}`
                          : ""
                      }`
                    : `${p.sku}${
                        stockAfter != null
                          ? ` · stock ${quantity(p.stock_qty!, "")} → ${quantity(
                              stockAfter,
                              ""
                            )}`
                          : ""
                      }`}
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
              </span>

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
