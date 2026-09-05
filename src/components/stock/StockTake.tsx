import { useCallback, useEffect, useMemo, useState } from "react";
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

  const counted = lines?.filter((l) => l.counted_qty != null).length ?? 0;
  const variances = lines?.filter(
    (l) => l.counted_qty != null && l.counted_qty !== l.expected_qty
  ) ?? [];

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
            } corrected, ${fmtQty(r.units_down)} short and ${fmtQty(r.units_up)} over.`
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
            className="acc-search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Find a line by name, code or bin"
            aria-label="Find a line on this sheet"
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
          {variances.length} {variances.length === 1 ? "difference" : "differences"}.
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
                      onBlur={(e) => void record(l, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                    />
                  </td>
                  <td className={`num${v ? " is-bad" : ""}`}>
                    {v == null ? "—" : v === 0 ? "agrees" : `${v > 0 ? "+" : ""}${fmtQty(v)}`}
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
            {busy ? "Posting…" : `Post ${variances.length} ${variances.length === 1 ? "correction" : "corrections"}`}
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
              <td className={`num${c.variances > 0 ? " is-bad" : ""}`}>{c.variances}</td>
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
