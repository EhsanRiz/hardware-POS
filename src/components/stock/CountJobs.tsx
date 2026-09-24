import { useCallback, useEffect, useState } from "react";
import { fetchUnits } from "../../lib/adminApi";
import { fetchCategories } from "../../lib/api";
import {
  abandonCountJob,
  countJobCounted,
  countJobCounters,
  countJobNewItems,
  countJobs,
  openCountJob,
  postCountJob,
  removeCountCounter,
  reviewNewItem,
  setCountJoining,
  type CountCounter,
  type CountedLine,
  type CountJob,
  type CountNewItemRow,
  type NewItemDecision,
} from "../../lib/countApi";
import { fmtDayMonthTime } from "../../lib/dates";
import { errorMessage } from "../../lib/errors";
import { fmtQty } from "../../lib/receipt";
import type { Category, Product, UnitOfMeasure } from "../../lib/types";

/**
 * A count done by people from outside the shop (migration 0114).
 *
 * 4D sends two people to walk the shelves of a shop coming onto the Till —
 * or any shop, any time the stock needs counting from scratch. They are not
 * staff and get no login: the manager starts a count here and reads out the
 * code, and each of them joins on their own phone at /count. Their phones
 * see names and barcodes, never a price.
 *
 * What comes back is reviewed here:
 *
 *   - ITEMS THE SHOP HAS: what was counted, what the till says now, and what
 *     posting will make it — counted, plus whatever has sold or arrived since
 *     it was counted, so a sale in the middle of the count still counts.
 *   - NEW ITEMS: things the catalogue did not know. Price one to put it on
 *     sale, leave it to be added hidden, merge it into what it really is, or
 *     skip it.
 *
 * Posting does all of it at once. Nothing on a shelf moves before that.
 */
