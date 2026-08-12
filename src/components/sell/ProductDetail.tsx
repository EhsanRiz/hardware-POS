import { money, quantity } from "../../lib/money";
import { imageSrc } from "../../lib/images";
import type { Product } from "../../lib/types";

/**
 * A closer look at one product, for the moment of doubt at the counter.
 *
 * Two questions this answers that a 44px thumbnail in a list cannot:
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
 * The picture is contained rather than cropped. A catalogue photograph is
 * already framed; cropping it to a square to fill the box is how a tap
 * fitting ends up looking like a piece of pipe.
 */
export default function ProductDetail({
  product,
  trade,
  onAdd,
  onClose,
}: {
  product: Product;
  /** Whether this sale is on the trade band, so the right price is emphasised. */
  trade: boolean;
  onAdd: (p: Product) => void;
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="detail-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
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

          {p.allows_fraction && (
            <p className="detail-note">
              Sold by length or weight — a part quantity is fine.
            </p>
          )}

          <div className="modal-actions detail-actions">
            <button className="btn-line" onClick={onClose}>
              Close
            </button>
            <button
              className="btn-fill"
              disabled={out}
              onClick={() => onAdd(p)}
            >
              {out ? "Out of stock" : `Add to sale · ${money(charged)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
