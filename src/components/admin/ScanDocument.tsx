import { useEffect, useRef, useState } from "react";
import {
  DOCUMENT_KIND_LABEL,
  fileSupplierDocument,
  matchSupplier,
  readSupplierDocument,
  uploadSupplierPage,
  type ReadDocument,
  type ReadLine,
  type Supplier,
  type SupplierDocumentKind,
} from "../../lib/adminApi";
import { errorMessage } from "../../lib/errors";
import { downscaleImage } from "../../lib/images";
import { money } from "../../lib/money";

/** A page in hand: what will be sent, and what to show meanwhile. */
interface PendingPage {
  mime: string;
  /** The whole data URL, for the upload and the thumbnail. */
  data: string;
}

/** The header, as the manager may correct it before it becomes a record. */
interface Header {
  kind: SupplierDocumentKind;
  doc_number: string;
  doc_date: string;
  subtotal: string;
  tax_total: string;
  total: string;
  note: string;
}

type Stage = "capture" | "reading" | "review";

/**
 * Scanning a supplier's document.
 *
 * The whole point is that nobody types what the page already says. Photograph
 * the pages (or take the PDF the supplier emailed), and the reader returns the
 * letterhead, the header and every line. The manager confirms one screen and
 * it is filed — under the supplier the VAT number matches, or under a new one
 * created from that same letterhead.
 *
 * What a person still does, and must: LOOK at it. A reading of a photograph
 * is a suggestion. Every field on the review screen is editable, the supplier
 * can be pointed somewhere else, and a misread line can be dropped. Filing is
 * a deliberate tap, never a consequence of the reading succeeding.
 *
 * Nothing here touches stock or cost prices. A quote is a promise and an
 * invoice is a purchase; goods on the shelf is the receive step.
 */
