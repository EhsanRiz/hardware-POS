import { useCallback, useEffect, useRef, useState } from "react";
import {
  DOCUMENT_KIND_LABEL,
  purchasingAddDocument,
  purchasingDeleteDocument,
  purchasingDocuments,
  purchasingSaveSupplier,
  purchasingSuppliers,
  signSupplierPages,
  uploadSupplierPage,
  type Supplier,
  type SupplierDocument,
  type SupplierDocumentKind,
  type SupplierPage,
} from "../../lib/adminApi";
import { fmtDate } from "../../lib/dates";
import { errorMessage } from "../../lib/errors";
import { downscaleImage } from "../../lib/images";
import { money } from "../../lib/money";
import { useOnline } from "../../lib/offline";

/**
 * Suppliers, and the paper they send.
 *
 * The drawer of quotations and invoices, photographed page by page on the
 * phone (or the emailed PDF uploaded) and kept against the supplier with its
 * number, date and total, so "what did Jasbro quote for elbows in August" is
 * a search and not an afternoon. Reading the lines off the page comes next;
 * this screen is the filing.
 */
export default function Suppliers({ pin }: { pin: string }) {
  const online = useOnline();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [docs, setDocs] = useState<SupplierDocument[] | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<SupplierDocument | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, d] = await Promise.all([
        purchasingSuppliers(pin),
        purchasingDocuments(pin, filter || null),
      ]);
      setSuppliers(s);
      setDocs(d);
    } catch (e) {
      setError(errorMessage(e, "Could not load the suppliers"));
    }
  }, [pin, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = suppliers.find((s) => s.id === filter) ?? null;

  return (
    <div className="acc">
      <div className="acc-tools">
        <select
          className="modal-input"
          style={{ marginBottom: 0, maxWidth: 320 }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Supplier"
        >
          <option value="">All suppliers</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.document_count ? ` · ${s.document_count}` : ""}
            </option>
          ))}
        </select>
        {selected && (
          <button className="btn-line" onClick={() => setEditing(selected)} disabled={!online}>
            Edit supplier
          </button>
        )}
        <button className="btn-line" onClick={() => setEditing("new")} disabled={!online}>
          Add supplier
        </button>
        <button
          className="btn-fill"
          onClick={() => setAdding(true)}
          disabled={!online || suppliers.length === 0}
          title={suppliers.length === 0 ? "Add a supplier first" : undefined}
        >
          New document
        </button>
      </div>

      {!online && <p className="acc-note">Supplier paperwork needs a connection.</p>}
      {banner && <p className="acc-note is-good">{banner}</p>}
      {error && <p className="acc-note is-bad">{error}</p>}

      <div className="acc-scroll">
        <table className="acc-table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Supplier</th>
              <th className="num">Pages</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {docs === null && (
              <tr><td colSpan={4} className="acc-empty">Looking…</td></tr>
            )}
            {docs !== null && docs.length === 0 && (
              <tr>
                <td colSpan={4} className="acc-empty">
                  {suppliers.length === 0
                    ? "No suppliers yet. Add one, then file its first quote or invoice."
                    : "Nothing filed yet. New document photographs the pages or takes the PDF."}
                </td>
              </tr>
            )}
            {docs?.map((d) => (
              <tr key={d.id} className="acc-row" onClick={() => setViewing(d)}>
                <td>
                  <span className="acc-name">
                    {DOCUMENT_KIND_LABEL[d.kind]} {d.doc_number ?? ""}
                  </span>
                  <span className="acc-sub">
                    {d.doc_date ? fmtDate(d.doc_date) : "no date"} · filed {fmtDate(d.created_at)}
                    {d.created_by_name ? ` by ${d.created_by_name}` : ""}
                    {d.status !== "stored" ? ` · ${d.status}` : ""}
                  </span>
                </td>
                <td>
                  <span className="acc-name">{d.supplier_name}</span>
                  {d.note && <span className="acc-sub">{d.note}</span>}
                </td>
                <td className="num">{d.pages} {d.pages === 1 ? "page" : "pages"}</td>
                <td className="num">{d.total != null ? money(d.total) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <SupplierForm
          pin={pin}
          supplier={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (s) => {
            setEditing(null);
            setBanner(`${s.name} saved.`);
            await load();
          }}
        />
      )}

      {adding && (
        <NewDocument
          pin={pin}
          suppliers={suppliers}
          initialSupplier={filter || suppliers[0]?.id || ""}
          onClose={() => setAdding(false)}
          onDone={async (pages) => {
            setAdding(false);
            setBanner(`Filed with ${pages} ${pages === 1 ? "page" : "pages"}.`);
            await load();
          }}
        />
      )}

      {viewing && (
        <DocumentView
          pin={pin}
          doc={viewing}
          onClose={() => setViewing(null)}
          onDeleted={async () => {
            setViewing(null);
            setBanner("Document removed.");
            await load();
          }}
        />
      )}
    </div>
  );
}

