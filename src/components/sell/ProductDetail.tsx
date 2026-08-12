import { useEffect, useRef, useState } from "react";
import { money, quantity } from "../../lib/money";
import { imageSrc } from "../../lib/images";
import type { Product } from "../../lib/types";

/**
 * A closer look at one product, and the place a quantity is decided.
 *
 * Three questions this answers that a 44px thumbnail in a list cannot:
 *
 *   "Is this the one you meant?" — the tablet gets turned around and the
 *   customer looks at the picture. That is the whole point, and it decides
 *   what may appear here: no cost, no margin, and no trade price unless this
 *   sale is already on the trade band. Anything on this screen may be read by
 *   the person on the other side of the counter.
 *
 *   "Where is it?" — the bin is the largest thing after the picture, because
 *   what usually happens next is somebody walking into the yard to fetch it.
 *
 *   "How many?" — asked at the same moment as the other two. A customer who
 *   points at the picture says "yes, four of those" in the same breath, so the
 *   quantity is settled here rather than by adding one line and then going
 *   back to correct it.
 *
 * The picture is contained rather than cropped. A catalogue photograph is
 * already framed; cropping it to a square to fill the box is how a tap
 * fitting ends up looking like a piece of pipe.
 */
export default function ProductDetail({
  product,
  trade,
  mode,
  inSale,
  onConfirm,
  onClose,
}: {
  product: Product;
  /** Whether this sale is on the trade band, so the right price is emphasised. */
  trade: boolean;
  /**
   * "add" — reached from a search result. The quantity starts at one and is
   * ADDED to whatever the sale already carries.
   * "edit" — reached from a line already in the sale. The quantity starts at
   * that line's and REPLACES it, because opening a line you already rang up
   * and being offered "add another" is how a sale ends up with eight padlocks.
   */
  mode: "add" | "edit";
  /** How many of this product the sale already carries. */
  inSale: number;
  onConfirm: (p: Product, qty: number) => void;
  onClose: () => void;
}) {
  const p = product;
  const out = p.stock_qty != null && p.stock_qty <= 0;
  const low =
    p.stock_qty != null &&
    p.reorder_level != null &&
    p.stock_qty > 0 &&
    p.stock_qty <= p.reorder_level;
  const retail = p.price_retail;
  const tradePrice = p.price_trade;
  const charged = trade && tradePrice != null ? tradePrice : retail;

  // Cut and weighed goods step in halves, whole goods in ones. Constraint 7:
  // a quantity is a decimal with a unit, never a count.
  const step = p.allows_fraction ? 0.5 : 1;
  const [qtyText, setQtyText] = useState(() =>
    String(mode === "edit" && inSale > 0 ? inSale : 1)
  );
  const qtyRef = useRef<HTMLInputElement>(null);

  const typed = Number(qtyText.replace(",", "."));
  const qty = Number.isFinite(typed) && typed > 0 ? round3(typed) : 0;
  const short = !out && p.stock_qty != null && qty > p.stock_qty;

  // The field opens focused and selected: type "cement", Enter, "4", Enter.
  // Constraint 2 — every action reachable by key, and the counter is faster on
  // keys than on glass.
  useEffect(() => {
    qtyRef.current?.select();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  function bump(delta: number) {
    setQtyText(String(round3(Math.max(step, (qty || 0) + delta))));
  }

  function tidy() {
    if (qty <= 0) return setQtyText("1");
    setQtyText(String(p.allows_fraction ? qty : Math.max(1, Math.round(qty))));
  }

  function confirm() {
    if (out || qty <= 0) return;
    onConfirm(p, p.allows_fraction ? qty : Math.max(1, Math.round(qty)));
  }

  const total = charged * (qty || 0);
  const action = mode === "edit" ? "Update sale" : "Add to sale";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="detail-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={p.name}
      >
        <div className="detail-photo">
          {imageSrc(p.image_url) ? (
            <img src={imageSrc(p.image_url)!} alt={p.name} />
          ) : (
            <span className="detail-nophoto">No photograph yet</span>
          )}
        </div>

        <div className="detail-body">
          <h2 className="detail-name">{p.name}</h2>
          <p className="detail-sku">
            {p.sku}
            {p.barcode ? ` · ${p.barcode}` : ""}
            {p.category_name ? ` · ${p.category_name}` : ""}
          </p>

          <div className="detail-figures">
            <div className="detail-figure">
              <span className="acc-figure-label">
                {trade && tradePrice != null ? "Trade price" : "Price"}
              </span>
              <span className="detail-price">{money(charged)}</span>
              {/* The trade price appears only when this sale is already ON the
                  trade band. A walk-in who reads "trade R1 125" over the
                  cashier's shoulder will ask for it, and the cashier is then
                  arguing about a number the screen volunteered. */}
              {trade && tradePrice != null && (
                <span className="detail-note">retail {money(retail)}</span>
              )}
              <span className="detail-note">per {p.unit_code}</span>
            </div>

            {p.bin && (
              <div className="detail-figure">
                <span className="acc-figure-label">Where it is</span>
                <span className="detail-bin">{p.bin}</span>
              </div>
            )}

            <div className="detail-figure">
              <span className="acc-figure-label">On hand</span>
              <span
                className={`detail-stock${out ? " is-bad" : low ? " is-late" : ""}`}
              >
                {p.stock_qty == null
                  ? "not tracked"
                  : quantity(p.stock_qty, p.unit_code)}
              </span>
              {low && !out && <span className="detail-note">running low</span>}
              {out && <span className="detail-note">out of stock</span>}
            </div>
          </div>

          {p.description && <p className="detail-desc">{p.description}</p>}

          {/* How many. A stepper for the thumb and a field for the keyboard —
              a cashier holding a tape measure uses one, a cashier at a keyboard
              uses the other, and neither is made to use the wrong one. */}
          <div className="detail-figure">
            <span className="acc-figure-label">
              {mode === "edit" ? "Quantity on this line" : "How many"}
            </span>
            <div className="detail-qty">
              <div className="qty-stepper">
                <button
                  type="button"
                  onClick={() => bump(-step)}
                  disabled={qty <= step}
                  aria-label="One fewer"
                >
                  −
                </button>
                <input
                  ref={qtyRef}
                  // Whole-unit goods must not accept a fraction: half a padlock
                  // is not a sale, and the server refuses it anyway.
                  inputMode={p.allows_fraction ? "decimal" : "numeric"}
                  value={qtyText}
                  onChange={(e) => setQtyText(e.target.value)}
                  onBlur={tidy}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      confirm();
                    }
                  }}
                  // Deliberately not "Quantity of X": the line-item field in the
                  // sale behind this dialog carries that name, and two controls
                  // answering to one label is a trap for anyone driving the till
                  // by screen reader.
                  aria-label={`How many ${p.name}`}
                />
                <button
                  type="button"
                  onClick={() => bump(step)}
                  aria-label="One more"
                >
                  +
                </button>
              </div>
              <span className="detail-qty-note">
                {quantity(qty || 0, p.unit_code)} × {money(charged)}
              </span>
            </div>

            {p.allows_fraction && (
              <span className="detail-note">
                Sold by length or weight — a part quantity is fine.
              </span>
            )}
            {short && (
              <span className="detail-note is-short">
                Only {quantity(p.stock_qty!, p.unit_code)} on hand.
              </span>
            )}
            {/* Told, not enforced: the same item can legitimately be rung up
                twice on one sale, and a cashier who cannot see the first line
                from here should not have to guess. */}
            {mode === "add" && inSale > 0 && (
              <span className="detail-note">
                {quantity(inSale, p.unit_code)} already on this sale — this adds
                to it.
              </span>
            )}
          </div>

          <div className="modal-actions detail-actions">
            <button className="btn-line" onClick={onClose}>
              Close
            </button>
            <button
              className="btn-fill"
              disabled={out || qty <= 0}
              onClick={confirm}
            >
              {out ? "Out of stock" : `${action} · ${money(total)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Kill binary-float dust: 0.1 + 0.2 has no business reaching an invoice. */
function round3(n: number): number {
  return Number(n.toFixed(3));
}
