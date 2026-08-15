import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  shelfAddItem,
  shelfLookup,
  shelfSetPrice,
  uploadProductImage,
  type ShelfItem,
} from "../../lib/adminApi";
import { createBarcodeReader } from "../../lib/barcode";
import { CURRENCY } from "../../lib/config";
import { errorMessage } from "../../lib/errors";
import { downscaleImage } from "../../lib/images";
import { can } from "../../lib/permissions";
import type { User } from "../../lib/types";

/**
 * The catalogue, photographed where it lives.
 *
 * The shop's catalogue arrived as a supplier import — ~1,400 rows, almost
 * none with a photo — and the fixing of that happens in the aisles, phone in
 * hand. The screen is built around the barcode, not the photo, because the
 * barcode is what makes the work land in the right place: scan first, and
 * the flow branches on whether the code already names an item. Known item →
 * put a photo on it (and fix the price, if this person may touch prices).
 * Unknown code → record it, and it lands HIDDEN for review — the server
 * enforces that, so nothing captured here changes what the till charges.
 *
 * Who may do what is the point of the design: `shelf_capture` alone takes
 * photos and proposes items; the price field exists only for people who also
 * hold manage_catalogue. That split is what makes the shelf phone safe to
 * hand to whoever is walking the aisle today.
 */

type Sheet =
  | { kind: "found"; item: ShelfItem }
  | { kind: "new"; barcode: string };