function SupplierForm({
  pin,
  supplier,
  onClose,
  onSaved,
}: {
  pin: string;
  supplier: Supplier | null;
  onClose: () => void;
  onSaved: (s: { id: string; name: string }) => Promise<void>;
}) {
  const [f, setF] = useState({
    name: supplier?.name ?? "",
    contact_name: supplier?.contact_name ?? "",
    phone: supplier?.phone ?? "",
    email: supplier?.email ?? "",
    vat_number: supplier?.vat_number ?? "",
    notes: supplier?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const s = await purchasingSaveSupplier(pin, { id: supplier?.id ?? null, ...f });
      await onSaved(s);
    } catch (e) {
      setError(errorMessage(e, "The supplier could not be saved"));
      setBusy(false);
    }
  }

  const fields: [keyof typeof f, string][] = [
    ["name", "Supplier name"],
    ["contact_name", "Contact person"],
    ["phone", "Phone"],
    ["email", "Email"],
    ["vat_number", "VAT number"],
    ["notes", "Notes"],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={supplier ? "Edit supplier" : "Add supplier"}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 className="modal-title">{supplier ? supplier.name : "New supplier"}</h2>
        {fields.map(([k, label]) => (
          <label key={k} className="block" style={{ marginTop: 8 }}>
            <span className="text-sm text-stone-600">{label}</span>
            <input
              className="modal-input"
              value={f[k]}
              onChange={(e) => set(k, e.target.value)}
              aria-label={label}
              autoFocus={k === "name"}
            />
          </label>
        ))}
        {error && <p className="acc-note is-bad" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-line" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-fill" disabled={busy || !f.name.trim()}>
            {busy ? "Saving…" : "Save supplier"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A page waiting to go: what it is, and what to show meanwhile. */
interface PendingPage {
  name: string;
  mime: string;
  /** The data URL that will be sent: a downscaled photo, or the PDF whole. */
  data: string;
}

function NewDocument({
  pin,
  suppliers,
  initialSupplier,
  onClose,
  onDone,
}: {
  pin: string;
  suppliers: Supplier[];
  initialSupplier: string;
  onClose: () => void;
  onDone: (pages: number) => Promise<void>;
}) {
  const [supplierId, setSupplierId] = useState(initialSupplier);
  const [kind, setKind] = useState<SupplierDocumentKind>("quote");
  const [number, setNumber] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [total, setTotal] = useState("");
  const [note, setNote] = useState("");
  const [pages, setPages] = useState<PendingPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    try {
      const next: PendingPage[] = [];
      for (const file of Array.from(files)) {
        if (file.type === "application/pdf") {
          next.push({ name: file.name, mime: file.type, data: await readAsDataUrl(file) });
        } else {
          // Larger than a product photo: a page has to stay legible, and the
          // reader that comes next needs the digits.
          next.push({ name: file.name, mime: "image/jpeg", data: await downscaleImage(file, 2000, 0.85) });
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

  async function save() {
    if (!supplierId || pages.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const totalNum = total.trim() === "" ? null : Number(total.replace(/[^\d.]/g, ""));
      if (totalNum != null && !Number.isFinite(totalNum)) throw new Error("The total is not a number");
      const id = await purchasingAddDocument(pin, {
        supplier_id: supplierId,
        kind,
        doc_number: number.trim() || null,
        doc_date: date || null,
        total: totalNum,
        note: note.trim() || null,
      });
      // One page at a time, in order, so a dropped line part-way leaves the
      // pages that arrived in place and the count says how far it got.
      for (let i = 0; i < pages.length; i++) {
        setProgress(`Sending page ${i + 1} of ${pages.length}…`);
        await uploadSupplierPage(pin, id, pages[i].data);
      }
      await onDone(pages.length);
    } catch (e) {
      setError(errorMessage(e, "The document could not be filed"));
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New supplier document"
        // Six fields and a row of pages outgrow a phone; the card scrolls
        // rather than putting the File button below the fold.
        style={{ maxWidth: 560, maxHeight: "92vh", overflowY: "auto" }}
      >
        <h2 className="modal-title">File a document</h2>
        <div className="grid grid-cols-2 gap-3 mt-2">
          <label className="block col-span-2">
            <span className="text-sm text-stone-600">Supplier</span>
            <select
              className="modal-input"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              aria-label="Document supplier"
            >
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm text-stone-600">Kind</span>
            <select
              className="modal-input"
              value={kind}
              onChange={(e) => setKind(e.target.value as SupplierDocumentKind)}
              aria-label="Document kind"
            >
              {(Object.keys(DOCUMENT_KIND_LABEL) as SupplierDocumentKind[]).map((k) => (
                <option key={k} value={k}>{DOCUMENT_KIND_LABEL[k]}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm text-stone-600">Their number</span>
            <input className="modal-input" value={number} onChange={(e) => setNumber(e.target.value)} aria-label="Document number" placeholder="27181" />
          </label>
          <label className="block">
            <span className="text-sm text-stone-600">Date on it</span>
            <input className="modal-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Document date" />
          </label>
          <label className="block">
            <span className="text-sm text-stone-600">Total (incl VAT)</span>
            <input className="modal-input" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} aria-label="Document total" placeholder="0.00" />
          </label>
          <label className="block col-span-2">
            <span className="text-sm text-stone-600">Note</span>
            <input className="modal-input" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Document note" placeholder="Plumbing order for the Sithole job" />
          </label>
        </div>

        {/* Pages. The camera for paper in hand, files for the PDF that came
            by email — and several of either, since a quote runs to pages. */}
        <div className="mt-3">
          <span className="text-sm text-stone-600">Pages</span>
          <div className="flex flex-wrap gap-2 mt-1">
            {pages.map((p, i) => (
              <figure key={i} className="relative w-20">
                {p.mime === "application/pdf" ? (
                  <div className="w-20 h-24 rounded border border-stone-200 bg-stone-50 flex items-center justify-center text-xs text-stone-600 p-1 text-center break-all">
                    PDF
                  </div>
                ) : (
                  <img src={p.data} alt="" className="w-20 h-24 object-cover rounded border border-stone-200" />
                )}
                <figcaption className="text-[10px] text-center text-stone-500">page {i + 1}</figcaption>
                <button
                  type="button"
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-stone-800 text-white text-xs leading-none"
                  onClick={() => setPages((ps) => ps.filter((_, j) => j !== i))}
                  aria-label={`Remove page ${i + 1}`}
                  disabled={busy}
                >
                  ×
                </button>
              </figure>
            ))}
          </div>
          <div className="flex gap-2 mt-2">
            <button type="button" className="btn-line" onClick={() => cameraRef.current?.click()} disabled={busy}>
              Take photo
            </button>
            <button type="button" className="btn-line" onClick={() => fileRef.current?.click()} disabled={busy}>
              Add PDF or photos
            </button>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              aria-label="Photograph a page"
              onChange={(e) => void addFiles(e.target.files)}
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              className="hidden"
              aria-label="Add PDF or photos"
              onChange={(e) => void addFiles(e.target.files)}
            />
          </div>
        </div>

        {progress && <p className="acc-note">{progress}</p>}
        {error && <p className="acc-note is-bad" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-line" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-fill"
            disabled={busy || !supplierId || pages.length === 0}
            onClick={() => void save()}
          >
            {busy ? "Filing…" : `File ${pages.length || ""} ${pages.length === 1 ? "page" : "pages"}`.replace("  ", " ")}
          </button>
        </div>
      </div>
    </div>
  );
}

function DocumentView({
  pin,
  doc,
  onClose,
  onDeleted,
}: {
  pin: string;
  doc: SupplierDocument;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [pages, setPages] = useState<SupplierPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    let cancelled = false;
    signSupplierPages(pin, doc.id)
      .then((p) => !cancelled && setPages(p))
      .catch((e) => !cancelled && setError(errorMessage(e, "Could not open the pages")));
    return () => {
      cancelled = true;
    };
  }, [pin, doc.id]);

  async function remove() {
    setBusy(true);
    try {
      await purchasingDeleteDocument(pin, doc.id);
      await onDeleted();
    } catch (e) {
      setError(errorMessage(e, "Could not remove the document"));
      setBusy(false);
    }
  }

  return (
    <div
      className="vv-fixed bg-black/50 flex items-center justify-center p-4 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={`${DOCUMENT_KIND_LABEL[doc.kind]} ${doc.doc_number ?? ""}`.trim()}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-2xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-stone-200 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold">
              {DOCUMENT_KIND_LABEL[doc.kind]} {doc.doc_number ?? ""}
            </h2>
            <p className="text-sm text-stone-500">
              {doc.supplier_name}
              {doc.doc_date ? ` · ${fmtDate(doc.doc_date)}` : ""}
              {doc.total != null ? ` · ${money(doc.total)}` : ""}
              {" · "}filed {fmtDate(doc.created_at)}
              {doc.created_by_name ? ` by ${doc.created_by_name}` : ""}
            </p>
            {doc.note && <p className="text-sm text-stone-600 mt-1">{doc.note}</p>}
          </div>
          <button onClick={onClose} className="text-stone-400 text-2xl leading-none" aria-label="Close document">
            ×
          </button>
        </div>
        <div className="p-4 overflow-y-auto flex-1 space-y-3">
          {error && <p className="acc-note is-bad">{error}</p>}
          {!pages && !error && <p className="text-sm text-stone-500">Opening the pages…</p>}
          {pages?.length === 0 && <p className="text-sm text-stone-500">No pages were filed.</p>}
          {pages?.map((p) =>
            p.mime === "application/pdf" ? (
              <p key={p.page_no} className="text-sm">
                Page {p.page_no}:{" "}
                {p.url ? (
                  <a className="underline text-accent-700" href={p.url} target="_blank" rel="noreferrer">
                    open the PDF
                  </a>
                ) : (
                  "unavailable"
                )}
              </p>
            ) : (
              <figure key={p.page_no}>
                {p.url ? (
                  <img src={p.url} alt={`Page ${p.page_no}`} className="w-full rounded border border-stone-200" />
                ) : (
                  <p className="text-sm text-stone-500">Page {p.page_no} is unavailable.</p>
                )}
                <figcaption className="text-xs text-stone-500 mt-1">Page {p.page_no}</figcaption>
              </figure>
            )
          )}
        </div>
        <div className="p-4 border-t border-stone-200 flex gap-2 items-center">
          {doc.status === "stored" && !confirm && (
            <button className="py-2.5 px-4 rounded-xl border border-red-200 text-red-700" onClick={() => setConfirm(true)} disabled={busy}>
              Remove
            </button>
          )}
          {confirm && (
            <>
              <span className="text-sm text-stone-600">Remove this document and its pages?</span>
              <button className="btn-line" onClick={() => setConfirm(false)} disabled={busy}>Keep</button>
              <button className="py-2.5 px-4 rounded-xl bg-red-700 text-white" onClick={() => void remove()} disabled={busy}>
                {busy ? "Removing…" : "Remove it"}
              </button>
            </>
          )}
          <button className="ml-auto py-2.5 px-4 rounded-xl bg-stone-100" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}