export default function ScanDocument({
  pin,
  suppliers,
  forSupplier,
  onClose,
  onFiled,
}: {
  pin: string;
  suppliers: Supplier[];
  /** Opened from a supplier's own page: start pointed at them. */
  forSupplier?: Supplier | null;
  onClose: () => void;
  onFiled: (result: { documentId: string; supplierName: string; created: boolean; lines: number }) => Promise<void>;
}) {
  const [stage, setStage] = useState<Stage>("capture");
  const [pages, setPages] = useState<PendingPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // What the pages said, and what the manager has made of it.
  const [read, setRead] = useState<ReadDocument | null>(null);
  const [lines, setLines] = useState<ReadLine[]>([]);
  const [header, setHeader] = useState<Header>({
    kind: "quote", doc_number: "", doc_date: "", subtotal: "", tax_total: "", total: "", note: "",
  });
  // "" is the letterhead's own supplier (matched or new); otherwise an id.
  const [supplierId, setSupplierId] = useState<string>(forSupplier?.id ?? "");
  const [matched, setMatched] = useState<{ id: string; name: string } | null>(null);

  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    try {
      const next: PendingPage[] = [];
      for (const file of Array.from(files)) {
        if (file.type === "application/pdf") {
          next.push({ mime: file.type, data: await readAsDataUrl(file) });
        } else {
          // Bigger than a shelf photograph: the reader needs the digits in
          // the price column, and those are small print.
          next.push({ mime: "image/jpeg", data: await downscaleImage(file, 2200, 0.88) });
        }
      }
      setPages((p) => [...p, ...next]);
    } catch (e) {
      setError(errorMessage(e, "That file could not be read"));
    } finally {
      if (cameraRef.current) cameraRef.current.value = "";
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  /** Send the pages to be read, then set the review screen from the answer. */
  async function readPages() {
    if (pages.length === 0) return;
    setStage("reading");
    setError(null);
    setWarning(null);
    try {
      const out = await readSupplierDocument(
        pin,
        pages.map((p) => ({ mime: p.mime, data: p.data.replace(/^data:[^,]+,/, "") }))
      );
      applyReading(out);
      setStage("review");
    } catch (e) {
      // A reading that fails is not a document lost: the pages are still in
      // hand, and the same screen takes them typed.
      setError(errorMessage(e, "The pages could not be read"));
      applyReading({ lines: [] });
      setStage("review");
    }
  }

  function applyReading(out: ReadDocument) {
    setRead(out);
    setLines(out.lines ?? []);
    setHeader({
      kind: out.kind ?? "quote",
      doc_number: out.doc_number ?? "",
      doc_date: (out.doc_date ?? "").slice(0, 10),
      subtotal: numText(out.subtotal),
      tax_total: numText(out.tax_total),
      total: numText(out.total),
      note: "",
    });
  }

  // Who this letterhead belongs to. Asked of the server rather than guessed
  // here, so the screen says what the filing will actually do.
  useEffect(() => {
    if (stage !== "review" || forSupplier || !read) return;
    let cancelled = false;
    const vat = read.supplier_vat ?? null;
    const name = read.supplier_name ?? null;
    if (!vat && !name) return;
    void matchSupplier(pin, vat, name)
      .then((m) => {
        if (cancelled) return;
        setMatched(m);
        if (m) setSupplierId(m.id);
      })
      .catch(() => {
        /* the picker still works; the server matches again at filing */
      });
    return () => {
      cancelled = true;
    };
  }, [stage, read, pin, forSupplier]);

  /** Totals worth a second look before this becomes the shop's record. */
  const linesTotal = lines.reduce((t, l) => t + (l.line_total ?? 0), 0);
  const statedSub = Number(header.subtotal.replace(/[^\d.]/g, ""));
  const drift =
    lines.length > 0 && Number.isFinite(statedSub) && statedSub > 0
      ? Math.abs(linesTotal - statedSub)
      : 0;

  async function file() {
    setBusy(true);
    setError(null);
    try {
      const num = (v: string) => {
        const n = Number(v.replace(/[^\d.]/g, ""));
        return v.trim() === "" || !Number.isFinite(n) ? null : n;
      };
      const filed = await fileSupplierDocument(pin, {
        supplier_id: supplierId || null,
        supplier_name: read?.supplier_name ?? null,
        supplier_vat: read?.supplier_vat ?? null,
        supplier_phone: read?.supplier_phone ?? null,
        supplier_email: read?.supplier_email ?? null,
        kind: header.kind,
        doc_number: header.doc_number.trim() || null,
        doc_date: header.doc_date || null,
        subtotal: num(header.subtotal),
        tax_total: num(header.tax_total),
        total: num(header.total),
        note: header.note.trim() || null,
        lines,
        read: lines.length > 0,
      });
      // The pages last, one at a time: the record exists either way, and a
      // dropped line part-way leaves the pages that arrived attached to it.
      for (let i = 0; i < pages.length; i++) {
        setProgress(`Filing page ${i + 1} of ${pages.length}…`);
        await uploadSupplierPage(pin, filed.document_id, pages[i].data);
      }
      await onFiled({
        documentId: filed.document_id,
        supplierName: filed.supplier_name,
        created: filed.supplier_created,
        lines: lines.length,
      });
    } catch (e) {
      setError(errorMessage(e, "The document could not be filed"));
      setBusy(false);
      setProgress(null);
    }
  }

  const newSupplierName = read?.supplier_name?.trim() || "";
  const willCreate = !supplierId && !!newSupplierName;

  return (
    <div className="modal-backdrop" onClick={busy || stage === "reading" ? undefined : onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Scan a document"
        style={{ maxWidth: 720 }}
      >
        <h2 className="modal-title">
          {stage === "review" ? "Check what it says" : "Scan a document"}
        </h2>

        {stage === "capture" && (
          <>
            <p className="acc-note" style={{ marginTop: 0 }}>
              Photograph every page, or add the PDF the supplier emailed. The
              supplier, the number, the date and the lines are read off it —
              you only check them.
            </p>
            <PageStrip pages={pages} onRemove={(i) => setPages((p) => p.filter((_, j) => j !== i))} busy={busy} />
            <div className="flex gap-2 mt-2 flex-wrap">
              <button type="button" className="btn-line" onClick={() => cameraRef.current?.click()}>
                Take photo
              </button>
              <button type="button" className="btn-line" onClick={() => fileRef.current?.click()}>
                Add PDF or photos
              </button>
              <input
                ref={cameraRef} type="file" accept="image/*" capture="environment" multiple
                className="hidden" aria-label="Photograph a page"
                onChange={(e) => void addFiles(e.target.files)}
              />
              <input
                ref={fileRef} type="file" accept="image/*,application/pdf" multiple
                className="hidden" aria-label="Add PDF or photos"
                onChange={(e) => void addFiles(e.target.files)}
              />
            </div>
            {error && <p className="acc-note is-bad" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-line" onClick={onClose}>Cancel</button>
              <button
                type="button" className="btn-line"
                disabled={pages.length === 0}
                onClick={() => { applyReading({ lines: [] }); setStage("review"); }}
              >
                Type it in instead
              </button>
              <button
                type="button" className="btn-fill"
                disabled={pages.length === 0}
                onClick={() => void readPages()}
              >
                Read {pages.length || ""} {pages.length === 1 ? "page" : "pages"}
              </button>
            </div>
          </>
        )}

        {stage === "reading" && (
          <p className="acc-note" role="status" style={{ marginTop: 0 }}>
            Reading {pages.length} {pages.length === 1 ? "page" : "pages"}…
          </p>
        )}

        {stage === "review" && (
          <div className="modal-list" style={{ paddingRight: 2 }}>
            {error && <p className="acc-note is-bad" role="alert">{error}</p>}
            {warning && <p className="acc-note is-warning">{warning}</p>}

            {/* Whose paper this is. The one thing worth getting right: a
                document under the wrong supplier is a document nobody finds. */}
            <label className="block">
              <span className="text-sm text-stone-600">Supplier</span>
              <select
                className="modal-input"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                aria-label="Supplier on this document"
              >
                <option value="">
                  {newSupplierName ? `New supplier: ${newSupplierName}` : "New supplier (unnamed)"}
                </option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <span className="text-xs text-stone-500">
                {matched
                  ? `Matched ${matched.name} by its VAT number.`
                  : willCreate
                    ? `Not one of your suppliers yet — it will be added${read?.supplier_vat ? `, VAT ${read.supplier_vat}` : ""}.`
                    : "Pick who sent this."}
              </span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
              <label className="block">
                <span className="text-sm text-stone-600">Kind</span>
                <select
                  className="modal-input" value={header.kind} aria-label="Document kind"
                  onChange={(e) => setHeader((h) => ({ ...h, kind: e.target.value as SupplierDocumentKind }))}
                >
                  {(Object.keys(DOCUMENT_KIND_LABEL) as SupplierDocumentKind[]).map((k) => (
                    <option key={k} value={k}>{DOCUMENT_KIND_LABEL[k]}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-stone-600">Their number</span>
                <input
                  className="modal-input" value={header.doc_number} aria-label="Document number"
                  onChange={(e) => setHeader((h) => ({ ...h, doc_number: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className="text-sm text-stone-600">Date on it</span>
                <input
                  className="modal-input" type="date" value={header.doc_date} aria-label="Document date"
                  onChange={(e) => setHeader((h) => ({ ...h, doc_date: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className="text-sm text-stone-600">Total (incl VAT)</span>
                <input
                  className="modal-input" inputMode="decimal" value={header.total} aria-label="Document total"
                  onChange={(e) => setHeader((h) => ({ ...h, total: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className="text-sm text-stone-600">Subtotal (excl VAT)</span>
                <input
                  className="modal-input" inputMode="decimal" value={header.subtotal} aria-label="Document subtotal"
                  onChange={(e) => setHeader((h) => ({ ...h, subtotal: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className="text-sm text-stone-600">VAT</span>
                <input
                  className="modal-input" inputMode="decimal" value={header.tax_total} aria-label="Document VAT"
                  onChange={(e) => setHeader((h) => ({ ...h, tax_total: e.target.value }))}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-sm text-stone-600">Note</span>
                <input
                  className="modal-input" value={header.note} aria-label="Document note"
                  placeholder="Plumbing for the Sithole job"
                  onChange={(e) => setHeader((h) => ({ ...h, note: e.target.value }))}
                />
              </label>
            </div>

            {/* The lines. Not editable cell by cell on purpose: what each one
                becomes in the catalogue is decided when the goods arrive, on
                a screen built for it. Here a misread row can be dropped. */}
            <div className="mt-3">
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-stone-600">
                  {lines.length} {lines.length === 1 ? "line" : "lines"}
                </span>
                {lines.length > 0 && (
                  <span className="text-xs text-stone-500 ml-auto tabular-nums">
                    they add to {money(linesTotal)}
                  </span>
                )}
              </div>
              {/* A sum that disagrees with the printed subtotal means a row was
                  missed or doubled. Said plainly rather than silently filed. */}
              {drift > 0.02 && (
                <p className="acc-note is-warning">
                  The lines add to {money(linesTotal)} but the page says {money(statedSub)}.
                  Check the pages before filing.
                </p>
              )}
              {lines.length > 0 && (
                <div className="acc-scroll" style={{ maxHeight: 260 }}>
                  <table className="acc-table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="num">Qty</th>
                        <th className="num">Unit</th>
                        <th className="num">Line</th>
                        <th className="num" />
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l, i) => (
                        <tr key={i}>
                          <td>
                            <span className="acc-name">{l.description}</span>
                            {l.supplier_code && <span className="acc-sub">{l.supplier_code}</span>}
                          </td>
                          <td className="num">{l.qty ?? "—"}</td>
                          <td className="num">{l.unit_price != null ? money(l.unit_price) : "—"}</td>
                          <td className="num">{l.line_total != null ? money(l.line_total) : "—"}</td>
                          <td className="num">
                            <button
                              type="button" className="btn-line quiet"
                              aria-label={`Drop ${l.description}`}
                              onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                              disabled={busy}
                            >
                              Drop
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <PageStrip pages={pages} onRemove={(i) => setPages((p) => p.filter((_, j) => j !== i))} busy={busy} />
          </div>
        )}

        {stage === "review" && (
          <>
            {progress && <p className="acc-note">{progress}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-line" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn-line" onClick={() => setStage("capture")} disabled={busy}>
                Back to pages
              </button>
              <button
                type="button" className="btn-fill"
                disabled={busy || (!supplierId && !newSupplierName)}
                onClick={() => void file()}
              >
                {busy ? "Filing…" : "File it"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PageStrip({
  pages,
  onRemove,
  busy,
}: {
  pages: PendingPage[];
  onRemove: (i: number) => void;
  busy: boolean;
}) {
  if (pages.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {pages.map((p, i) => (
        <figure key={i} className="relative w-20">
          {p.mime === "application/pdf" ? (
            <div className="w-20 h-24 rounded border border-stone-200 bg-stone-50 flex items-center justify-center text-xs text-stone-600">
              PDF
            </div>
          ) : (
            <img src={p.data} alt="" className="w-20 h-24 object-cover rounded border border-stone-200" />
          )}
          <figcaption className="text-[10px] text-center text-stone-500">page {i + 1}</figcaption>
          <button
            type="button"
            className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-stone-800 text-white text-xs leading-none"
            onClick={() => onRemove(i)}
            aria-label={`Remove page ${i + 1}`}
            disabled={busy}
          >
            ×
          </button>
        </figure>
      ))}
    </div>
  );
}

/** A number from the reader as text a person can edit, blank when absent. */
function numText(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "";
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}
