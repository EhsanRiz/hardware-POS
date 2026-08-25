/**
 * The barcode reader behind the Shelf screen's viewfinder.
 *
 * Where the browser has a built-in detector (Chrome on Android — which is
 * what the shop's phones run), it is used as-is: no library, no wasm, and
 * decoding happens off the same video element the person is already looking
 * at. Where it does not exist (iOS Safari, desktop), createBarcodeReader
 * returns null and the screen falls back to typing the digits — slower, but
 * never a dead end.
 *
 * This module is also the test seam, and the honesty of the browser suite
 * rests on how thin it is: tests install a fake `BarcodeDetector` constructor
 * on `window` before the app loads, and this code cannot tell the difference.
 * Everything downstream of a detection — the lookup, the sheets, the upload —
 * is therefore exercised for real. The only thing the suite cannot prove is
 * the physical decode, which is verified on an actual phone at an actual
 * shelf.
 */

export interface DetectedBarcode {
  rawValue: string;
}

export interface BarcodeReader {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeReader;
}

/** The retail codes a hardware shelf actually carries. */
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];

export function createBarcodeReader(): BarcodeReader | null {
  const Ctor = (window as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    return new Ctor({ formats: FORMATS });
  } catch {
    // A detector that exists but rejects the formats list is no detector.
    return null;
  }
}

/**
 * The reader the Shelf screen actually asks for: the native detector where it
 * exists, otherwise the bundled ZXing decoder — which is what every iPhone
 * gets, since all iOS browsers are WebKit and WebKit ships no
 * BarcodeDetector. The fallback loads as its own chunk, so nothing pays for
 * it until a detector-less browser opens the Shelf. Null only when even the
 * bundled decoder failed to load, which leaves typing the digits.
 */
export async function loadBarcodeReader(): Promise<BarcodeReader | null> {
  const native = createBarcodeReader();
  if (native) return native;
  try {
    const zxing = await import("./barcodeZxing");
    const reader = zxing.createZXingReader();
    if (import.meta.env.MODE === "e2e") {
      // The suite fakes optical input at this seam, so the one thing it
      // cannot otherwise prove is that the bundled decoder truly decodes.
      // The e2e build exposes the real reader for exactly that test — see
      // "the bundled decoder really reads an EAN-13" in till.spec.ts.
      (window as { __zxingReader?: BarcodeReader }).__zxingReader = reader;
    }
    return reader;
  } catch {
    return null;
  }
}
