import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ScanButton from "../components/ScanButton";
import { joinCount, type CountUnit } from "../lib/countApi";
import {
  addCapture,
  getCaptures,
  getSession,
  getState,
  leaveSession,
  onCountChange,
  refreshState,
  setLocation,
  startSession,
  syncCaptures,
  undoCapture,
  type LocalCapture,
} from "../lib/countStore";
import { errorMessage } from "../lib/errors";
import { onNetworkChange, useOnline } from "../lib/offline";
import { normalizeSearchText } from "../lib/search";
import "../styles/count.css";

/**
 * The counting phone — what 4D's people carry round a shop.
 *
 * Opened at /count, apart from the till: nothing here pairs a device, signs
 * anybody in, or can reach a price. A counter types the code the shop's
 * manager read out and their own name, and from then on the phone does three
 * things, all with one thumb:
 *
 *   1. Say where you are ("Aisle 3"). It stays until you change it.
 *   2. Find the thing — scan it, or type part of its name.
 *   3. Say how many. Next.
 *
 * Something the shop's catalogue does not know is written down by name (and
 * barcode, if it has one) and counted all the same; the shop prices it later.
 * Every count is kept on the phone first and sent when there is signal, so a
 * dead corner of the storeroom does not stop anybody.
 */
export default function CountApp() {
  const [session, setSession] = useState(getSession);
  const [state, setState] = useState(getState);
  const [captures, setCaptures] = useState(getCaptures);

  useEffect(
    () =>
      onCountChange(() => {
        setSession(getSession());
        setState(getState());
        setCaptures(getCaptures());
      }),
    []
  );

  // Signal back: send what is waiting and learn what the other counters met.
  useEffect(
    () =>
      onNetworkChange((up) => {
        if (up) {
          void syncCaptures();
          void refreshState();
        }
      }),
    []
  );

  const hasSession = !!session;
  useEffect(() => {
    if (!hasSession) return;
    void refreshState();
    void syncCaptures();
    // The other phone keeps meeting new things; a minute is soon enough.
    const t = setInterval(() => void refreshState(), 60_000);
    // Anything unsent is tried again on its own clock. Waiting for the line
    // to be declared back is not enough: a signal that flickers can come and
    // go without the connection check ever calling it down, and then there
    // is no "back" to wait for.
    const retry = setInterval(() => {
      if (getCaptures().some((c) => c.state === "waiting" || c.state === "voiding")) {
        void syncCaptures();
      }
    }, 10_000);
    return () => {
      clearInterval(t);
      clearInterval(retry);
    };
  }, [hasSession]);

  if (!session) return <Join />;
  if (session.ended) {
    return (
      <Ended
        reason={session.ended}
        unsent={captures.filter((c) => c.state !== "sent").length}
      />
    );
  }
  return (
    <Counting
      shop={session.shop_name}
      doc={session.doc_number}
      who={session.counter_name}
      location={session.location}
      state={state}
      captures={captures}
    />
  );
}

