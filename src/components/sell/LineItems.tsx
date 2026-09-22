import { money, quantity } from "../../lib/money";
import { imageSrc } from "../../lib/images";
import type { CartLine } from "../../lib/types";
import {
  allowsFraction, baseQty, lineKey, lineSoldAs, priceFor as packPrice,
  soldBothWays, unitLabel,
} from "../../lib/packs";

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
  freshKey,
  onSetQty,
  onRemove,
  onDiscountLine,
  onInspect,
}: {
  lines: CartLine[];
  trade: boolean;
  /** The just-scanned line, tinted until the timer clears it. */
  freshKey: string | null;
  onSetQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  /** Take money off this line alone. Null clears whatever was on it. */
  onDiscountLine?: (key: string) => void;
  /** Open the closer look for a line already in the sale. */
  onInspect: (l: CartLine) => void;
}) {
  /**
   * Takes the line, not the product.
   *
   * This used to read price_trade/price_retail straight off the product, which
   * was right for exactly as long as a product had one price. It stopped being
   * right the day wire went on sale by the 50 m roll AND by the metre: the
   * table showed R550 against a line the cashier had cut to 2 m, while the
   * total underneath — which asks lib/packs — charged R120. Same basket, two
   * answers, and the one in the biggest type was the wrong one.
   */
  const priceOf = (l: CartLine) => packPrice(l.product, trade, lineSoldAs(l));

  /**
   * What the shelf gives up for this line, counted in base units.
   *
   * Two 50 m rolls is 100 m off the drum, not 2. And because the same product
   * can now be on the sale twice — a roll and a cut off it — both lines draw
   * down one stock figure, so each row shows the shelf after the WHOLE sale
   * rather than after itself. Two rows that each claim to take the count from
   * 100 to 98 describe a sale that never happened.
   */
  const consumed = (p: CartLine["product"]) =>
    lines
      .filter((x) => x.product.id === p.id)
      .reduce((sum, x) => sum + baseQty(x.product, lineSoldAs(x), x.qty), 0);

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
          const key = lineKey(l);
          const soldAs = lineSoldAs(l);
          const bothWays = soldBothWays(p);
          const fraction = allowsFraction(p, soldAs);
          const fresh = freshKey === key;
          /**
           * What tells the two lines apart out loud.
           *
           * "Quantity of Barb wire" named one control while the sale carried
           * two of them — a roll and a cut — and a cashier driving the till by
           * screen reader had no way to know which box they were in. Only
           * both-ways items get the suffix, so the rest of the range reads
           * exactly as it always did.
           */
          const which = bothWays
            ? ` (${soldAs === "pack" ? unitLabel(p, "pack") : "cut"})`
            : "";
          const stockAfter =
            p.stock_qty != null ? p.stock_qty - consumed(p) : null;

          return (
            <div
              key={key}
              className={`line-row${fresh ? " is-fresh" : ""}`}
              data-testid="line-row"
            >
              <span className="line-n">{i + 1}</span>

              <span className="line-main">
                {/* The photograph, when the catalogue has one — the same
                    picture the search result showed, so the line confirms the
                    choice it came from. Absent, the text simply starts where
                    it always did; an empty grey box on every unphotographed
                    line would punish the catalogue for being a work in
                    progress. */}
                {p.image_url != null && (
                  <img className="line-thumb" src={imageSrc(p.image_url) ?? undefined} alt="" />
                )}
                <span className="line-main-text">
                {/* The name is a button: "is that the right one?" gets asked
                    about a line already in the sale at least as often as about
                    a search result. */}
                <button
                  type="button"
                  className="line-desc line-desc-btn"
                  onClick={() => onInspect(l)}
                  title="Look closer"
                >
                  {p.name}
                </button>
                <span className="line-meta">
                  {/* Weighed and cut goods carry a tag before their metadata,
                      because these are the lines a customer queries later and
                      the slip has to explain itself weeks after the sale.

                      For an item sold both ways the tag has to say WHICH way,
                      and it is the only thing on the row that can: a 50 m roll
                      was being badged "Cut" purely because wire is measured in
                      metres, so the one line that had to distinguish itself
                      from a cut was labelled as one. */}
                  {bothWays ? (
                    <span className="line-tag">
                      {soldAs === "pack" ? unitLabel(p, "pack") : "Cut"}
                    </span>
                  ) : !p.allows_fraction ? null : (
                    <span className="line-tag">
                      {p.unit_code === "kg" ? "Weighed" : "Cut"}
                    </span>
                  )}
                  {/* The unit price rides along here because the Unit column
                      is dropped on a narrow tablet; on a wide screen this span
                      is hidden and the column carries it. Per WHAT matters as
                      much as how much: R550/m and R550 per 50 m roll are the
                      same digits and a factor of fifty apart. */}
                  <span className="line-rate">
                    @ {money(priceOf(l), { currency: false })}/
                    {soldAs === "pack" && bothWays
                      ? unitLabel(p, "pack")
                      : p.unit_code}{" "}
                    ·{" "}
                  </span>
                  {/* The identifying half, and the half that gives way. A
                      SKU and a bin are how you find the thing on a shelf; the
                      stock count beside them is how you find out you cannot
                      sell it. When the row is too narrow for both, the count
                      is the one that must survive, so it truncates and the
                      count does not. */}
                  <span className="line-meta-id">
                    {fresh ? "just scanned · " : `${p.sku} · `}
                    {p.bin ? `bin ${p.bin} · ` : ""}
                  </span>
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
                    "not tracked"
                  )}
                </span>
                </span>
              </span>

              <span className="line-qty">
                <input
                  // Whole-unit goods must not accept a fraction: half a padlock
                  // is not a sale, and the server refuses it anyway. The MODE
                  // decides, not the unit — pipe is measured in metres and
                  // metres divide, but two and a half 6 m lengths is not an
                  // order anybody can pick off a rack, and 0107 rejects it.
                  inputMode={fraction ? "decimal" : "numeric"}
                  value={l.qty}
                  aria-label={`Quantity of ${p.name}${which}`}
                  onChange={(e) => {
                    const raw = Number(e.target.value.replace(",", "."));
                    if (!Number.isFinite(raw)) return;
                    onSetQty(key, raw);
                  }}
                  onBlur={(e) => {
                    let v = Number(e.target.value.replace(",", "."));
                    if (!Number.isFinite(v) || v <= 0) v = 1;
                    if (!fraction) v = Math.round(v);
                    onSetQty(key, v);
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
                    {/* Why, under the how much. It matters most on a sale that
                        was parked and picked up an hour later by somebody who
                        was not there when it was agreed. */}
                    {l.discountReason && (
                      <span className="line-disc-why">{l.discountReason}</span>
                    )}
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
                  onClick={() => onDiscountLine(key)}
                  aria-label={`Discount ${p.name}${which}`}
                  title="Take money off this line"
                >
                  %
                </button>
              )}

              <button
                className="line-del"
                onClick={() => onRemove(key)}
                aria-label={`Remove ${p.name}${which}`}
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
