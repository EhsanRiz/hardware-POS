import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  abandonStockCount,
  openStockCount,
  postStockCount,
  setCountedQty,
  stockCountLines,
  stockCounts,
  type StockCount,
  type StockCountLine,
} from "../../lib/adminApi";
import { errorMessage } from "../../lib/errors";
import { fmtDayMonthTime } from "../../lib/dates";
import { money } from "../../lib/money";
import { fmtQty } from "../../lib/receipt";

/**
 * Counting the shelves.
 *
 * The Stock screen already corrects one product at a time, which is right for
 * "this bag is torn, take it off". This is the other thing: a person with a
 * tablet walking an aisle, writing down what is actually there, and posting
 * the lot at the end.
 *
 * THE RULE THAT MATTERS. What gets posted is the DIFFERENCE between what was
 * counted and what the system expected when the sheet was opened — not the
 * counted figure itself. The shop keeps trading while somebody counts, and
 * setting the quantity to what the shelf held twenty minutes ago would
 * silently undo every sale rung up in between.
 *
 * A line nobody counted is left alone. A half-finished sheet corrects what it
 * knows and says nothing about the rest, which is the honest reading of a
 * clipboard with blanks on it.
 */
export default function StockTake({
  pin,
  categories,
  online,
}: {
  pin: string;
  categories: { id: string; name: string }[];
  online: boolean;
}) {
  const [counts, setCounts] = useState<StockCount[] | null>(null);
  const [open, setOpen] = useState<StockCount | null>(null);
  const [lines, setLines] = useState<StockCountLine[] | null>(null);
  const [typed, setTyped] = useState<Map<string, string>>(new Map());
  const [term, setTerm] = useState("");
  const [onlyLeft, setOnlyLeft] = useState(false);
  const [busy, setBusy] = useState(false);
  // The boxes a scan has to land in, by product, so a scanned code can put the
  // cursor where the number goes.
  const boxes = useRef(new Map<string, HTMLInputElement | null>());
  const finder = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [newDept, setNewDept] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      setCounts(await stockCounts(pin));
    } catch (e) {
      setError(errorMessage(e, "Could not load the stock counts"));
    }
  }, [pin]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadLines = useCallback(
    async (c: StockCount) => {
      setBusy(true);
      setError(null);
      try {
        setLines(await stockCountLines(pin, c.id));
        setOpen(c);
        setTyped(new Map());
      } catch (e) {
        setError(errorMessage(e, "Could not open that sheet"));
      } finally {
        setBusy(false);
      }
    },
    [pin]
  );

  const shown = useMemo(() => {
    if (!lines) return [];
    const q = term.trim().toLowerCase();
    return lines.filter((l) => {
      if (onlyLeft && l.counted_qty != null) return false;
      if (!q) return true;
      return (
        l.name.toLowerCase().includes(q) ||
        (l.sku ?? "").toLowerCase().includes(q) ||
        (l.bin ?? "").toLowerCase().includes(q)
      );
    });
  }, [lines, term, onlyLeft]);

  /**
   * A scanned code goes straight to its line.
   *
   * The motion in an aisle is scan, type, scan, type — not "type part of a
   * name, find the row, tap the box". A hardware scanner is a keyboard that
   * types fast and presses Enter, so it works through the same box that
   * filters by name, with no hardware integration: an exact barcode or SKU
   * rings straight through, and anything else goes on filtering.
   *
   * Focus then returns here from the quantity box, because otherwise the next
   * scan lands in the last item's quantity and silently miscounts it.
   */
  function jumpTo(raw: string): boolean {
    const code = raw.trim().toLowerCase();
    if (!code || !lines) return false;
    const hit = lines.find(
      (l) => (l.barcode ?? "").toLowerCase() === code
          || (l.sku ?? "").toLowerCase() === code
    );
    if (!hit) return false;
    // Clear whatever was filtering, or the row we just found may be hidden.
    setTerm("");
    setOnlyLeft(false);
    setError(null);
    // After the filter has been dropped and the row is on screen again.
    window.setTimeout(() => {
      const box = boxes.current.get(hit.product_id);
      box?.scrollIntoView({ block: "center" });
      box?.focus();
      box?.select();
    }, 0);
    return true;
  }

  const counted = lines?.filter((l) => l.counted_qty != null).length ?? 0;
  const variances = lines?.filter(
    (l) => l.counted_qty != null && l.counted_qty !== l.expected_qty
  ) ?? [];
  // What the differences are worth, before anything is posted. A person
  // deciding whether to walk the aisle again wants the money, not the count.
  const shortValue = variances.reduce(
    (t, l) => t + (l.variance_value != null && l.variance_value < 0 ? -l.variance_value : 0), 0);
  const overValue = variances.reduce(
    (t, l) => t + (l.variance_value != null && l.variance_value > 0 ? l.variance_value : 0), 0);

  /** Record what is on the shelf. Blank clears the line back to uncounted. */
  async function record(l: StockCountLine, raw: string) {
    if (!open) return;
    const qty = raw.trim() === "" ? null : Number(raw.replace(",", "."));
    if (qty != null && !Number.isFinite(qty)) return;
    try {
      await setCountedQty(pin, open.id, l.product_id, qty);
      setLines((prev) =>
        (prev ?? []).map((x) =>
          x.product_id === l.product_id
            ? {
                ...x,
                counted_qty: qty,
                variance: qty == null ? null : qty - x.expected_qty,
                // The money as well as the quantity. Updating one and not the
                // other left the sheet showing "-3" against no figure at all
                // until somebody reloaded it.
                variance_value: qty == null || x.unit_cost == null
                  ? null
                  : Math.round((qty - x.expected_qty) * x.unit_cost * 100) / 100,
                counted_at: qty == null ? null : new Date().toISOString(),
              }
            : x
        )
      );
    } catch (e) {
      setError(errorMessage(e, "That count could not be recorded"));
    }
  }

  async function post() {
    if (!open) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postStockCount(pin, open.id);
      setBanner(
        r.lines_moved === 0
          ? `${open.doc_number} posted — every line counted agreed with the shelf.`
          : `${open.doc_number} posted — ${r.lines_moved} ${
              r.lines_moved === 1 ? "line" : "lines"
            } corrected, ${fmtQty(r.units_down)} short and ${fmtQty(r.units_up)} over`
            + (r.value_down > 0 ? `. ${money(r.value_down)} off the books.` : ".")
      );
      setOpen(null);
      setLines(null);
      await load();
    } catch (e) {
      setError(errorMessage(e, "That count could not be posted"));
    } finally {
      setBusy(false);
    }
  }

  if (open && lines) {
    return (
      <div className="space-y-3">
        {error && <p className="acc-note is-bad">{error}</p>}
        <div className="stock-receive-bar">
          <button className="btn-line" onClick={() => { setOpen(null); setLines(null); }}>
            Back
          </button>
          <input
            ref={finder}
            className="acc-search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const typed = term;
              if (jumpTo(typed)) return;
              // Not a code we know. Say so rather than leaving somebody
              // staring at an empty list wondering which of the two it is.
              if (typed.trim() && (lines ?? []).every((l) =>
                    !l.name.toLowerCase().includes(typed.trim().toLowerCase()) &&
                    !(l.sku ?? "").toLowerCase().includes(typed.trim().toLowerCase()))) {
                setError(`${typed.trim()} is not on this sheet.`);
              }
            }}
            placeholder="Scan a barcode, or find a line by name, code or bin"
            aria-label="Scan or find a line on this sheet"
          />
          <label className="btn-line" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={onlyLeft}
              onChange={(e) => setOnlyLeft(e.target.checked)}
            />
            Still to count
          </label>
        </div>

        <p className="acc-note">
          {open.doc_number} · {counted} of {lines.length} counted ·{" "}
          {variances.length} {variances.length === 1 ? "difference" : "differences"}
          {shortValue > 0 && (
            <> · <span className="is-bad">{money(shortValue)} short</span></>
          )}
          {overValue > 0 && <> · {money(overValue)} over</>}.
          Nothing moves until this is posted, and only the lines you counted.
        </p>

        <table className="acc-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Bin</th>
              <th className="num">Expected</th>
              <th className="num">Counted</th>
              <th className="num">Difference</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={5} className="acc-empty">
                {onlyLeft ? "Every line on this sheet has been counted." : "Nothing matches."}
              </td></tr>
            )}
            {shown.map((l) => {
              const v = l.counted_qty == null ? null : l.counted_qty - l.expected_qty;
              return (
                <tr key={l.product_id} className="acc-row">
                  <td>
                    <span className="acc-name">{l.name}</span>
                    <span className="acc-sub">{l.sku ?? "—"}</span>
                  </td>
                  <td className="quiet">{l.bin ?? "—"}</td>
                  <td className="num quiet">{fmtQty(l.expected_qty)} {l.unit_code}</td>
                  <td className="num">
                    <input
                      className="modal-input"
                      style={{ maxWidth: 96, textAlign: "right" }}
                      inputMode="decimal"
                      aria-label={`Counted ${l.name}`}
                      value={typed.get(l.product_id) ?? (l.counted_qty ?? "").toString()}
                      onChange={(e) => {
                        const next = new Map(typed);
                        next.set(l.product_id, e.target.value);
                        setTyped(next);
                      }}
                      ref={(el) => { boxes.current.set(l.product_id, el); }}
                      onBlur={(e) => void record(l, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        (e.target as HTMLInputElement).blur();
                        // Back to the scan box, or the next scan lands here
                        // and silently miscounts the item just entered.
                        finder.current?.focus();
                      }}
                    />
                  </td>
                  <td className={`num${v ? " is-bad" : ""}`}>
                    {v == null ? "—" : v === 0 ? "agrees" : `${v > 0 ? "+" : ""}${fmtQty(v)}`}
                    {v != null && v !== 0 && l.variance_value != null && (
                      <span className="acc-sub">
                        {l.variance_value < 0
                          ? `${money(-l.variance_value)} gone`
                          : `${money(l.variance_value)} found`}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="modal-actions">
          <button
            className="btn-line quiet"
            disabled={busy || !online}
            onClick={() => {
              setBusy(true);
              void abandonStockCount(pin, open.id)
                .then(async () => {
                  setOpen(null); setLines(null); await load();
                })
                .catch((e) => setError(errorMessage(e, "That count could not be abandoned")))
                .finally(() => setBusy(false));
            }}
          >
            Abandon
          </button>
          <button className="btn-fill" disabled={busy || counted === 0 || !online} onClick={() => void post()}>
            {busy
              ? "Posting…"
              : `Post ${variances.length} ${variances.length === 1 ? "correction" : "corrections"}`
                + (shortValue > 0 ? ` · ${money(shortValue)} off the books` : "")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {banner && <p className="acc-note is-good">{banner}</p>}
      {error && <p className="acc-note is-bad">{error}</p>}

      <div className="stock-receive-bar">
        <select
          className="acc-search"
          value={newDept}
          onChange={(e) => setNewDept(e.target.value)}
          aria-label="Department to count"
        >
          <option value="">Everything</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button
          className="btn-fill"
          disabled={busy || !online}
          onClick={() => {
            setBusy(true);
            setError(null);
            void openStockCount(pin, newDept || null, null)
              .then(async () => { await load(); })
              .catch((e) => setError(errorMessage(e, "That count could not be started")))
              .finally(() => setBusy(false));
          }}
        >
          Start a count
        </button>
      </div>
      <p className="acc-note">
        One department at a time is how it is actually done: somebody walks
        Plumbing with the tablet on a Tuesday morning. Nothing on the shelves
        moves until the sheet is posted, and a sale rung up while you count
        still counts.
      </p>

      <table className="acc-table">
        <thead>
          <tr>
            <th>Sheet</th>
            <th>What</th>
            <th className="num">Counted</th>
            <th className="num">Differences</th>
            <th className="num" />
          </tr>
        </thead>
        <tbody>
          {counts === null && <tr><td colSpan={5} className="acc-empty">Looking…</td></tr>}
          {counts !== null && counts.length === 0 && (
            <tr><td colSpan={5} className="acc-empty">
              No stock take yet. Start one above.
            </td></tr>
          )}
          {(counts ?? []).map((c) => (
            <tr
              key={c.id}
              className={`acc-row${c.status !== "open" ? " is-quiet" : ""}`}
              onClick={() => c.status === "open" && void loadLines(c)}
            >
              <td>
                <span className="acc-name">{c.doc_number}</span>
                <span className="acc-sub">
                  {fmtDayMonthTime(c.started_at)}
                  {c.started_by_name ? ` · ${c.started_by_name}` : ""}
                </span>
              </td>
              <td>
                {c.department ?? "Everything"}
                {c.status !== "open" && (
                  <span className="acc-sub">
                    {c.status === "posted"
                      ? `posted${c.posted_by_name ? ` by ${c.posted_by_name}` : ""}`
                      : "abandoned"}
                  </span>
                )}
              </td>
              <td className="num quiet">{c.counted} of {c.lines}</td>
              <td className={`num${c.variances > 0 ? " is-bad" : ""}`}>
                {c.variances}
                {/* What the sheet cost the shop. A count that only ever said
                    "12 differences" gave an owner nothing to act on. */}
                {c.short_value > 0 && (
                  <span className="acc-sub">{money(c.short_value)} short</span>
                )}
              </td>
              <td className="num">
                {c.status === "open" && (
                  <button className="btn-line" onClick={() => void loadLines(c)}>
                    Continue
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
