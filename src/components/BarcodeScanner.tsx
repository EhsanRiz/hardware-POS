import { useEffect, useRef, useState } from "react";
import { loadBarcodeReader, type BarcodeReader } from "../lib/barcode";

/**
 * A viewfinder that reads one barcode and hands it back.
 *
 * The product editor's Barcode field takes a scanner gun's keystrokes on the
 * tablet already — a gun is a keyboard. This is the phone's equivalent: the
 * same reader the Shelf screen uses (native where it works, the bundled
 * decoder where it does not), pointed at the label, and the first code read
 * fills the field. One code, then it closes; the person is filling in a
 * form, not walking an aisle.
 */
export default function BarcodeScanner({
  onCode,
  onClose,
}: {
  onCode: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [reader, setReader] = useState<BarcodeReader | null | undefined>(undefined);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadBarcodeReader().then((r) => !cancelled && setReader(r));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let acquired: MediaStream | null = null;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        acquired = s;
        setStream(s);
      } catch {
        if (!cancelled) setError("The camera could not be opened. Type the barcode instead.");
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
  }, [stream]);

  // The same loop as the Shelf: a frame every 400 ms, never two in flight.
  const detecting = useRef(false);
  const done = useRef(false);
  useEffect(() => {
    if (!reader || !stream) return;
    const id = window.setInterval(async () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || detecting.current || done.current) return;
      detecting.current = true;
      try {
        const found = await reader.detect(video);
        const code = found[0]?.rawValue?.replace(/\D/g, "");
        if (code) {
          done.current = true;
          onCode(code);
        }
      } catch {
        /* the next frame's problem */
      } finally {
        detecting.current = false;
      }
    }, 400);
    return () => window.clearInterval(id);
  }, [reader, stream, onCode]);

  return (
    <div
      className="vv-fixed bg-stone-900 z-[60] flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Scan a barcode"
    >
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
        <p className="absolute top-3 left-0 right-0 text-center text-sm text-stone-100 drop-shadow">
          {error ??
            (reader === undefined
              ? "Starting…"
              : reader
                ? "Point at the barcode"
                : "This browser cannot scan — type the code instead")}
        </p>
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-60 h-36 rounded-2xl border-2 border-amber-400/90" />
      </div>
      <div className="p-3 bg-stone-900">
        <button
          type="button"
          onClick={onClose}
          className="w-full h-12 rounded-xl bg-white text-stone-900 font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
