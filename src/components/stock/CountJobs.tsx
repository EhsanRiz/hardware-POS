import { useCallback, useEffect, useState } from "react";
import { adminSaveProduct, fetchUnits, type ProductInput } from "../../lib/adminApi";
import { fetchCategories } from "../../lib/api";
import {
  abandonCountJob,
  countJobCounted,
  countJobCounters,
  countJobNewItems,
  countJobs,
  linkNewItem,
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
import { imageSrc } from "../../lib/images";
import { money } from "../../lib/money";
import { can } from "../../lib/permissions";
import { fmtQty } from "../../lib/receipt";
import { useAuth } from "../../context/AuthContext";
import ProductEditor from "../ProductEditor";
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
 *   - NEW ITEMS: things the catalogue did not know. Its name opens the
 *     ordinary product form, and saving puts it in the catalogue there and
 *     then (0116) — nobody waits for the counters to finish to start selling
 *     it. Or: merge it into what it really is, skip it, or leave it to be
 *     added hidden at posting.
 *
 * The screen refreshes itself every few seconds while a count is open.
 * Posting waits for every counter to say they are done (0115), and it is
 * posting that sets the stock: nothing on a shelf moves before that.
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
  /** The new item whose catalogue form is open (0116). */
  const [cataloguing, setCataloguing] = useState<CountNewItemRow | null>(null);
  const { user } = useAuth();

  const open = jobs?.find((j) => j.status === "open") ?? null;
  const openId = open?.id ?? null;

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setError(null);
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
      // A background refresh that misses keeps what is on screen.
      if (!quiet) setError(errorMessage(e, "Could not load the counts"));
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

  /**
   * Live while a count is open: what the counters send shows up on its own,
   * every few seconds, with no Refresh to press. Paused while something here
   * is being done — a form open, a save on its way — so the screen does not
   * move under the owner's hand, and while the tab is out of sight.
   */
  useEffect(() => {
    if (!openId || !online || busy || cataloguing || confirmPost) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 5000);
    return () => clearInterval(t);
  }, [openId, online, busy, cataloguing, confirmPost, load]);

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
  // 0115: posting waits for everybody still on the count to say they are done.
  const stillCounting = counters.filter((k) => k.active && !k.finished_at);
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
            <table className="acc-table" aria-label="Counters">
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
                    <td>
                      {k.active && (k.finished_at
                        ? <span className="count-job-said">done</span>
                        : <span className="acc-sub">still counting</span>)}
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
                  busy={busy || !online}
                  onSave={(r) =>
                    act(() => reviewNewItem(pin, n.id, r), "That could not be saved")
                  }
                  onCatalogue={() => setCataloguing(n)}
                />
              ))}
            </ul>
          )}

          <div className="count-job-post">
            {stillCounting.length > 0 && (
              <p className="acc-note" role="status" aria-label="Waiting for">
                Waiting for {stillCounting.map((k) => k.name).join(", ")} to say
                they are done on their phone. The count can be posted once
                everybody has — or take a lost phone off the count.
              </p>
            )}
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
                          (r.photos ? `, ${r.photos} photo${r.photos === 1 ? "" : "s"} added` : "") +
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
                  disabled={busy || !online || stillCounting.length > 0}
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
      {cataloguing && (
        <ProductEditor
          pin={pin}
          product={null}
          categories={departments}
          units={units}
          canSeeCost={can(user, "view_cost_prices")}
          initial={{
            name: cataloguing.name,
            barcode: cataloguing.barcode,
            unit_code: cataloguing.unit_code,
            category_id: cataloguing.category_id,
          }}
          fromCount={{ photos: cataloguing.photos }}
          onSave={async (f: ProductInput) => {
            const item = cataloguing;
            // Counted in the counter's unit: sold in another, the stock would
            // be out by a pack size. Said here, before a product exists.
            if (f.unit_code !== item.unit_code) {
              const counted = units.find((u) => u.code === item.unit_code)?.name ?? item.unit_code;
              throw new Error(
                `${item.name} was counted in ${counted.toLowerCase()} — sell it the same way, or ask the counter to recount it`
              );
            }
            // Tracked from zero; posting sets it to what was counted.
            const id = await adminSaveProduct(pin, { ...f, id: null, stock_qty: 0 });
            await linkNewItem(pin, item.id, id);
            setCataloguing(null);
            setBanner(`${f.name} is in the catalogue${f.active ? " and on sale" : ""}. Its stock arrives when the count is posted.`);
            await load();
          }}
          onDelete={async () => {}}
          onClose={() => setCataloguing(null)}
        />
      )}
    </div>
  );
}

