// Printing is handed off to RawBT (Android ESC/POS driver). We build a single
// raw ESC/POS byte stream — logo raster + text + cut — and send it through the
// `rawbt:base64,<base64>` channel, which delivers single-byte data to the
// printer without the UTF-8 mangling the text-intent path would cause.
// On desktop we fall back to a printable text preview.
import { PRINT_HEIGHT_SCALE, PRINT_WIDTH_SCALE } from "./config";
import { LOGO_ESCPOS_B64 } from "./logoRaster";
import { openPrintPreview, type PreviewAction } from "./printPreview";
import { stripMarkup } from "./receipt";

const ESC = 0x1b;
const GS = 0x1d;
// GS ! n — high nibble = width multiplier-1, low nibble = height multiplier-1.
const SIZE_BYTE = ((PRINT_WIDTH_SCALE - 1) << 4) | (PRINT_HEIGHT_SCALE - 1);

export function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

// Print mode lets the shop force the thermal (RawBT) path even when the device
// isn't auto-detected as Android (some tablets report unusual user-agents).
export type PrintMode = "auto" | "thermal" | "browser";
const PRINT_MODE_KEY = "pos.printMode";

export function getPrintMode(): PrintMode {
  const v =
    typeof localStorage !== "undefined" ? localStorage.getItem(PRINT_MODE_KEY) : null;
  return v === "thermal" || v === "browser" ? v : "auto";
}
export function setPrintMode(m: PrintMode): void {
  localStorage.setItem(PRINT_MODE_KEY, m);
}
// A touchscreen tablet (the shop's POS device) reports touch points; a
// mouse-only desktop does not. We use this so the routing works even when the
// tablet's browser reports an unexpected user-agent (e.g. Samsung DeX / desktop
// mode), where isAndroid() can be false.
function isTouchDevice(): boolean {
  return (navigator.maxTouchPoints ?? 0) > 0;
}

function useThermal(): boolean {
  const m = getPrintMode();
  if (m === "thermal") return true; // explicitly forced to RawBT
  if (m === "browser") return false; // explicitly forced to on-screen preview
  // Auto: the shop tablet (Android or any touchscreen) prints straight to RawBT
  // via the rawbt: channel, so the Android "select printer" dialog never shows.
  // Mouse-only desktops fall back to the on-screen preview.
  return isAndroid() || isTouchDevice();
}

function b64ToBytes(b64: string): number[] {
  const bin = atob(b64);
  const out: number[] = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Receipt text -> single-byte values; strip accents (é -> e) so it maps cleanly.
function textToBytes(s: string): number[] {
  const norm = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const out: number[] = [];
  for (let i = 0; i < norm.length; i++) {
    const c = norm.charCodeAt(i);
    if (c === 0x05) {
      // A barcode: the text up to the closing marker, as Code 128 set B,
      // centred, with no human-readable number beneath — the slip prints the
      // number on its own line above, and it appeared twice. Character size
      // is reset around it so the enlarged font does not stretch the bars.
      const end = norm.indexOf("\x06", i + 1);
      const data = norm.slice(i + 1, end < 0 ? norm.length : end);
      out.push(GS, 0x21, 0x00); // size normal
      out.push(ESC, 0x61, 0x01); // centre
      out.push(GS, 0x48, 0x00); // no HRI
      out.push(GS, 0x66, 0x00); // HRI font A
      out.push(GS, 0x68, 0x50); // height 80 dots
      out.push(GS, 0x77, 0x02); // module width 2
      const payload = "{B" + data;
      out.push(GS, 0x6b, 0x49, payload.length);
      for (let j = 0; j < payload.length; j++) out.push(payload.charCodeAt(j) & 0xff);
      out.push(ESC, 0x61, 0x00); // left
      out.push(GS, 0x21, SIZE_BYTE); // size back
      i = end < 0 ? norm.length : end;
    } else if (c === 0x01) {
      out.push(ESC, 0x45, 0x01); // bold marker -> emphasis on
    } else if (c === 0x02) {
      out.push(ESC, 0x45, 0x00); // bold marker -> emphasis off
    } else if (c === 0x03) {
      out.push(ESC, 0x2d, 0x01); // underline marker -> underline on
    } else if (c === 0x04) {
      out.push(ESC, 0x2d, 0x00); // underline marker -> underline off
    } else {
      out.push(c < 256 ? c : 63); // '?' for anything unexpected
    }
  }
  return out;
}

function bytesToB64(bytes: number[]): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.slice(i, i + CH));
  }
  return btoa(bin);
}

export function buildEscPos(text: string): number[] {
  const b: number[] = [];
  b.push(ESC, 0x40); // initialise
  b.push(ESC, 0x4d, 0x00); // Font A (predictable sizing)
  b.push(...b64ToBytes(LOGO_ESCPOS_B64)); // centered logo + line feed
  b.push(GS, 0x21, SIZE_BYTE); // character size (no bold — keeps it from going too dark)
  b.push(...textToBytes(text));
  b.push(GS, 0x21, 0x00); // size normal
  b.push(0x0a, 0x0a, 0x0a, 0x0a); // feed
  b.push(GS, 0x56, 0x00); // full cut
  return b;
}

export function printReceipt(text: string, title = "Receipt", action?: PreviewAction): void {
  if (useThermal()) {
    // Straight to paper; there is no popup to put the action on. The till
    // offers it in the banner instead, which is where the cashier looks next.
    window.location.href = "rawbt:base64," + bytesToB64(buildEscPos(text));
    return;
  }

  // Browser fallback: show an in-app popup preview (logo + monospace text).
  openPrintPreview(text, title, action);
}

// Save a slip as a .txt file (and offer the native share sheet on mobile when
// available, so it can go to WhatsApp, Drive, etc.).
export async function saveSlip(text: string, filenameBase: string): Promise<void> {
  const filename = `${filenameBase}.txt`;
  const file = new File([stripMarkup(text)], filename, { type: "text/plain" });

  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[]; title?: string }) => Promise<void>;
  };
  if (nav.canShare && nav.canShare({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title: filename });
      return;
    } catch {
      // fall through to download
    }
  }

  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Back-compat helper for saved receipts keyed by sale id.
export async function saveReceipt(text: string, saleId: string): Promise<void> {
  return saveSlip(text, `receipt-${saleId.slice(0, 8)}`);
}
