import { useEffect, useMemo, useState } from "react";
import { searchProducts } from "../../lib/api";
import { money, quantity } from "../../lib/money";
import { isNetworkError, useOnline } from "../../lib/offline";
import { imageSrc } from "../../lib/images";
import { exactMatch, searchProductsLocal } from "../../lib/search";
import type { Customer, Product } from "../../lib/types";
import { ScanIcon, UserIcon } from "./Icons";

/**
 * The scan bar — design_handoff_innovapos §1.2 — and the item search behind it.
 *
 * One input does three jobs, in the order they matter at a counter:
 *
 *   1. SCANNING. A barcode scanner is a keyboard that types fast and presses
 *      Enter, so it needs no integration — but an exact code must ring straight
 *      through rather than showing a list of one.
 *   2. THE SHOP'S WORDS vs THE CUSTOMER'S. Someone asks for a "concrete nail
 *      2.5x5"; the shelf label reads "Nail Concrete 2.5 × 50 mm". Matching each
 *      word independently and normalising size notation bridges that gap.
 *   3. TYPOS, because the counter is busy.
 *
 * The server does 2 and 3 better — it sees the whole catalogue and has real
 * trigram indexes — so it is asked whenever the line is up. When it is not, the
 * same rules run against the cached catalogue, because a search that dies with
 * the connection is useless at exactly the moment the shop needs it.
 */
export default function ScanBar({
  term,
  onTermChange,
  products,
  trade,
  customer,
  onAdd,
  onInspect,
  onPickCustomer,
  inputRef,
}: {
  term: string;
  onTermChange: (t: string) => void;
  products: Product[];
  trade: boolean;
  customer: Customer | null;
  /** Ring an item straight through — a scan, where there is nothing to check. */
  onAdd: (p: Product) => void;
  /** Open the closer look, where the quantity is decided and the sale is made. */
  onInspect: (p: Product) => void;
  onPickCustomer: () => void;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  const [remote, setRemote] = useState<Product[] | null>(null);
  const [active, setActive] = useState(0);
  const online = useOnline();

  const price = (p: Product) =>
    trade && p.price_trade != null ? p.price_trade : p.price_retail;

  const local = useMemo(
    () => searchProductsLocal(products, term, 40),
    [products, term]
  );

  // Ask the server, debounced. Typing outruns a round trip, so a stale response
  // must never overwrite a newer one.
  useEffect(() => {
    const q = term.trim();
    if (!online || q.length < 2) {
      setRemote(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchProducts(q, 40)
        .then((rows) => !cancelled && setRemote(rows))
        .catch((e) => {
          // Falling back to the cached catalogue is the right answer for a
          // dropped line; anything else deserves surfacing rather than hiding.
          if (!cancelled && !isNetworkError(e)) console.error(e);
          if (!cancelled) setRemote(null);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, online]);

  const matches = term.trim() ? remote ?? local : [];
  useEffect(() => setActive(0), [term]);

  function scan(p: Product) {
    onAdd(p);
    onTermChange("");
    inputRef.current?.focus();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = term.trim();
    if (!q) return;
    // An exact barcode or SKU is unambiguous — treat it as a scan, whatever
    // else the fuzzy search turned up. The gun types a code and presses Enter;
    // putting a dialog in front of that would halve the speed of the counter.
    const hit = exactMatch(products, q);
    if (hit) return scan(hit);
    // A described item is a different thing: somebody is choosing between eight
    // near-identical hose sets, so the choice opens for a look and a quantity.
    if (matches[active]) return onInspect(matches[active]);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!matches.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape") {
      onTermChange("");
    }
  }

  return (
    <div className="scan-zone">
      <div className="scan-bar">
        <form className="scan-field" onSubmit={submit} role="search">
          <ScanIcon />
          <input
            ref={inputRef}
            type="text"
            value={term}
            onChange={(e) => onTermChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Scan barcode, or describe the item…"
            autoComplete="off"
            autoFocus
            aria-label="Scan barcode or search for an item"
          />
          <span className="hint">F2 search</span>
        </form>

        {/* Choosing an account customer re-prices every line to the trade band,
            which is why it sits here in the scan bar and not inside payment —
            by the time you are taking money it is too late to re-price. */}
        <button className="customer-pick" onClick={onPickCustomer}>
          <UserIcon />
          <span>
            <span className="who">{customer ? customer.name : "Walk-in customer"}</span>
            <span className="band">{trade ? "Trade price" : "Retail price"}</span>
          </span>
        </button>
      </div>

      {matches.length > 0 && (
        <div className="results" role="listbox" aria-label="Search results">
          {matches.map((p, i) => {
            const out = p.stock_qty != null && p.stock_qty <= 0;
            const low =
              p.stock_qty != null &&
              p.reorder_level != null &&
              p.stock_qty > 0 &&
              p.stock_qty <= p.reorder_level;
            return (
              // Eight hose sets differing only by length and colour are chosen
              // from this list, and the answer to "is that the one?" arrives at
              // the same moment as "give me four". So the whole row opens the
              // closer look — picture, bin, quantity — and the sale is made
              // from there. An out-of-stock row opens too: where it lives and
              // how many are due in is exactly what gets asked next.
              <button
                type="button"
                key={p.id}
                className={`result-row${i === active ? " is-active" : ""}${
                  out ? " is-out" : ""
                }`}
                onMouseEnter={() => setActive(i)}
                onClick={() => onInspect(p)}
                title="Look closer"
              >
                {imageSrc(p.image_url) ? (
                  <img className="result-thumb" src={imageSrc(p.image_url)!} alt="" loading="lazy" />
                ) : (
                  <span className="result-thumb is-empty" aria-hidden="true" />
                )}

                <span>
                  <span className="result-name">{p.name}</span>
                  <span className="result-meta">
                    <span>{p.sku}</span>
                    {p.bin && <span>bin {p.bin}</span>}
                    <span>per {p.unit_code}</span>
                    {/* On-hand stock on every row. Knowing there are six left
                        before ringing up eight is the difference between a
                        conversation and a refund. */}
                    {p.stock_qty != null && !out && (
                      <span className={low ? "low" : undefined}>
                        {quantity(p.stock_qty, p.unit_code)} on hand
                      </span>
                    )}
                    {out && <span className="out">out of stock</span>}
                  </span>
                </span>
                <span className="result-price">{money(price(p))}</span>
              </button>
            );
          })}
        </div>
      )}

      {term.trim() !== "" && matches.length === 0 && (
        <div className="results" style={{ padding: "18px" }}>
          <span className="result-meta">Nothing matches “{term}”.</span>
        </div>
      )}
    </div>
  );
}