const DECISIONS: { value: NewItemDecision; label: string }[] = [
  { value: "pending", label: "Leave for now" },
  { value: "merge", label: "Same as…" },
  { value: "skip", label: "Not stock — skip" },
];

/**
 * One thing the catalogue did not know.
 *
 * Its name opens the catalogue form (0116): that is where it is priced and
 * put on sale, now, with the whole form rather than a price box squeezed into
 * a row. What stays on the row is what the form cannot say: that this is
 * really something else ("Same as…"), or not stock at all. Left alone, it is
 * added hidden when the count is posted, so counted stock is never lost.
 */
function NewItemReviewRow({
  item,
  others,
  products,
  units,
  busy,
  onSave,
  onCatalogue,
}: {
  item: CountNewItemRow;
  others: CountNewItemRow[];
  products: Product[];
  units: UnitOfMeasure[];
  busy: boolean;
  onSave: (r: Parameters<typeof reviewNewItem>[2]) => Promise<void>;
  onCatalogue: () => void;
}) {
  const linked = item.decision === "merge" && item.merge_product != null;
  const [decision, setDecision] = useState<NewItemDecision>(
    item.decision === "add" ? "pending" : item.decision
  );
  const [target, setTarget] = useState(
    item.merge_into ? `n:${item.merge_into}` : item.merge_product ? `p:${item.merge_product}` : ""
  );

  const unitName = units.find((u) => u.code === item.unit_code)?.name ?? item.unit_code;
  const where = [item.locations, item.counters].filter(Boolean).join(" · ");

  return (
    <li className="count-job-item" aria-label={`New item ${item.name}`}>
      <div className="count-job-item-head">
        {linked ? (
          <span className="acc-name">{item.name}</span>
        ) : (
          <button
            type="button"
            className="count-job-name"
            disabled={busy}
            onClick={onCatalogue}
            aria-label={`Add ${item.name} to the catalogue`}
          >
            {item.name}
          </button>
        )}
        <span className="num">{fmtQty(item.counted)} {unitName}</span>
      </div>
      <span className="acc-sub">
        {item.barcode ?? "no barcode"}
        {where ? ` · ${where}` : ""}
        {item.captures === 0 ? " · every count of it was taken back" : ""}
      </span>
      {item.photos.length > 0 && (
        <ul className="count-job-thumbs" aria-label={`Photos of ${item.name}`}>
          {item.photos.map((p) => (
            <li key={p}>
              <a href={imageSrc(p) ?? undefined} target="_blank" rel="noreferrer">
                <img src={imageSrc(p) ?? undefined} alt={item.name} />
              </a>
            </li>
          ))}
        </ul>
      )}
      {linked ? (
        <span className="acc-sub count-job-said">
          In the catalogue as {item.merge_product_name}
          {item.merge_product_price != null ? ` · ${money(item.merge_product_price)}` : ""}
          {item.merge_product_active === false ? " · hidden" : " · on sale"}. Its stock
          arrives when the count is posted.
        </span>
      ) : (
        <>
          <div className="count-job-item-form">
            <button type="button" className="btn-line" disabled={busy} onClick={onCatalogue}>
              Add to the catalogue…
            </button>
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
            {decision === "merge" && (
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
            )}
            <button
              className="btn-line"
              disabled={busy}
              onClick={() =>
                void onSave({
                  decision,
                  name: item.name,
                  barcode: null,
                  unit_code: item.unit_code,
                  category_id: item.category_id,
                  price_retail: item.price_retail,
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
          <span className="acc-sub count-job-said">
            {item.decision === "skip"
              ? "Skipped: not stock."
              : item.decision === "merge"
                ? `Counted as ${others.find((o) => o.id === item.merge_into)?.name ?? "another item"}.`
                : item.decision === "add"
                  ? "Goes on sale when the count is posted."
                  : "Not in the catalogue yet — added hidden when the count is posted, unless you add it now."}
          </span>
        </>
      )}
    </li>
  );
}
