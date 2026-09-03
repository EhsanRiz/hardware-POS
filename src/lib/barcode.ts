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
 * The code drawn to prove a detector before it is trusted. A valid EAN-13,
 * because the native detector is asked to read it back — a detector that
 * exists but cannot read a clean, full-size label is not a detector.
 */
export const PROBE_CODE = "6001234000013";

/**
 * A crisp EAN-13 on a white canvas, drawn bar by bar from the standard's
 * encoding tables. This is what the probe shows a detector. (The browser
 * suite draws its own labels the same way, so a test cannot pass because
 * the app and the test share a bug.)
 */
export function drawEan13(code: string, moduleWidth = 4): HTMLCanvasElement {
  const L: Record<string, string> = { "0": "0001101", "1": "0011001", "2": "0010011", "3": "0111101", "4": "0100011", "5": "0110001", "6": "0101111", "7": "0111011", "8": "0110111", "9": "0001011" };
  const G: Record<string, string> = { "0": "0100111", "1": "0110011", "2": "0011011", "3": "0100001", "4": "0011101", "5": "0111001", "6": "0000101", "7": "0010001", "8": "0001001", "9": "0010111" };
  const R: Record<string, string> = { "0": "1110010", "1": "1100110", "2": "1101100", "3": "1000010", "4": "1011100", "5": "1001110", "6": "1010000", "7": "1000100", "8": "1001000", "9": "1110100" };
  const PARITY: Record<string, string> = { "0": "LLLLLL", "1": "LLGLGG", "2": "LLGGLG", "3": "LLGGGL", "4": "LGLLGG", "5": "LGGLLG", "6": "LGGGLL", "7": "LGLGLG", "8": "LGLGGL", "9": "LGGLGL" };
  const parity = PARITY[code[0]];
  let modules = "101";
  for (let i = 1; i <= 6; i++) modules += (parity[i - 1] === "L" ? L : G)[code[i]];
  modules += "01010";
  for (let i = 7; i <= 12; i++) modules += R[code[i]];
  modules += "101";

  const quiet = 15 * moduleWidth;
  const canvas = document.createElement("canvas");
  canvas.width = modules.length * moduleWidth + quiet * 2;
  canvas.height = 160;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] === "1") ctx.fillRect(quiet + i * moduleWidth, 20, moduleWidth, 120);
  }
  return canvas;
}

/**
 * Whether a detector actually reads. WebKit has shipped a BarcodeDetector
 * that constructs happily and then finds nothing in any frame — iOS 18
 * broke the Shape Detection API and left the object standing — so the
 * mere presence of the constructor proves nothing. Show it a label; if it
 * cannot read that, the bundled decoder does the job instead.
 */
async function proves(reader: BarcodeReader): Promise<boolean> {
  try {
    const found = await reader.detect(drawEan13(PROBE_CODE));
    return found.some((f) => f.rawValue === PROBE_CODE);
  } catch {
    return false;
  }
}

/**
 * The reader the Shelf screen actually asks for: the native detector where
 * it exists AND reads, otherwise the bundled ZXing decoder — which is what
 * every iPhone gets, since all iOS browsers are WebKit and WebKit's
 * BarcodeDetector is either absent or present-but-blind. The fallback loads
 * as its own chunk, so nothing pays for it until a browser without a working
 * detector opens the Shelf. Null only when even the bundled decoder failed to
 * load, which leaves typing the digits.
 */
export async function loadBarcodeReader(): Promise<BarcodeReader | null> {
  const native = createBarcodeReader();
  if (native && (await proves(native))) return native;
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
