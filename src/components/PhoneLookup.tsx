import { useMemo, useRef, useState } from "react";
import ScanButton from "./ScanButton";
import { imageSrc } from "../lib/images";
import { money } from "../lib/money";
import { fmtQty } from "../lib/receipt";
import { searchProductsLocal } from "../lib/search";
import type { Product } from "../lib/types";

/**
 * "Have you got it, what's it cost, and where is it?"
 *
 * The single most-asked question in the shop, and until now the only way to
 * answer it away from the counter was to walk back to the counter. So this is
 * the one screen on the phone that is not a doorway to the back office: it is
 * its own small thing, and it is deliberately built on the CACHED catalogue —
 * the same array the till sells from — so it answers in a dead spot at the
 * back of the yard where there is no signal. A lookup that needs the line is
 * a lookup that fails in exactly the aisle you are standing in.
 *
 * Consequently it shows what the cache holds and nothing else. No "last
 * bought", no movements: those need the server, and a screen that half-works
 * offline is worse than one whose limits are obvious.
 */
export default function PhoneLookup({
  products,
  online,
  onBack,
}: {
  products: Product[];
  online: boolean;
  onBack: () => void;
}) {
  const [term, setTerm] = useState("");
  // The item being read properly. A hit row is a summary — a phone can only
  // give a name so many pixels — and the answer to "what IS this" is a
  // picture, a bin and a price big enough to read at arm's length.
  const [reading, setReading] = useState<Product | null>(null);
  const box = useRef<HTMLInputElement>(null);

  // Nothing typed shows nothing: a phone listing 1,400 products is a scroll,
  // not an answer, and it would bury the box you are meant to type in.
  const hits = useMemo(
    () => (term.trim() ? searchProductsLocal(products, term, 40) : []),
    [products, term]
  );

  // Read on its own screen rather than in a sheet over the list: a phone has
  // no room for both, and Back is the gesture this device already means it by.
  if (reading) {
    return <ItemCard product={reading} online={online} onBack={() => setReading(null)} />;
  }

  return (
    <div className="phone-screen">
      <header className="phone-screen-head">
        <button className="btn-line quiet" onClick={onBack}>Back</button>
        <h1>Look it up</h1>
      </header>

      <div className="phone-find">
        <input
          ref={box}
          className="scan-field"
          autoFocus
          value={term}
          placeholder="Scan a barcode, or search"
          aria-label="Scan a barcode, or search"
          onChange={(e) => setTerm(e.target.value)}
        />
        {/* The box says "scan a barcode" because at the counter a gun types
            one into it. In the aisle the phone's own lens has to do it. */}
        <ScanButton onCode={setTerm} />
        {term && (
          <button className="btn-line quiet" onClick={() => { setTerm(""); box.current?.focus(); }}>
            Clear
          </button>
        )}
      </div>

      {!online && (
        <p className="acc-note phone-pad">
          No line — this is the catalogue as the phone last saw it.
        </p>
      )}

      {term.trim() === "" ? (
        <p className="acc-note phone-pad">
          Scan the barcode, or type part of the name.
        </p>
      ) : hits.length === 0 ? (
        <p className="acc-note phone-pad">Nothing matches “{term.trim()}”.</p>
      ) : (
        <ul className="phone-hits">
          {hits.map((p) => {
            const src = imageSrc(p.image_url);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className="phone-hit"
                  onClick={() => setReading(p)}
                  aria-label={`Open ${p.name}`}
                >
                  {/* No mat when there is no photograph. A grey square on
                      every row of a catalogue that has few pictures reads as an
                      image that failed to load, and steals the width the name
                      needs on a phone. */}
                  {src && <img className="phone-hit-img" src={src} alt="" />}
                  <div className="phone-hit-what">
                    <span className="phone-hit-name">{p.name}</span>
                    <span className="phone-hit-sub">
                      {p.sku}
                      {p.barcode ? ` · ${p.barcode}` : ""}
                    </span>
                    {/* Where it physically is. The reason somebody standing in
                        the aisle opened this at all. */}
                    <span className="phone-hit-bin">
                      {p.bin ? `Bin ${p.bin}` : "No bin recorded"}
                    </span>
                  </div>
                  <div className="phone-hit-figures">
                    <span className="phone-hit-price tabular">{money(p.price_retail)}</span>
                    {p.price_trade != null && (
                      <span className="phone-hit-trade tabular">
                        Trade {money(p.price_trade)}
                      </span>
                    )}
                    {/* Stock that is not tracked says so, rather than showing a
                        zero somebody would read as "we are out". */}
                    <span
                      className={
                        "phone-hit-stock tabular" +
                        (p.stock_qty != null && p.stock_qty <= 0 ? " is-bad" : "")
                      }
                    >
                      {p.stock_qty == null
                        ? "Not counted"
                        : `${fmtQty(p.stock_qty)} ${p.unit_code} on hand`}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * One item, read properly.
 *
 * Everything here comes out of the cached catalogue, so it answers in the same
 * dead spot the list does. What it adds over the row is room: the photograph
 * at a size you can compare against the thing in your hand, the bin where
 * somebody looking for it will look first, and the price in figures that carry
 * across a yard.
 */
function ItemCard({
  product: p, online, onBack,
}: {
  product: Product;
  online: boolean;
  onBack: () => void;
}) {
  const src = imageSrc(p.image_url);
  return (
    <div className="phone-screen">
      <header className="phone-screen-head">
        <button className="btn-line quiet" onClick={onBack}>Back</button>
        <h1>Look it up</h1>
      </header>

      <div className="phone-item">
        {src && <img className="phone-item-img" src={src} alt={p.name} />}
        <h2 className="phone-item-name">{p.name}</h2>

        <p className="phone-item-price tabular">{money(p.price_retail)}</p>
        {p.price_trade != null && (
          <p className="phone-item-trade tabular">Trade {money(p.price_trade)}</p>
        )}

        <dl className="phone-item-facts">
          <dt>Bin</dt>
          <dd className="phone-item-bin">{p.bin ?? "Not recorded"}</dd>

          <dt>On hand</dt>
          <dd className={p.stock_qty != null && p.stock_qty <= 0 ? "is-bad" : undefined}>
            {p.stock_qty == null
              ? "Never counted"
              : `${fmtQty(p.stock_qty)} ${p.unit_code}`}
          </dd>

          {p.reorder_level != null && (
            <>
              <dt>Reorder at</dt>
              <dd>{fmtQty(p.reorder_level)}</dd>
            </>
          )}

          <dt>Sold by</dt>
          <dd>{p.unit_name ?? p.unit_code}</dd>

          <dt>Department</dt>
          <dd>{p.category_name ?? "—"}</dd>

          <dt>Code</dt>
          <dd className="tabular">{p.sku}</dd>

          {p.barcode && (
            <>
              <dt>Barcode</dt>
              <dd className="tabular">{p.barcode}</dd>
            </>
          )}
        </dl>

        {!online && (
          <p className="acc-note">
            No line — this is what the phone last saw, not what the till holds
            this minute.
          </p>
        )}
      </div>
    </div>
  );
}
