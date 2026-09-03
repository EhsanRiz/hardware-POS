import {
  BarcodeFormat,
  BinaryBitmap,
  BrowserMultiFormatReader,
  DecodeHintType,
  HybridBinarizer,
  RGBLuminanceSource,
} from "@zxing/library";
import type { BarcodeReader, DetectedBarcode } from "./barcode";

/**
 * The decoder for browsers without a built-in one — which is every iPhone,
 * whatever the browser is called: Chrome, Firefox and Safari on iOS are all
 * WebKit underneath, and WebKit ships no BarcodeDetector. ZXing is bundled
 * into the app (no network fetch, cached by the service worker like any other
 * chunk), and sits behind the same BarcodeReader interface as the native
 * detector, so the Shelf screen cannot tell which one is reading.
 *
 * Its own module so Vite splits it into a lazy chunk: the till never pays for
 * a decoder, and an Android phone with the native detector never loads this.
 */

const HINTS = new Map();
HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
]);
// Camera frames from a hand-held phone are never scanner-flat; without this
// ZXing gives up on frames the native detector reads comfortably.
HINTS.set(DecodeHintType.TRY_HARDER, true);

/** A canvas reduced to the luminance bitmap ZXing's core wants. */
function bitmapFromCanvas(canvas: HTMLCanvasElement): BinaryBitmap | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !canvas.width || !canvas.height) return null;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // Integer Rec. 601 weights — the same mix ZXing uses internally.
    lum[j] = (data[i] * 306 + data[i + 1] * 601 + data[i + 2] * 117) >> 10;
  }
  return new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, width, height)));
}

/**
 * The longest side a frame is decoded at. Above this the extra pixels cost
 * more than they find: a phone's 1080p frame took three times longer to
 * scan than the same frame at 1280, and read the same label either way.
 */
const MAX_DECODE_SIDE = 1280;

export function createZXingReader(): BarcodeReader {
  const reader = new BrowserMultiFormatReader(HINTS);
  // One scratch canvas, reused for every frame rather than allocated per tick.
  const frame = document.createElement("canvas");

  /**
   * A video frame goes through the same canvas route as a still. ZXing's own
   * decode(video) is NOT used: it never read a frame this decoder reads
   * comfortably from a canvas (see "reads a barcode off a live video" in
   * till.spec.ts), and it was the whole reason a phone without a native
   * detector could point at a label all day and get nothing.
   */
  function frameToCanvas(video: HTMLVideoElement): HTMLCanvasElement | null {
    const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(video.videoWidth, video.videoHeight));
    frame.width = Math.round(video.videoWidth * scale);
    frame.height = Math.round(video.videoHeight * scale);
    const ctx = frame.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, frame.width, frame.height);
    return frame;
  }

  function decodeCanvas(canvas: HTMLCanvasElement): DetectedBarcode[] {
    const bitmap = bitmapFromCanvas(canvas);
    if (!bitmap) return [];
    const result = reader.decodeBitmap(bitmap);
    return [{ rawValue: result.getText() }];
  }

  return {
    detect(source: CanvasImageSource): Promise<DetectedBarcode[]> {
      try {
        if (source instanceof HTMLVideoElement) {
          if (!source.videoWidth) return Promise.resolve([]);
          const canvas = frameToCanvas(source);
          return Promise.resolve(canvas ? decodeCanvas(canvas) : []);
        }
        if (source instanceof HTMLCanvasElement) {
          return Promise.resolve(decodeCanvas(source));
        }
        return Promise.resolve([]);
      } catch {
        // NotFoundException is the normal case: this frame had no code in it.
        return Promise.resolve([]);
      }
    },
  };
}
