import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DOCUMENT_KIND_LABEL,
  purchasingAddDocument,
  purchasingDocumentLines,
  purchasingDeleteDocument,
  purchasingDocuments,
  purchasingSaveSupplier,
  purchasingSuppliers,
  signSupplierPages,
  uploadSupplierPage,
  type Supplier,
  type SupplierDocument,
  type SupplierDocumentKind,
  type DocumentLine,
  type SupplierPage,
} from "../../lib/adminApi";
import { fmtDate } from "../../lib/dates";
import { errorMessage } from "../../lib/errors";
import { downscaleImage } from "../../lib/images";
import { money } from "../../lib/money";
import { useOnline } from "../../lib/offline";
import ReceiveDocument from "./ReceiveDocument";
import ScanDocument from "./ScanDocument";

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
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [selected, setSelected] = useState<Supplier | null>(null);
  const [docs, setDocs] = useState<SupplierDocument[] | null>(null);
  const [term, setTerm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<SupplierDocument | null>(null);
  // A row opens the supplier in a popup; Manage on it opens the page.
  const [peek, setPeek] = useState<Supplier | null>(null);
  // The scanner: pages in, a checked reading out, filed in one step.
  const [scanning, setScanning] = useState(false);
  // The delivery being booked in off its own paperwork.
  const [receiving, setReceiving] = useState<SupplierDocument | null>(null);

  const loadSuppliers = useCallback(async () => {
    setError(null);
    try {
      const s = await purchasingSuppliers(pin);
      setSuppliers(s);
      // Keep the open supplier's counts current after a filing.
      setSelected((cur) => (cur ? s.find((x) => x.id === cur.id) ?? cur : cur));
    } catch (e) {
      setError(errorMessage(e, "Could not load the suppliers"));
    }
  }, [pin]);

  const loadDocs = useCallback(async () => {
    if (!selected) return;
    setError(null);
    try {
      setDocs(await purchasingDocuments(pin, selected.id));
    } catch (e) {
      setError(errorMessage(e, "Could not load the documents"));
    }
  }, [pin, selected]);

  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);

  useEffect(() => {
    setDocs(null);
    void loadDocs();
  }, [loadDocs]);

  /** After a scan: say what happened, and land where the document is. */
  const afterFiling = useCallback(
    async (r: {
      documentId: string; supplierName: string; created: boolean;
      filled: number; lines: number;
    }) => {
      setScanning(false);
      setBanner(
        `Filed under ${r.supplierName}${r.created ? " (added as a new supplier)" : ""}` +
        (r.lines ? ` with ${r.lines} ${r.lines === 1 ? "line" : "lines"}.` : ".") +
        // Said out loud, because a record changed that nobody asked to change.
        (r.filled
          ? ` Learnt ${r.filled} missing ${r.filled === 1 ? "detail" : "details"} about them from the letterhead.`
          : "")
      );
      const all = await purchasingSuppliers(pin).catch(() => null);
      if (all) {
        setSuppliers(all);
        const sup = all.find((x) => x.name === r.supplierName);
        if (sup) setSelected(sup);
      }
      const list = await purchasingDocuments(pin, null).catch(() => null);
      if (list) setViewing(list.find((d) => d.id === r.documentId) ?? null);
    },
    [pin]
  );

  const shown = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q || !suppliers) return suppliers ?? [];
    return suppliers.filter((s) =>
      [s.name, s.contact_name, s.phone, s.email, s.vat_number]
        .some((v) => (v ?? "").toLowerCase().includes(q))
    );
  }, [suppliers, term]);

  // ---- One supplier: its details and its paperwork. ----
  if (selected) {
    return (
      <div className="acc">
        <div className="acc-head">
          <button className="btn-line" onClick={() => { setSelected(null); setBanner(null); }}>
            ← Suppliers
          </button>
          <div className="acc-head-who">
            <h2>{selected.name}</h2>
            <p className="acc-sub" style={{ fontSize: 13 }}>
              {[selected.contact_name, selected.phone, selected.email, selected.address,
                selected.vat_number ? `VAT ${selected.vat_number}` : null,
                selected.bank_name
                  ? [selected.bank_name, selected.bank_account_number, selected.bank_branch_code]
                      .filter(Boolean).join(" ")
                  : null]
                .filter(Boolean).join(" · ") || "No details yet"}
              {selected.notes ? ` · ${selected.notes}` : ""}
            </p>
          </div>
          <span className="acc-head-owed" style={{ display: "flex", gap: 8 }}>
            <button className="btn-line" onClick={() => setEditing(selected)} disabled={!online}>
              Edit supplier
            </button>
            <button className="btn-line" onClick={() => setAdding(true)} disabled={!online}>
              File by hand
            </button>
            <button className="btn-fill" onClick={() => setScanning(true)} disabled={!online}>
              Scan a document
            </button>
          </span>
        </div>

        {!online && <p className="acc-note">Supplier paperwork needs a connection.</p>}
        {banner && <p className="acc-note is-good">{banner}</p>}
        {error && <p className="acc-note is-bad">{error}</p>}

        <div className="acc-scroll">
          <table className="acc-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Filed</th>
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
                    Nothing filed for {selected.name} yet. New document photographs the pages or takes the PDF.
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
                      {d.doc_date ? fmtDate(d.doc_date) : "no date"}
                      {d.note ? ` · ${d.note}` : ""}
                      {d.status !== "stored" ? ` · ${d.status}` : ""}
                    </span>
                  </td>
                  <td>
                    <span className="acc-sub" style={{ fontSize: 13 }}>
                      {fmtDate(d.created_at)}{d.created_by_name ? ` by ${d.created_by_name}` : ""}
                    </span>
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
              await loadSuppliers();
            }}
          />
        )}

        {adding && (
          <NewDocument
            pin={pin}
            suppliers={[selected]}
            initialSupplier={selected.id}
            onClose={() => setAdding(false)}
            onDone={async (pages) => {
              setAdding(false);
              setBanner(`Filed with ${pages} ${pages === 1 ? "page" : "pages"}.`);
              await Promise.all([loadDocs(), loadSuppliers()]);
            }}
          />
        )}

        {receiving && (
          <ReceiveDocument
            pin={pin}
            doc={receiving}
            onClose={() => setReceiving(null)}
            onDone={async (summary) => {
              setReceiving(null);
              setBanner(summary);
              await Promise.all([loadSuppliers(), loadDocs()]);
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
              await Promise.all([loadDocs(), loadSuppliers()]);
            }}
            onReceive={(d) => { setViewing(null); setReceiving(d); }}
          />
        )}
      </div>
    );
  }

  // ---- The suppliers, with enough of each to pick the right one. ----
  return (
    <div className="acc">
      <div className="acc-tools">
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Find a supplier by name, contact or phone…"
          className="modal-input"
          style={{ marginBottom: 0, maxWidth: 420 }}
        />
        <button className="btn-line" onClick={() => setEditing("new")} disabled={!online}>
          Add supplier
        </button>
        {/* The way in. Everything else on this screen exists for the paper
            that arrives through here. */}
        <button className="btn-fill" onClick={() => setScanning(true)} disabled={!online}>
          Scan a document
        </button>
      </div>

      {!online && <p className="acc-note">Supplier paperwork needs a connection.</p>}
      {banner && <p className="acc-note is-good">{banner}</p>}
      {error && <p className="acc-note is-bad">{error}</p>}

      <div className="acc-scroll">
        <table className="acc-table">
          <thead>
            <tr>
              <th>Supplier</th>
              <th>Contact</th>
              <th className="num">Documents</th>
            </tr>
          </thead>
          <tbody>
            {suppliers === null && (
              <tr><td colSpan={3} className="acc-empty">Looking…</td></tr>
            )}
            {suppliers !== null && shown.length === 0 && (
              <tr>
                <td colSpan={3} className="acc-empty">
                  {term
                    ? `No supplier matches “${term}”.`
                    : "No suppliers yet. Add one, then file its first quote or invoice."}
                </td>
              </tr>
            )}
            {shown.map((s) => (
              <tr key={s.id} className="acc-row" onClick={() => setPeek(s)}>
                <td>
                  <span className="acc-name">{s.name}</span>
                  {s.vat_number && <span className="acc-sub">VAT {s.vat_number}</span>}
                </td>
                <td>
                  <span className="acc-name">{s.contact_name ?? "—"}</span>
                  <span className="acc-sub">
                    {[s.phone, s.email].filter(Boolean).join(" · ")}
                  </span>
                </td>
                <td className="num">{s.document_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {receiving && (
        <ReceiveDocument
          pin={pin}
          doc={receiving}
          onClose={() => setReceiving(null)}
          onDone={async (summary) => {
            setReceiving(null);
            setBanner(summary);
            await Promise.all([loadSuppliers(), loadDocs()]);
          }}
        />
      )}

      {scanning && (
        <ScanDocument
          pin={pin}
          suppliers={suppliers ?? []}
          forSupplier={selected}
          onClose={() => setScanning(false)}
          onFiled={afterFiling}
        />
      )}

      {/* A document opened from a supplier's popup, without going through the
          supplier's page first. It used to be rendered only on that page, so
          the tap set the state and nothing appeared. */}
      {viewing && (
        <DocumentView
          pin={pin}
          doc={viewing}
          onClose={() => setViewing(null)}
          onDeleted={async () => {
            setViewing(null);
            setBanner("Document removed.");
            await loadSuppliers();
          }}
          onReceive={(d) => { setViewing(null); setReceiving(d); }}
        />
      )}

      {peek && (
        <SupplierPeek
          pin={pin}
          supplier={peek}
          onOpenDocument={(d) => { setPeek(null); setViewing(d); }}
          onClose={() => setPeek(null)}
          onManage={() => {
            setSelected(peek);
            setPeek(null);
            setBanner(null);
          }}
        />
      )}

      {editing && (
        <SupplierForm
          pin={pin}
          supplier={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (s) => {
            setEditing(null);
            setBanner(`${s.name} saved.`);
            await loadSuppliers();
            // Straight into the new supplier's page, where the paperwork goes.
            const fresh = await purchasingSuppliers(pin).catch(() => null);
            const row = fresh?.find((x) => x.id === s.id);
            if (row) setSelected(row);
          }}
        />
      )}
    </div>
  );
}

/** The supplier at a glance, with the way into managing it. */
function SupplierPeek({
  pin,
  supplier,
  onClose,
  onManage,
  onOpenDocument,
}: {
  pin: string;
  supplier: Supplier;
  onClose: () => void;
  onManage: () => void;
  /** The paper itself, from here: this is what the popup is opened for. */
  onOpenDocument: (d: SupplierDocument) => void;
}) {
  // Its paperwork, right here. Going to Manage first to see a quotation was
  // a step that existed for the code's benefit and not the shop's.
  const [docs, setDocs] = useState<SupplierDocument[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    purchasingDocuments(pin, supplier.id)
      .then((d) => !cancelled && setDocs(d))
      .catch(() => !cancelled && setDocs([]));
    return () => {
      cancelled = true;
    };
  }, [pin, supplier.id]);
  const rows: [string, string | null][] = [
    ["Contact", supplier.contact_name],
    ["Phone", supplier.phone],
    ["Email", supplier.email],
    ["Address", supplier.address],
    ["VAT number", supplier.vat_number],
    // Where their invoice gets paid — read off the foot of their own
    // letterhead, so nobody types an account number from a piece of paper.
    ["Bank", supplier.bank_name],
    ["Account name", supplier.bank_account_name],
    ["Account number", supplier.bank_account_number],
    ["Branch code", supplier.bank_branch_code],
    ["Notes", supplier.notes],
  ];
  return (
    <div
      className="vv-fixed bg-black/50 flex items-center justify-center p-4 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={`Supplier ${supplier.name}`}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-stone-200 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold">{supplier.name}</h2>
            <p className="text-sm text-stone-500">
              {supplier.document_count} {supplier.document_count === 1 ? "document" : "documents"} filed
            </p>
          </div>
          <button onClick={onClose} className="text-stone-400 text-2xl leading-none" aria-label="Close supplier">
            ×
          </button>
        </div>
        <div className="p-4 overflow-y-auto flex-1">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-stone-500">{label}</dt>
                <dd className="min-w-0 break-words">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>

          <h3 className="text-sm font-medium text-stone-700 mt-4 mb-1">Documents</h3>
          {docs === null && <p className="text-sm text-stone-500">Looking…</p>}
          {docs?.length === 0 && (
            <p className="text-sm text-stone-500">Nothing filed for them yet.</p>
          )}
          <ul className="divide-y divide-stone-100">
            {docs?.map((d) => (
              <li key={d.id}>
                <button
                  className="w-full text-left py-2 px-1 hover:bg-stone-50 flex items-baseline gap-3"
                  onClick={() => onOpenDocument(d)}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm">
                      {DOCUMENT_KIND_LABEL[d.kind]} {d.doc_number ?? ""}
                    </span>
                    <span className="block text-xs text-stone-500">
                      {d.doc_date ? fmtDate(d.doc_date) : "no date"} · {d.pages}{" "}
                      {d.pages === 1 ? "page" : "pages"}
                      {d.lines ? ` · ${d.lines} lines` : ""}
                    </span>
                  </span>
                  <span className="tabular-nums whitespace-nowrap text-sm">
                    {d.total != null ? money(d.total) : "—"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="p-4 border-t border-stone-200 flex gap-2">
          <button className="py-2.5 px-4 rounded-xl bg-stone-100" onClick={onClose}>
            Close
          </button>
          <button className="flex-1 py-2.5 rounded-xl bg-colophon text-paper" onClick={onManage}>
            Manage
          </button>
        </div>
      </div>
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
    address: supplier?.address ?? "",
    vat_number: supplier?.vat_number ?? "",
    bank_name: supplier?.bank_name ?? "",
    bank_account_name: supplier?.bank_account_name ?? "",
    bank_account_number: supplier?.bank_account_number ?? "",
    bank_branch_code: supplier?.bank_branch_code ?? "",
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
    ["address", "Address"],
    ["vat_number", "VAT number"],
    ["bank_name", "Bank"],
    ["bank_account_name", "Account name"],
    ["bank_account_number", "Account number"],
    ["bank_branch_code", "Branch code"],
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
          <label className="block sm:col-span-2">
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
          <label className="block sm:col-span-2">
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
  onReceive,
}: {
  pin: string;
  doc: SupplierDocument;
  onClose: () => void;
  onDeleted: () => Promise<void>;
  /** Book what is on this document onto the shelves. */
  onReceive?: (d: SupplierDocument) => void;
}) {
  const [pages, setPages] = useState<SupplierPage[] | null>(null);
  const [lines, setLines] = useState<DocumentLine[] | null>(null);
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

  useEffect(() => {
    if (!doc.lines) return;
    let cancelled = false;
    purchasingDocumentLines(pin, doc.id)
      .then((l) => !cancelled && setLines(l))
      .catch(() => !cancelled && setLines([]));
    return () => {
      cancelled = true;
    };
  }, [pin, doc.id, doc.lines]);

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

          {/* What it says, before what it looks like: the lines are the part
              a person came back to this document for. */}
          {lines && lines.length > 0 && (
            <table className="acc-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit</th>
                  <th className="num">Line</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.line_no}>
                    <td>
                      <span className="acc-name">{l.description}</span>
                      {l.supplier_code && <span className="acc-sub">{l.supplier_code}</span>}
                    </td>
                    <td className="num">{l.qty ?? "—"}</td>
                    <td className="num">{l.unit_price != null ? money(l.unit_price) : "—"}</td>
                    <td className="num">{l.line_total != null ? money(l.line_total) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
        <div className="p-4 border-t border-stone-200 flex gap-2 items-center flex-wrap">
          {/* The step that turns paper into stock. Only for a document with
              lines to receive, and only once: a delivery booked in twice is
              stock the shop does not have. A quote is a promise, so it is not
              offered here — nothing has been bought yet. */}
          {onReceive && doc.lines > 0 && doc.status !== "received" && doc.kind !== "quote" && (
            <button
              className="py-2.5 px-4 rounded-xl bg-colophon text-paper"
              onClick={() => onReceive(doc)}
            >
              Receive this delivery
            </button>
          )}
          {doc.status === "received" && (
            <span className="text-sm text-stone-500">Booked in.</span>
          )}
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