function Join() {
  const [code, setCode] = useState(() => {
    try {
      return new URLSearchParams(location.search).get("c") ?? "";
    } catch {
      return "";
    }
  });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      startSession(await joinCount(code, name));
    } catch (e) {
      setError(errorMessage(e, "Could not join that count"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="count-app">
      <h1 className="count-title">Stock count</h1>
      <p className="count-lede">
        Type the code the shop gave you, and your name, so the shop knows who
        counted what.
      </p>
      <form
        className="count-join"
        onSubmit={(e) => {
          e.preventDefault();
          void join();
        }}
      >
        <label className="count-label">
          Count code
          <input
            className="modal-input count-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="ABCD-EFGH"
          />
        </label>
        <label className="count-label">
          Your name
          <input
            className="modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        </label>
        {error && <p className="acc-note is-bad" role="alert">{error}</p>}
        <button
          type="submit"
          className="btn-line count-go"
          disabled={busy || !code.trim() || !name.trim()}
        >
          {busy ? "Joining…" : "Start counting"}
        </button>
      </form>
    </main>
  );
}

function Ended({ reason, unsent }: { reason: string; unsent: number }) {
  return (
    <main className="count-app">
      <h1 className="count-title">{reason}</h1>
      <p className="count-lede">
        This phone can no longer send counts to the shop.
        {unsent > 0 &&
          ` ${unsent} count${unsent === 1 ? " was" : "s were"} not sent — tell the shop's manager.`}
      </p>
      <button type="button" className="btn-line count-go" onClick={leaveSession}>
        Join another count
      </button>
    </main>
  );
}

/** One thing a counter can pick: an item the shop has, or one this count met. */
interface Pick {
  key: string;
  product_id: string | null;
  new_item_id: string | null;
  name: string;
  barcode: string | null;
  sku: string | null;
  unit_code: string;
  /** Met on this count, not in the shop's catalogue. */
  fresh: boolean;
}

type Sheet =
  | { kind: "count"; pick: Pick }
  | { kind: "new"; name: string; barcode: string };

function Counting({
  shop,
  doc,
  who,
  location,
  state,
  captures,
}: {
  shop: string;
  doc: string;
  who: string;
  location: string;
  state: ReturnType<typeof getState>;
  captures: LocalCapture[];
}) {
  const online = useOnline();
  const [term, setTerm] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const finder = useRef<HTMLInputElement | null>(null);

  const units = useMemo(() => state?.units ?? [], [state]);
  const unitOf = useCallback(
    (code: string): CountUnit =>
      units.find((u) => u.code === code) ?? { code, name: code, allows_fraction: false },
    [units]
  );

  // Everything findable: the shop's items, the new ones the server knows,
  // and new ones this phone wrote down that have not reached it yet.
  const picks = useMemo<Pick[]>(() => {
    const out: Pick[] = [];
    for (const p of state?.products ?? []) {
      out.push({
        key: `p:${p.id}`, product_id: p.id, new_item_id: null, name: p.name,
        barcode: p.barcode, sku: p.sku, unit_code: p.unit_code, fresh: false,
      });
    }
    const seen = new Set<string>();
    for (const n of state?.new_items ?? []) {
      seen.add(n.id);
      out.push({
        key: `n:${n.id}`, product_id: null, new_item_id: n.id, name: n.name,
        barcode: n.barcode, sku: null, unit_code: n.unit_code, fresh: true,
      });
    }
    const local = new Set<string>();
    for (const c of captures) {
      if (c.product_id || (c.new_item_id && seen.has(c.new_item_id))) continue;
      if (c.new_item_id) {
        seen.add(c.new_item_id);
        out.push({
          key: `n:${c.new_item_id}`, product_id: null, new_item_id: c.new_item_id,
          name: c.label, barcode: c.barcode, sku: null,
          unit_code: c.unit_code ?? "ea", fresh: true,
        });
        continue;
      }
      const k = c.barcode ? `b:${c.barcode}` : `t:${normalizeSearchText(c.label)}|${c.unit_code}`;
      if (local.has(k)) continue;
      local.add(k);
      out.push({
        key: `l:${k}`, product_id: null, new_item_id: null, name: c.label,
        barcode: c.barcode, sku: null, unit_code: c.unit_code ?? "ea", fresh: true,
      });
    }
    return out;
  }, [state, captures]);

  const found = useMemo(() => {
    const q = normalizeSearchText(term);
    if (!q) return [];
    const words = q.split(" ").filter((w) => w && w !== "x");
    return picks
      .filter((p) => {
        const text = normalizeSearchText([p.name, p.sku ?? "", p.barcode ?? ""].join(" "));
        return words.every((w) => text.includes(w));
      })
      .slice(0, 30);
  }, [picks, term]);

  function exact(code: string): Pick | null {
    const raw = code.trim();
    if (!raw) return null;
    return (
      picks.find((p) => p.barcode && p.barcode === raw) ??
      picks.find((p) => p.sku && p.sku.toLowerCase() === raw.toLowerCase()) ??
      null
    );
  }

  /** A scan, or Enter on the find box: an exact code goes straight to "how many". */
  function lookUp(code: string) {
    const raw = code.trim();
    if (!raw) return;
    const hit = exact(raw);
    if (hit) {
      setSheet({ kind: "count", pick: hit });
      setTerm("");
      return;
    }
    // A code nothing carries: something the shop has never heard of.
    if (/^\d{6,14}$/.test(raw)) {
      setSheet({ kind: "new", name: "", barcode: raw });
      setTerm("");
    }
  }

  function saved(text: string) {
    setSheet(null);
    setTerm("");
    setFlash(text);
    finder.current?.focus();
  }

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const waiting = captures.filter((c) => c.state === "waiting" || c.state === "voiding").length;
  const failed = captures.filter((c) => c.state === "failed").length;
  const mine = [...captures].reverse();

  return (
    <main className="count-app">
      <header className="count-head">
        <div>
          <h1 className="count-title">{shop}</h1>
          <p className="count-sub">
            {doc} · counting as {who}
          </p>
        </div>
        <p className="count-sync" role="status" aria-label="Sending">
          {waiting === 0
            ? "All sent"
            : online
              ? `Sending ${waiting}…`
              : `No signal — ${waiting} kept on this phone`}
        </p>
      </header>

      <label className="count-label">
        Where are you?
        <input
          className="modal-input"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Aisle 3, top shelf"
        />
      </label>

      {sheet ? (
        sheet.kind === "count" ? (
          <CountSheet
            pick={sheet.pick}
            unit={unitOf(sheet.pick.unit_code)}
            onCancel={() => setSheet(null)}
            onSave={(qty) => {
              const p = sheet.pick;
              addCapture(
                {
                  product_id: p.product_id,
                  new_item_id: p.new_item_id,
                  // A new item not yet on the server is found again by what
                  // named it the first time.
                  barcode: p.product_id || p.new_item_id ? null : p.barcode,
                  name: p.product_id || p.new_item_id ? null : p.name,
                  unit_code: p.product_id || p.new_item_id ? null : p.unit_code,
                  qty,
                  location: location.trim() || null,
                },
                p.name
              );
              saved(`Saved: ${qty} ${unitOf(p.unit_code).name} — ${p.name}`);
            }}
          />
        ) : (
          <NewItemSheet
            name={sheet.name}
            barcode={sheet.barcode}
            units={units}
            onCancel={() => setSheet(null)}
            onSave={(n) => {
              addCapture(
                {
                  product_id: null,
                  new_item_id: null,
                  barcode: n.barcode || null,
                  name: n.name,
                  unit_code: n.unit_code,
                  qty: n.qty,
                  location: location.trim() || null,
                },
                n.name
              );
              saved(`Saved: ${n.qty} ${unitOf(n.unit_code).name} — ${n.name} (new)`);
            }}
          />
        )
      ) : (
        <section className="count-find">
          <div className="count-find-row">
            <input
              ref={finder}
              className="modal-input"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") lookUp(term);
              }}
              placeholder="Scan, or type a name or barcode"
              aria-label="Find an item"
              autoComplete="off"
            />
            <ScanButton onCode={lookUp} />
          </div>
          {flash && (
            <p className="acc-note is-good" role="status">
              {flash}
            </p>
          )}
          {term.trim() && (
            <ul className="count-results" aria-label="Matches">
              {found.map((p) => (
                <li key={p.key}>
                  <button
                    type="button"
                    className="count-result"
                    onClick={() => setSheet({ kind: "count", pick: p })}
                  >
                    <span>{p.name}</span>
                    <span className="count-result-meta">
                      {p.fresh ? "new on this count · " : ""}
                      {unitOf(p.unit_code).name}
                    </span>
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className="btn-line count-add"
                  onClick={() => {
                    const t = term.trim();
                    const digits = /^\d{6,14}$/.test(t);
                    setSheet({ kind: "new", name: digits ? "" : t, barcode: digits ? t : "" });
                  }}
                >
                  Not in the list — add it
                </button>
              </li>
            </ul>
          )}
          {!term.trim() && (
            <button
              type="button"
              className="btn-line count-add"
              onClick={() => setSheet({ kind: "new", name: "", barcode: "" })}
            >
              Something with no barcode, not in the list
            </button>
          )}
        </section>
      )}

      <section className="count-mine" aria-label="My counts">
        <h2 className="count-h2">
          My counts · {captures.length}
          {failed > 0 && <span className="count-bad"> · {failed} refused</span>}
        </h2>
        {mine.length === 0 && <p className="acc-note">Nothing counted yet.</p>}
        <ul>
          {mine.map((c) => (
            <li key={c.client_ref} className={`count-row is-${c.state}`}>
              <div className="count-row-main">
                <span className="count-row-name">{c.label}</span>
                <span className="count-row-qty">
                  {c.qty} {c.unit_code ? unitOf(c.unit_code).name : ""}
                </span>
              </div>
              <div className="count-row-meta">
                {c.location && <span>{c.location}</span>}
                <span>
                  {c.state === "sent"
                    ? "sent"
                    : c.state === "waiting"
                      ? "waiting to send"
                      : c.state === "voiding"
                        ? "taking back…"
                        : `refused: ${c.error ?? ""}`}
                </span>
                {c.state !== "voiding" && (
                  <button
                    type="button"
                    className="btn-line quiet count-undo"
                    onClick={() => undoCapture(c.client_ref)}
                    aria-label={`Take back ${c.label}`}
                  >
                    {c.state === "failed" ? "Remove" : "Undo"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

/** A quantity as typed, or why it is not one. */
function readQty(raw: string, unit: CountUnit): number | string {
  const t = raw.trim().replace(",", ".");
  if (!t) return "How many are there?";
  const n = Number(t);
  if (!Number.isFinite(n)) return "That is not a number";
  if (n < 0) return "A shelf cannot hold less than nothing";
  if (!unit.allows_fraction && !Number.isInteger(n)) {
    return `${unit.name} is counted in whole numbers`;
  }
  return Math.round(n * 1000) / 1000;
}

function CountSheet({
  pick,
  unit,
  onSave,
  onCancel,
}: {
  pick: Pick;
  unit: CountUnit;
  onSave: (qty: number) => void;
  onCancel: () => void;
}) {
  const [qty, setQty] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="count-sheet"
      onSubmit={(e) => {
        e.preventDefault();
        const q = readQty(qty, unit);
        if (typeof q === "string") setError(q);
        else onSave(q);
      }}
    >
      <h2 className="count-h2">{pick.name}</h2>
      <p className="count-sub">
        {pick.fresh ? "New on this count · " : ""}
        {pick.barcode ?? pick.sku ?? "no barcode"} · counted in {unit.name.toLowerCase()}
      </p>
      <label className="count-label">
        How many here?
        <input
          className="modal-input count-qty"
          value={qty}
          onChange={(e) => {
            setQty(e.target.value);
            setError(null);
          }}
          inputMode={unit.allows_fraction ? "decimal" : "numeric"}
          autoFocus
          aria-label={`How many ${pick.name}`}
        />
      </label>
      {error && <p className="acc-note is-bad" role="alert">{error}</p>}
      <div className="count-sheet-actions">
        <button type="submit" className="btn-line count-go">
          Save count
        </button>
        <button type="button" className="btn-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function NewItemSheet({
  name: startName,
  barcode: startBarcode,
  units,
  onSave,
  onCancel,
}: {
  name: string;
  barcode: string;
  units: CountUnit[];
  onSave: (n: { name: string; barcode: string; unit_code: string; qty: number }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(startName);
  const [barcode, setBarcode] = useState(startBarcode);
  const [unitCode, setUnitCode] = useState("ea");
  const [qty, setQty] = useState("");
  const [error, setError] = useState<string | null>(null);
  const unit = units.find((u) => u.code === unitCode) ?? {
    code: unitCode, name: unitCode, allows_fraction: false,
  };

  return (
    <form
      className="count-sheet"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) {
          setError("Say what it is, as it says on the label");
          return;
        }
        const b = barcode.trim();
        if (b && !/^[0-9A-Za-z-]{4,20}$/.test(b)) {
          setError("That barcode does not look right — leave it empty if there is none");
          return;
        }
        const q = readQty(qty, unit);
        if (typeof q === "string") {
          setError(q);
          return;
        }
        onSave({ name: name.trim(), barcode: b, unit_code: unitCode, qty: q });
      }}
    >
      <h2 className="count-h2">Something the shop has not listed</h2>
      <p className="count-sub">
        Write it down as it says on the label. The shop will price it later.
      </p>
      <label className="count-label">
        What is it?
        <input
          className="modal-input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          autoFocus={!startName}
          placeholder="Cable ties 200mm black, pack of 100"
        />
      </label>
      <label className="count-label">
        Barcode (if it has one)
        <input
          className="modal-input"
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          inputMode="numeric"
        />
      </label>
      <label className="count-label">
        Counted in
        <select
          className="modal-input"
          value={unitCode}
          onChange={(e) => {
            setUnitCode(e.target.value);
            setError(null);
          }}
        >
          {(units.length ? units : [unit]).map((u) => (
            <option key={u.code} value={u.code}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <label className="count-label">
        How many here?
        <input
          className="modal-input count-qty"
          value={qty}
          onChange={(e) => {
            setQty(e.target.value);
            setError(null);
          }}
          inputMode={unit.allows_fraction ? "decimal" : "numeric"}
          autoFocus={!!startName}
          aria-label="How many of the new item"
        />
      </label>
      {error && <p className="acc-note is-bad" role="alert">{error}</p>}
      <div className="count-sheet-actions">
        <button type="submit" className="btn-line count-go">
          Save count
        </button>
        <button type="button" className="btn-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