export default function Shelf({ user, pin }: { user: User | null; pin: string }) {
  const canPrice = can(user, "manage_catalogue");

  // The reader is created once; null means "no detector on this browser",
  // which leaves the typed fallback as the only road — slower, never a dead
  // end.
  const reader = useMemo(() => createBarcodeReader(), []);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [priceEdit, setPriceEdit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // ---- camera ---------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    let acquired: MediaStream | null = null;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        acquired = s;
        setStream(s);
      } catch {
        if (!cancelled) {
          setCameraError(
            "The camera could not be opened. You can still type a barcode below, and add photos from the gallery."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      acquired?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => {});
    }
  }, [stream, sheet]);

  async function toggleTorch() {
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    try {
      // Not in the lib typings, but real on the phones this runs on.
      const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
      if (!caps.torch) return;
      await track.applyConstraints({
        advanced: [{ torch: !torchOn } as MediaTrackConstraintSet],
      });
      setTorchOn((t) => !t);
    } catch {
      /* a torch that will not light is not worth an error bar */
    }
  }

  // ---- finding the item -----------------------------------------------------

  const handleCode = useCallback(
    async (raw: string) => {
      const code = raw.replace(/\D/g, "");
      if (!code || busy) return;
      setBusy(true);
      setError(null);
      try {
        const item = await shelfLookup(pin, code);
        setPhoto(null);
        if (item) {
          setPriceEdit(String(item.price_retail));
          setSheet({ kind: "found", item });
        } else {
          setNewName("");
          setNewPrice("");
          setSheet({ kind: "new", barcode: code });
        }
      } catch (e) {
        setError(errorMessage(e, "Could not look that barcode up"));
      } finally {
        setBusy(false);
      }
    },
    [pin, busy]
  );

  // The detection loop: only while the viewfinder is the active surface, and
  // never two detects in flight at once. The reader is the test seam — see
  // lib/barcode.ts — so everything from here down runs for real in the suite.
  const detecting = useRef(false);
  useEffect(() => {
    if (!reader || sheet || !stream) return;
    const id = window.setInterval(async () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || detecting.current) return;
      detecting.current = true;
      try {
        const found = await reader.detect(video);
        if (found[0]?.rawValue) void handleCode(found[0].rawValue);
      } catch {
        /* a frame that will not decode is just the next frame's problem */
      } finally {
        detecting.current = false;
      }
    }, 400);
    return () => window.clearInterval(id);
  }, [reader, sheet, stream, handleCode]);

  // ---- the photograph -------------------------------------------------------

  async function captureFrame() {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob: Blob | null = await new Promise((r) =>
      canvas.toBlob(r, "image/jpeg", 0.92)
    );
    if (blob) setPhoto(await downscaleImage(blob));
  }

  async function pickFile(file: File | undefined) {
    if (file) setPhoto(await downscaleImage(file));
  }

  // ---- saving ---------------------------------------------------------------

  function reset() {
    setSheet(null);
    setPhoto(null);
    setTyped("");
    setError(null);
  }

  async function saveFound(item: ShelfItem) {
    setBusy(true);
    setError(null);
    try {
      const did: string[] = [];
      if (photo) {
        await uploadProductImage(pin, item.id, photo);
        did.push("photo added");
      }
      if (canPrice && priceEdit.trim() !== "" && Number(priceEdit) !== item.price_retail) {
        await shelfSetPrice(pin, item.id, Number(priceEdit));
        did.push(`price ${CURRENCY}${Number(priceEdit).toFixed(2)}`);
      }
      setToast(`✓ ${item.name} — ${did.length ? did.join(", ") : "nothing changed"}`);
      reset();
    } catch (e) {
      setError(errorMessage(e, "Could not save"));
    } finally {
      setBusy(false);
    }
  }

  async function saveNew(barcode: string) {
    setBusy(true);
    setError(null);
    try {
      const item = await shelfAddItem(pin, barcode, newName, Number(newPrice));
      if (photo) await uploadProductImage(pin, item.id, photo);
      setToast(`✓ ${item.name} — saved hidden for review`);
      reset();
    } catch (e) {
      setError(errorMessage(e, "Could not save"));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // ---- render ---------------------------------------------------------------

  const photoBlock = (
    <div className="flex gap-3 items-start">
      {photo ? (
        <div className="shrink-0">
          <img src={photo} alt="Captured" className="w-24 h-24 object-cover rounded-xl border border-stone-200" />
          <button className="block w-full text-center text-xs text-stone-500 mt-1" onClick={() => setPhoto(null)}>
            Retake
          </button>
        </div>
      ) : stream ? (
        <button
          className="shrink-0 w-24 h-24 rounded-xl border-2 border-dashed border-stone-300 text-xs text-stone-500"
          onClick={() => void captureFrame()}
        >
          Take photo
        </button>
      ) : (
        <label className="shrink-0 w-24 h-24 rounded-xl border-2 border-dashed border-stone-300 text-xs text-stone-500 flex items-center justify-center text-center cursor-pointer">
          Add photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            aria-label="Add photo"
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
        </label>
      )}
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-stone-900">
      {toast && (
        <div className="absolute top-16 left-3 right-3 z-30 bg-emerald-800 text-emerald-50 text-sm rounded-xl px-4 py-2.5 shadow-lg">
          {toast}
        </div>
      )}

      {/* The viewfinder. Kept mounted behind the sheets so the stream never
          restarts between items — the whole point is scan, snap, next. */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-cover"
        />
        {!sheet && (
          <>
            <p className="absolute top-3 left-0 right-0 text-center text-sm text-stone-100 drop-shadow">
              {cameraError ??
                (reader
                  ? "Point at the barcode"
                  : "This browser cannot scan — type the code below")}
            </p>
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-60 h-36 rounded-2xl border-2 border-amber-400/90" />
            <div className="absolute bottom-0 left-0 right-0 p-3 flex gap-2 items-center bg-gradient-to-t from-black/60 to-transparent">
              {stream && (
                <button
                  className="px-3 py-2 rounded-full text-sm text-white border border-white/40 bg-white/10"
                  onClick={() => void toggleTorch()}
                >
                  {torchOn ? "Torch off" : "Torch"}
                </button>
              )}
              <input
                className="flex-1 min-w-0 rounded-full px-4 py-2 text-sm bg-white/90"
                placeholder="Type the barcode…"
                inputMode="numeric"
                aria-label="Barcode digits"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCode(typed);
                }}
              />
              <button
                className="px-4 py-2 rounded-full text-sm bg-white text-stone-900 disabled:opacity-50"
                disabled={busy || !typed.trim()}
                onClick={() => void handleCode(typed)}
              >
                Find
              </button>
            </div>
          </>
        )}
        {error && !sheet && (
          <p
            className="absolute top-10 left-3 right-3 bg-amber-100 text-amber-900 text-sm rounded-lg px-3 py-2 cursor-pointer"
            onClick={() => setError(null)}
          >
            {error}
          </p>
        )}
      </div>

      {/* The sheets. Compact, over the viewfinder's bottom edge — the aisle is
          still there behind them, and Skip is always one tap. */}
      {sheet?.kind === "found" && (
        <div className="bg-white rounded-t-2xl p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
            In the catalogue · {sheet.item.barcode}
          </p>
          <div>
            <p className="font-semibold">{sheet.item.name}</p>
            <p className="text-sm text-stone-500">
              per {sheet.item.unit_code} ·{" "}
              {sheet.item.has_photo ? "has a photo" : "no photo yet"}
              {!sheet.item.active && " · hidden from the till"}
            </p>
          </div>
          {error && (
            <p className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg">{error}</p>
          )}
          <div className="flex gap-3 items-start">
            {photoBlock}
            <div className="flex-1">
              {canPrice ? (
                <label className="block">
                  <span className="text-xs text-stone-500">Retail price</span>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-stone-500">{CURRENCY}</span>
                    <input
                      className="w-full border border-stone-300 rounded-lg px-3 py-2"
                      value={priceEdit}
                      onChange={(e) => setPriceEdit(e.target.value)}
                      inputMode="decimal"
                      aria-label="Retail price"
                    />
                  </div>
                </label>
              ) : (
                // Read-only on purpose: prices are exactly what the shelf
                // grant does not confer. The figure is on the shelf label the
                // person is looking at anyway.
                <p className="text-sm text-stone-600 mt-1">
                  {CURRENCY}
                  {sheet.item.price_retail.toFixed(2)} per {sheet.item.unit_code}
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <button className="flex-1 py-2.5 rounded-xl bg-stone-100 text-stone-700" onClick={reset} disabled={busy}>
              Skip
            </button>
            <button
              className="flex-1 py-2.5 rounded-xl bg-stone-800 text-white disabled:opacity-40"
              disabled={busy || (!photo && !(canPrice && Number(priceEdit) !== sheet.item.price_retail))}
              onClick={() => void saveFound(sheet.item)}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {sheet?.kind === "new" && (
        <div className="bg-white rounded-t-2xl p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
            Not in the catalogue · {sheet.barcode}
          </p>
          {error && (
            <p className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg">{error}</p>
          )}
          <div className="flex gap-3 items-start">
            {photoBlock}
            <div className="flex-1 space-y-2">
              <label className="block">
                <span className="text-xs text-stone-500">Name</span>
                <input
                  className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  aria-label="Item name"
                />
              </label>
              <label className="block">
                <span className="text-xs text-stone-500">Shelf price</span>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-stone-500">{CURRENCY}</span>
                  <input
                    className="w-full border border-stone-300 rounded-lg px-3 py-2"
                    value={newPrice}
                    onChange={(e) => setNewPrice(e.target.value)}
                    inputMode="decimal"
                    aria-label="Shelf price"
                  />
                </div>
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="flex-1 py-2.5 rounded-xl bg-stone-100 text-stone-700" onClick={reset} disabled={busy}>
              Cancel
            </button>
            <button
              className="flex-1 py-2.5 rounded-xl bg-stone-800 text-white disabled:opacity-40"
              disabled={busy || !newName.trim() || newPrice.trim() === ""}
              onClick={() => void saveNew(sheet.barcode)}
            >
              {busy ? "Saving…" : "Save hidden for review"}
            </button>
          </div>
          {/* Said here, not only in the back office: the person capturing is
              owed the reason their item does not appear at the till. */}
          <p className="text-xs text-stone-500">
            New items do not go on sale from here. Somebody with catalogue
            rights reviews them under Catalogue → hidden, then flips them live.
          </p>
        </div>
      )}
    </div>
  );
}
