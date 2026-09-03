import { useCallback, useEffect, useRef, useState } from "react";
import {
  shelfAddItem,
  shelfLookup,
  shelfSetPrice,
  uploadProductImage,
  type ShelfItem,
} from "../../lib/adminApi";
import { loadBarcodeReader, type BarcodeReader } from "../../lib/barcode";
import { CURRENCY } from "../../lib/config";
import { money } from "../../lib/money";
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
 * put photos on it (and fix the price, if this person may touch prices).
 * Unknown code → record it, and it lands HIDDEN for review — the server
 * enforces that, so nothing captured here changes what the till charges.
 *
 * The scan captures the picture too: at the moment the code locks, the
 * camera is already pointed at the item, so that frame becomes the first
 * photograph — removable, and joined by up to three more. One scan, both
 * facts. An item that already has a photo is NOT silently given another on
 * every rescan; adding more stays a deliberate tap.
 *
 * Who may do what is the point of the design: `shelf_capture` alone takes
 * photos and proposes items; the price field exists only for people who also
 * hold manage_catalogue. That split is what makes the shelf phone safe to
 * hand to whoever is walking the aisle today.
 */

/** As many photographs as an aisle stop is worth. All of them optional. */
const MAX_PHOTOS = 4;

type Sheet =
  | { kind: "found"; item: ShelfItem }
  | { kind: "new"; barcode: string };