export default function CountJobs({
  pin,
  online,
  products,
}: {
  pin: string;
  online: boolean;
  /** The catalogue, for "this new item is really that one". */
  products: Product[];
}) {
  const [jobs, setJobs] = useState<CountJob[] | null>(null);
  const [counters, setCounters] = useState<CountCounter[]>([]);
  const [counted, setCounted] = useState<CountedLine[]>([]);
  const [fresh, setFresh] = useState<CountNewItemRow[]>([]);
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [departments, setDepartments] = useState<Category[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [confirmPost, setConfirmPost] = useState(false);

  const open = jobs?.find((j) => j.status === "open") ?? null;
  const openId = open?.id ?? null;

  const load = useCallback(async () => {
    setError(null);
    try {
      const js = await countJobs(pin);
      setJobs(js);
      const o = js.find((j) => j.status === "open");
      if (o) {
        const [k, c, n] = await Promise.all([
          countJobCounters(pin, o.id),
          countJobCounted(pin, o.id),
          countJobNewItems(pin, o.id),
        ]);
        setCounters(k);
        setCounted(c);
        setFresh(n);
      } else {
        setCounters([]);
        setCounted([]);
        setFresh([]);
      }
    } catch (e) {
      setError(errorMessage(e, "Could not load the counts"));
    }
  }, [pin]);

  useEffect(() => {
    void load();
    void fetchUnits().then(setUnits).catch(() => {});
    void fetchCategories().then(setDepartments).catch(() => {});
  }, [load]);

  async function act(what: () => Promise<unknown>, fail: string, done?: string) {
    setBusy(true);
    setError(null);
    setBanner(null);
    try {
      await what();
      if (done) setBanner(done);
      await load();
    } catch (e) {
      setError(errorMessage(e, fail));
    } finally {
      setBusy(false);
    }
  }

  const link = `${location.origin}/count`;

  if (jobs === null) {
    return (
      <div className="space-y-3">
        {error && <p className="acc-note is-bad">{error}</p>}
        <p className="acc-note">Looking…</p>
      </div>
    );
  }

  const unitName = (code: string) => units.find((u) => u.code === code)?.name ?? code;
  const pending = fresh.filter((n) => n.decision === "pending" && n.captures > 0).length;

  return (
    <div className="space-y-3">
      {banner && <p className="acc-note is-good" role="status">{banner}</p>}
      {error && <p className="acc-note is-bad" role="alert">{error}</p>}

      {!open && (
        <>
          <p className="acc-note">
            For a count by people who do not work here — 4D&apos;s counters, on
            their own phones. Start it here and read them the code; they open{" "}
            <strong>{link}</strong> and type it with their name. They see what
            the shop sells by name and barcode, never a price, and they can
            write down anything the shop has not listed yet.
          </p>
          <div className="stock-receive-bar">
            <input
              className="modal-input"
              style={{ marginBottom: 0, maxWidth: 420 }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What is this count? e.g. Opening count"
              aria-label="What is this count"
            />
            <button
              className="btn-fill"
              disabled={busy || !online}
              onClick={() =>
                void act(
                  () => openCountJob(pin, note.trim() || null),
                  "The count could not be started"
                ).then(() => setNote(""))
              }
            >
              Start a count
            </button>
          </div>
        </>
      )}

      {open && (
        <section className="count-job" aria-label="Open count">
          <div className="count-job-code">
            <div>
              <span className="acc-sub">
                {open.doc_number}
                {open.note ? ` · ${open.note}` : ""}
              </span>
              <span className="count-job-big" aria-label="Count code">
                {open.join_code
                  ? `${open.join_code.slice(0, 4)}-${open.join_code.slice(4)}`
                  : "—"}
              </span>
              <span className="acc-sub">
                {open.joining_open
                  ? <>Counters open <strong>{link}</strong> and type this code.</>
                  : "Closed to new counters. Those already on it carry on."}
              </span>
            </div>
            <div className="count-job-actions">
              <button className="btn-line" disabled={busy} onClick={() => void load()}>
                Refresh
              </button>
              <button
                className="btn-line"
                disabled={busy || !online}
                onClick={() =>
                  void act(
                    () => setCountJoining(pin, open.id, !open.joining_open),
                    "Could not change that"
                  )
                }
              >
                {open.joining_open ? "Let nobody else join" : "Let more people join"}
              </button>
            </div>
          </div>

          <h3 className="count-job-h">Counting · {counters.length}</h3>
          {counters.length === 0 ? (
            <p className="acc-note">Nobody has joined yet.</p>
          ) : (
            <table className="acc-table">
              <tbody>
                {counters.map((k) => (
                  <tr key={k.id} className={k.active ? "" : "is-quiet"}>
                    <td>
                      <span className="acc-name">{k.name}</span>
                      <span className="acc-sub">
                        joined {fmtDayMonthTime(k.joined_at)}
                        {k.last_seen_at ? ` · last sent ${fmtDayMonthTime(k.last_seen_at)}` : ""}
                        {k.active ? "" : " · taken off"}
                      </span>
                    </td>
                    <td className="num">{k.captures} counts</td>
                    <td className="num">
                      {k.active && (
                        <button
                          className="btn-line quiet"
                          disabled={busy || !online}
                          aria-label={`Take ${k.name} off the count`}
                          onClick={() =>
                            void act(
                              () => removeCountCounter(pin, k.id),
                              "Could not take them off",
                              `${k.name} is off the count. What they sent stays.`
                            )
                          }
                        >
                          Take off
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className="count-job-h">Items the shop has · {counted.length}</h3>
          {counted.length === 0 ? (
            <p className="acc-note">Nothing counted yet.</p>
          ) : (
            <table className="acc-table" aria-label="Counted items">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Counted</th>
                  <th className="num">On the till now</th>
                  <th className="num">Will become</th>
                </tr>
              </thead>
              <tbody>
                {counted.map((l) => (
                  <tr key={l.product_id}>
                    <td>
                      <span className="acc-name">{l.name}</span>
                      <span className="acc-sub">
                        {l.locations ?? "—"} · {l.counters}
                      </span>
                    </td>
                    <td className="num">{fmtQty(l.counted)} {unitName(l.unit_code)}</td>
                    <td className="num quiet">
                      {l.on_hand == null ? "not tracked" : fmtQty(l.on_hand)}
                    </td>
                    <td className="num">
                      {fmtQty(l.becomes)}
                      {l.since !== 0 && (
                        <span className="acc-sub">
                          {l.since > 0 ? "+" : ""}
                          {fmtQty(l.since)} since it was counted
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className="count-job-h">
            New items · {fresh.filter((n) => n.decision !== "skip").length}
          </h3>
          {fresh.length === 0 ? (
            <p className="acc-note">Nothing new has turned up.</p>
          ) : (
            <ul className="count-job-new">
              {fresh.map((n) => (
                <NewItemReviewRow
                  key={n.id}
                  item={n}
                  others={fresh.filter((o) => o.id !== n.id && o.decision !== "merge")}
                  products={products}
                  units={units}
                  departments={departments}
                  busy={busy || !online}
                  onSave={(r) =>
                    act(() => reviewNewItem(pin, n.id, r), "That could not be saved")
                  }
                />
              ))}
            </ul>
          )}

          <div className="count-job-post">
            {confirmPost ? (
              <>
                <p className="acc-note">
                  Posting sets {counted.length} item{counted.length === 1 ? "" : "s"} to
                  what was counted
                  {fresh.some((n) => n.decision === "add" || n.decision === "pending")
                    ? " and adds the new items to the catalogue"
                    : ""}
                  {pending > 0 ? ` — ${pending} of them hidden, with no price yet` : ""}.
                  The counters&apos; phones stop working. This cannot be undone here.
                </p>
                <button
                  className="btn-fill"
                  disabled={busy || !online}
                  onClick={() =>
                    void act(async () => {
                      const r = await postCountJob(pin, open.id);
                      setConfirmPost(false);
                      setBanner(
                        `${open.doc_number} posted: ${r.products_counted} item` +
                          `${r.products_counted === 1 ? "" : "s"} counted, ` +
                          `${r.products_created} added to the catalogue` +
                          (r.created_hidden ? ` (${r.created_hidden} hidden until priced)` : "") +
                          "."
                      );
                    }, "The count could not be posted")
                  }
                >
                  Yes, post {open.doc_number}
                </button>{" "}
                <button className="btn-cancel" onClick={() => setConfirmPost(false)}>
                  Not yet
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn-fill"
                  disabled={busy || !online}
                  onClick={() => setConfirmPost(true)}
                >
                  Post the count
                </button>{" "}
                <button
                  className="btn-line quiet"
                  disabled={busy || !online}
                  onClick={() =>
                    void act(
                      () => abandonCountJob(pin, open.id),
                      "The count could not be abandoned",
                      `${open.doc_number} abandoned. Nothing moved.`
                    )
                  }
                >
                  Abandon
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {jobs.some((j) => j.status !== "open") && (
        <table className="acc-table" aria-label="Earlier counts">
          <thead>
            <tr>
              <th>Count</th>
              <th className="num">Items</th>
              <th className="num">New</th>
            </tr>
          </thead>
          <tbody>
            {jobs.filter((j) => j.status !== "open").map((j) => (
              <tr key={j.id} className="is-quiet">
                <td>
                  <span className="acc-name">{j.doc_number}{j.note ? ` · ${j.note}` : ""}</span>
                  <span className="acc-sub">
                    {fmtDayMonthTime(j.opened_at)} ·{" "}
                    {j.status === "posted"
                      ? `posted${j.posted_by_name ? ` by ${j.posted_by_name}` : ""}`
                      : "abandoned"}
                  </span>
                </td>
                <td className="num">{j.products_counted}</td>
                <td className="num">{j.new_items}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {openId === null && jobs.length === 0 && (
        <p className="acc-note">No counts yet.</p>
      )}
    </div>
  );
}

const DECISIONS: { value: NewItemDecision; label: string }[] = [
  { value: "pending", label: "Add hidden, price later" },
  { value: "add", label: "Put on sale" },
  { value: "merge", label: "Same as…" },
  { value: "skip", label: "Not stock — skip" },
];

function NewItemReviewRow({
  item,
  others,
  products,
  units,
  departments,
  busy,
  onSave,
}: {
  item: CountNewItemRow;
  others: CountNewItemRow[];
  products: Product[];
  units: UnitOfMeasure[];
  departments: Category[];
  busy: boolean;
  onSave: (r: Parameters<typeof reviewNewItem>[2]) => Promise<void>;
}) {
  const [decision, setDecision] = useState<NewItemDecision>(item.decision);
  const [name, setName] = useState(item.name);
  const [barcode, setBarcode] = useState(item.barcode ?? "");
  const [unit, setUnit] = useState(item.unit_code);
  const [dept, setDept] = useState(item.category_id ?? "");
  const [price, setPrice] = useState(item.price_retail == null ? "" : String(item.price_retail));
  const [target, setTarget] = useState(
    item.merge_into ? `n:${item.merge_into}` : item.merge_product ? `p:${item.merge_product}` : ""
  );

  const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));
  const unitName = units.find((u) => u.code === item.unit_code)?.name ?? item.unit_code;
  const where = [item.locations, item.counters].filter(Boolean).join(" · ");

  return (
    <li className="count-job-item" aria-label={`New item ${item.name}`}>
      <div className="count-job-item-head">
        <span className="acc-name">{item.name}</span>
        <span className="num">{fmtQty(item.counted)} {unitName}</span>
      </div>
      <span className="acc-sub">
        {item.barcode ?? "no barcode"}
        {where ? ` · ${where}` : ""}
        {item.captures === 0 ? " · every count of it was taken back" : ""}
      </span>
      <div className="count-job-item-form">
        <select
          className="modal-input"
          value={decision}
          onChange={(e) => setDecision(e.target.value as NewItemDecision)}
          aria-label={`What to do with ${item.name}`}
        >
          {DECISIONS.map((d) => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>
        {decision === "merge" ? (
          <select
            className="modal-input"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            aria-label={`${item.name} is the same as`}
          >
            <option value="">Choose what it really is…</option>
            {others.length > 0 && (
              <optgroup label="New on this count">
                {others.map((o) => (
                  <option key={o.id} value={`n:${o.id}`}>{o.name}</option>
                ))}
              </optgroup>
            )}
            <optgroup label="Already in the shop">
              {products.map((p) => (
                <option key={p.id} value={`p:${p.id}`}>{p.name}</option>
              ))}
            </optgroup>
          </select>
        ) : decision !== "skip" ? (
          <>
            <input
              className="modal-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label={`Name for ${item.name}`}
            />
            <input
              className="modal-input"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder="Barcode"
              aria-label={`Barcode for ${item.name}`}
            />
            <select
              className="modal-input"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              aria-label={`Unit for ${item.name}`}
            >
              {(units.length ? units : [{ code: unit, name: unit }]).map((u) => (
                <option key={u.code} value={u.code}>{u.name}</option>
              ))}
            </select>
            <select
              className="modal-input"
              value={dept}
              onChange={(e) => setDept(e.target.value)}
              aria-label={`Department for ${item.name}`}
            >
              <option value="">No department</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <input
              className="modal-input"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              placeholder="Price"
              aria-label={`Price for ${item.name}`}
            />
          </>
        ) : null}
        <button
          className="btn-line"
          disabled={busy}
          onClick={() =>
            void onSave({
              decision,
              name,
              barcode: barcode.trim(),
              unit_code: unit,
              category_id: dept || null,
              price_retail: num(price),
              price_trade: item.price_trade,
              cost: item.cost,
              merge_into: target.startsWith("n:") ? target.slice(2) : null,
              merge_product: target.startsWith("p:") ? target.slice(2) : null,
            })
          }
        >
          Save
        </button>
      </div>
      {item.decision !== "pending" && (
        <span className="acc-sub count-job-said">
          {item.decision === "add"
            ? "Goes on sale when the count is posted."
            : item.decision === "skip"
              ? "Skipped: not stock."
              : `Counted as ${item.merge_product_name ?? others.find((o) => o.id === item.merge_into)?.name ?? "another item"}.`}
        </span>
      )}
    </li>
  );
}