export default function Shelf({ user, pin }: { user: User | null; pin: string }) {
  const canPrice = can(user, "manage_catalogue");

  // undefined while the reader is still loading — the native detector where
  // the browser has one, the bundled ZXing decoder where it does not (every
  // iPhone), null only if even that failed to load.
  const [reader, setReader] = useState<BarcodeReader | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadBarcodeReader().then((r) => {
      if (!cancelled) setReader(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
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
          // Ask for 720p rather than whatever the browser defaults to: an
          // EAN's bars are a couple of pixels wide at arm's length, and a
          // 640-wide default leaves a small label unreadable. "ideal" is a
          // preference, so a camera that cannot still opens.
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        acquired = s;
        setStream(s);
        try {
          // Shown only where it can work: iOS reports no torch capability,
          // and a button that does nothing reads as a broken app.
          const caps = s.getVideoTracks()[0]?.getCapabilities() as
            | (MediaTrackCapabilities & { torch?: boolean })
            | undefined;
          setTorchSupported(Boolean(caps?.torch));
        } catch {
          setTorchSupported(false);
        }
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
      await track.applyConstraints({
        advanced: [{ torch: !torchOn } as MediaTrackConstraintSet],
      });
      setTorchOn((t) => !t);
    } catch {
      /* a torch that will not light is not worth an error bar */
    }
  }

  // ---- the photographs ------------------------------------------------------

  /** The current viewfinder frame, downscaled — or null with no live camera. */
  const captureFrameData = useCallback(async (): Promise<string | null> => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob: Blob | null = await new Promise((r) =>
      canvas.toBlob(r, "image/jpeg", 0.92)
    );
    return blob ? await downscaleImage(blob) : null;
  }, []);

  function addPhoto(dataUrl: string | null) {
    if (!dataUrl) return;
    setPhotos((p) => (p.length >= MAX_PHOTOS ? p : [...p, dataUrl]));
  }

  async function pickFile(file: File | undefined) {
    if (file) addPhoto(await downscaleImage(file));
  }

  // ---- finding the item -----------------------------------------------------

  /**
   * A code has been read — optically or typed. `snap` is the viewfinder frame
   * from that same moment: the scan captures the picture as well as the
   * barcode, except for an item that already has one, where more photographs
   * stay a deliberate choice rather than a side effect of every rescan.
   */
  const handleCode = useCallback(
    async (raw: string, snap: string | null) => {
      const code = raw.replace(/\D/g, "");
      if (!code || busy) return;
      setBusy(true);
      setError(null);
      try {
        const item = await shelfLookup(pin, code);
        if (item) {
          setPhotos(item.has_photo || !snap ? [] : [snap]);
          setPriceEdit(String(item.price_retail));
          setSheet({ kind: "found", item });
        } else {
          setPhotos(snap ? [snap] : []);
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
        if (found[0]?.rawValue) {
          // The frame that carried the barcode is the first photograph.
          const snap = await captureFrameData();
          void handleCode(found[0].rawValue, snap);
        }
      } catch {
        /* a frame that will not decode is just the next frame's problem */
      } finally {
        detecting.current = false;
      }
    }, 400);
    return () => window.clearInterval(id);
  }, [reader, sheet, stream, handleCode, captureFrameData]);

  // ---- saving ---------------------------------------------------------------

  function reset() {
    setSheet(null);
    setPhotos([]);
    setTyped("");
    setError(null);
  }

  async function uploadAll(productId: string) {
    for (let i = 0; i < photos.length; i++) {
      await uploadProductImage(pin, productId, photos[i], i);
    }
  }

  async function saveFound(item: ShelfItem) {
    setBusy(true);
    setError(null);
    try {
      const did: string[] = [];
      if (photos.length) {
        await uploadAll(item.id);
        did.push(photos.length === 1 ? "photo added" : `${photos.length} photos added`);
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
      await uploadAll(item.id);
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

  // Up to four photographs, every one of them removable and none required.
  // The first is usually the scan-moment frame; the add tile disappears when
  // the strip is full.
  const photoStrip = (
    <div className="flex gap-2 items-start flex-wrap">
      {photos.map((p, i) => (
        <div key={i} className="relative shrink-0">
          <img
            src={p}
            alt={`Photo ${i + 1}`}
            className="w-20 h-20 object-cover rounded-xl border border-stone-200"
          />
          <button
            aria-label={`Remove photo ${i + 1}`}
            className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-colophon text-paper text-xs leading-none"
            onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      {photos.length < MAX_PHOTOS &&
        (stream ? (
          <button
            className="shrink-0 w-20 h-20 rounded-xl border-2 border-dashed border-stone-300 text-xs text-stone-500"
            onClick={() => void captureFrameData().then(addPhoto)}
          >
            {photos.length ? "Add another" : "Take photo"}
          </button>
        ) : (
          <label className="shrink-0 w-20 h-20 rounded-xl border-2 border-dashed border-stone-300 text-xs text-stone-500 flex items-center justify-center text-center cursor-pointer">
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
        ))}
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
                (reader === undefined
                  ? "Starting…"
                  : reader
                    ? "Point at the barcode"
                    : "This browser cannot scan — type the code below")}
            </p>
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-60 h-36 rounded-2xl border-2 border-amber-400/90" />
            <div className="absolute bottom-0 left-0 right-0 p-3 flex gap-2 items-center bg-gradient-to-t from-black/60 to-transparent">
              {torchSupported && (
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
                  if (e.key === "Enter") {
                    void captureFrameData().then((snap) => handleCode(typed, snap));
                  }
                }}
              />
              <button
                className="px-4 py-2 rounded-full text-sm bg-white text-stone-900 disabled:opacity-50"
                disabled={busy || !typed.trim()}
                onClick={() =>
                  void captureFrameData().then((snap) => handleCode(typed, snap))
                }
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
          {photoStrip}
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
            // Read-only on purpose: prices are exactly what the shelf grant
            // does not confer. The figure is on the shelf label the person is
            // looking at anyway.
            <p className="text-sm text-stone-600">
              {money(sheet.item.price_retail)} per {sheet.item.unit_code}
            </p>
          )}
          <div className="flex gap-2">
            <button className="flex-1 py-2.5 rounded-xl bg-stone-100 text-stone-700" onClick={reset} disabled={busy}>
              Skip
            </button>
            <button
              className="flex-1 py-2.5 rounded-xl bg-colophon text-paper disabled:opacity-40"
              disabled={
                busy ||
                (photos.length === 0 &&
                  !(canPrice && Number(priceEdit) !== sheet.item.price_retail))
              }
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
          {photoStrip}
          <div className="grid grid-cols-2 gap-3">
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
          <div className="flex gap-2">
            <button className="flex-1 py-2.5 rounded-xl bg-stone-100 text-stone-700" onClick={reset} disabled={busy}>
              Cancel
            </button>
            <button
              className="flex-1 py-2.5 rounded-xl bg-colophon text-paper disabled:opacity-40"
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
